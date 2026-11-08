import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type AccountUser = { id: string; username: string; createdAt: string; email?: string; displayName?: string; lastLoginAt?: string; avatarUrl?: string };
export type ComputerDevice = { id: string; name: string; ownerId: string; createdAt: string };
export type DeviceAccess = { clientId: string; status: 'pending' | 'approved' | 'denied' | 'revoked'; requestedAt: string; publicKey?: string };
type Data = {
  users: (AccountUser & { salt?: string; passwordHash?: string; identity?: {provider: string; subject: string} })[];
  sessions: { tokenHash: string; userId: string; csrfToken: string; expiresAt: number }[];
  devices: (ComputerDevice & { credentialHash: string; access: DeviceAccess[] })[];
};
/** Persists account and device control metadata only. Relay payloads never enter this store. */
export function openAccountStore(home: string, options: { sessionDurationMs?: number } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'accounts.json');
  const read = (): Data => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { users: [], sessions: [], devices: [] };
  const save = (data: Data) => { writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 }); renameSync(file + '.tmp', file); };
  const publicUser = ({ id, username, createdAt, email, displayName, lastLoginAt }: AccountUser): AccountUser => ({ id, username, createdAt, email, displayName, lastLoginAt });
  const publicDevice = ({ id, name, ownerId, createdAt }: ComputerDevice): ComputerDevice => ({ id, name, ownerId, createdAt });
  return {
    close() {},
    listUsers: () => read().users.map(publicUser),
    statistics() { const data=read(); return {registeredUsers:data.users.length, linkedDevices:data.devices.length}; },
    identityUser(provider: 'google'|'github'|'email', subject: string, email?: string, displayName?: string) {
      if (!subject || subject.length>320) throw new Error('Invalid identity');
      const data=read();
      let user=data.users.find(u=>u.identity?.provider===provider&&u.identity.subject===subject);
      if (!user) {
        user={id:randomUUID(),username:email??`${provider}:${subject}`,createdAt:new Date().toISOString(),identity:{provider,subject},email,displayName};
        data.users.push(user);
      } else { user.email=email; user.displayName=displayName; }
      save(data); return publicUser(user);
    },
    importUser(user: AccountUser) {
      const data=read(), existing=data.users.find(u=>u.id===user.id);
      if (existing) Object.assign(existing,publicUser(user)); else data.users.push(publicUser(user));
      save(data);
    },
    async createUser(username: string, password: string) {
      if (!/^[a-zA-Z0-9_.@-]{1,128}$/.test(username) || password.length < 12 || password.length > 1024) throw new Error('Username must be 1–128 safe characters and password 12–1024 characters');
      const salt = randomBytes(16).toString('hex'), passwordHash = (await derive(password, salt, 64) as Buffer).toString('hex');
      const data = read();
      if (data.users.some(u => u.username === username)) throw new Error('Account already exists');
      const user = { id: randomUUID(), username, createdAt: new Date().toISOString(), salt, passwordHash };
      data.users.push(user); save(data); return publicUser(user);
    },
    async authenticate(username: string, password: string) {
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
      const user = read().users.find(u => u.username === username);
      // Unknown accounts do the same password work to avoid a timing account directory.
      const actual = await derive(password, user?.salt ?? '0'.repeat(32), 64) as Buffer;
      const expected = Buffer.from(user?.passwordHash ?? '0'.repeat(128), 'hex');
      return timingSafeEqual(actual, expected) && user ? publicUser(user) : null;
    },
    createSession(userId: string) {
      const data = read(), user=data.users.find(u=>u.id===userId); if (!user) throw new Error('Unknown account');
      user.lastLoginAt=new Date().toISOString();
      const token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(24).toString('base64url');
      const expiresAt = Date.now() + (options.sessionDurationMs ?? 7 * 24 * 60 * 60 * 1000);
      data.sessions = data.sessions.filter(s => s.expiresAt > Date.now());
      const own = data.sessions.filter(s => s.userId === userId);
      if (own.length >= 32) { const discard = new Set(own.slice(0, own.length - 31).map(s => s.tokenHash)); data.sessions = data.sessions.filter(s => !discard.has(s.tokenHash)); }
      data.sessions.push({ tokenHash: digest(token), userId, csrfToken, expiresAt }); save(data);
      return { token, csrfToken, expiresAt };
    },
    session(token: string) {
      const data = read(), session = data.sessions.find(s => s.tokenHash === digest(token) && s.expiresAt > Date.now());
      const user = session && data.users.find(u => u.id === session.userId);
      return session && user ? { user: publicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt } : null;
    },
    deleteSession(token: string) { const data = read(); data.sessions = data.sessions.filter(s => s.tokenHash !== digest(token)); save(data); },
    enroll(ownerId: string, name: string) {
      if (!name.trim() || name.length > 128) throw new Error('Invalid computer name');
      const data = read(); if (!data.users.some(u => u.id === ownerId)) throw new Error('Unknown account');
      if (data.devices.filter(d => d.ownerId === ownerId).length >= 32) throw new Error('Too many enrolled computers');
      const credential = randomBytes(32).toString('base64url');
      const device = { id: randomUUID(), name: name.trim(), ownerId, createdAt: new Date().toISOString(), credentialHash: digest(credential), access: [] };
      data.devices.push(device); save(data); return { device: publicDevice(device), credential };
    },
    device(id: string) { const d = read().devices.find(d => d.id === id); return d ? publicDevice(d) : null; },
    revokeDevice(id: string) { const data = read(); data.devices = data.devices.filter(d => d.id !== id); save(data); },
    devices(ownerId: string) { return read().devices.filter(d => d.ownerId === ownerId).map(publicDevice); },
    credential(token: string) { const d = read().devices.find(d => d.credentialHash === digest(token)); return d ? publicDevice(d) : null; },
    access(deviceId: string) { return read().devices.find(d => d.id === deviceId)?.access ?? []; },
    setAccess(deviceId: string, clientId: string, status: DeviceAccess['status'], publicKey?: string) {
      const data = read(), device = data.devices.find(d => d.id === deviceId); if (!device) throw new Error('Unknown computer');
      let grant = device.access.find(a => a.clientId === clientId);
      if (grant) { grant.status = status; if (publicKey !== undefined) grant.publicKey = publicKey; } else { if (device.access.length >= 1000) throw new Error('Too many browser authorizations'); grant = { clientId, status, publicKey, requestedAt: new Date().toISOString() }; device.access.push(grant); }
      save(data); return grant;
    },
  };
}
export type AccountStore = ReturnType<typeof openAccountStore>;
