import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ownedPrivatePath } from '../cli/private-path.mjs';

// Local launcher credentials never enter the renderer or an unauthenticated HTTP response.
export type ServiceRecord = { pid: number; origin: string; secret: string; setupToken: string };
export const runtimeRecordPath = (home: string) => join(home, '.desktop-runtime.json');
export function readServiceRecord(home: string): ServiceRecord | undefined {
  const path = runtimeRecordPath(home);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || !ownedPrivatePath(path, stat, 4096)) {
    // The runtime can unlink its record while the Windows ACL check is running.
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    throw new Error('Desktop runtime discovery file is not private.');
  }
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false })) return;
    throw error;
  }
  const value = JSON.parse(contents) as ServiceRecord;
  if (!Number.isInteger(value.pid) || value.pid < 1 || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.origin) || Number(new URL(value.origin).port) > 65535 || !/^[a-f0-9]{64}$/.test(value.secret) || !/^[a-zA-Z0-9_-]{43}$/.test(value.setupToken)) throw new Error('Invalid desktop runtime discovery file.');
  return value;
}
export function serviceAlive(record: ServiceRecord): boolean {
  try { process.kill(record.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export function removeServiceRecord(home: string, record: ServiceRecord): void {
  if (readServiceRecord(home)?.secret === record.secret) unlinkSync(runtimeRecordPath(home));
}
export function claimServiceRecord(home: string, origin: string, setupToken: string): ServiceRecord {
  const previous = readServiceRecord(home);
  if (previous) {
    if (serviceAlive(previous)) throw new Error('Another desktop runtime is using this data directory.');
    removeServiceRecord(home, previous);
  }
  const record = { pid: process.pid, origin, secret: randomBytes(32).toString('hex'), setupToken };
  // Exclusive creation also arbitrates two launchers before either opens the Store.
  writeFileSync(runtimeRecordPath(home), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}
export const serviceProof = (record: ServiceRecord, value: string) => createHmac('sha256', record.secret).update(value).digest('hex');
function matches(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export type RuntimeBuild = { version: string; commit: string };
function parseRuntimeBuild(value: unknown): RuntimeBuild | undefined {
  if (!value || typeof value !== 'object') return;
  const { version, commit } = value as Partial<RuntimeBuild>;
  if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) &&
      typeof commit === 'string' && /^(?:[a-f0-9]{40,64}|uncommitted)$/.test(commit)) return { version, commit };
}
export function readRuntimeBuild(runtime: string): RuntimeBuild | undefined {
  try { return parseRuntimeBuild(JSON.parse(readFileSync(join(runtime, 'build.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export type IdleStop = 'accepted' | 'busy' | 'unknown';
type ServiceControl = { build?: RuntimeBuild; stopIfIdle?: () => IdleStop | Promise<IdleStop> };
type ServiceReply = { build?: RuntimeBuild; canStopIfIdle?: boolean; idleStop?: IdleStop };
type ServiceAction = 'probe' | 'stop' | 'stop-if-idle';
const methods = { probe: 'GET', stop: 'POST', 'stop-if-idle': 'PUT' } as const;
export const serviceControlPath = '/__mandala_runtime';
export function handleServiceControl(record: ServiceRecord, req: IncomingMessage, res: ServerResponse, stop: () => void, control?: ServiceControl): boolean {
  if (req.url !== serviceControlPath) return false;
  const action = req.method === 'GET' ? 'probe' : req.method === 'POST' ? 'stop' : req.method === 'PUT' ? 'stop-if-idle' : '';
  const nonce = String(req.headers['x-mandala-nonce'] ?? '');
  const proof = String(req.headers['x-mandala-proof'] ?? '');
  const timestamp = Number(nonce.split(':')[0]);
  if (!action || req.headers.origin || req.headers.host !== new URL(record.origin).host || !/^\d{13}:[a-f0-9]{64}$/.test(nonce) || Math.abs(Date.now() - timestamp) > 30000 || !matches(proof, serviceProof(record, `${action}:${nonce}`))) {
    res.writeHead(403); res.end(); return true;
  }
  const reply = (metadata?: ServiceReply) => {
    const signature = `reply:${action}:${nonce}`;
    const headers: Record<string, string> = { 'x-mandala-proof': serviceProof(record, signature), 'Cache-Control': 'no-store' };
    if (metadata) {
      const payload = Buffer.from(JSON.stringify(metadata)).toString('base64url');
      headers['x-mandala-runtime'] = payload;
      headers['x-mandala-runtime-proof'] = serviceProof(record, `${signature}:${payload}`);
    }
    res.writeHead(200, headers); res.end();
  };
  if (action === 'stop-if-idle') {
    void Promise.resolve().then(() => control?.stopIfIdle?.() ?? 'unknown').catch(() => 'unknown' as const).then(result => {
      try { reply({ idleStop: result }); }
      finally { if (result === 'accepted') stop(); }
    }).catch(() => res.destroy());
  } else {
    reply(action === 'probe' && control ? { build: control.build, canStopIfIdle: !!control.stopIfIdle } : undefined);
    if (action === 'stop') setImmediate(stop);
  }
  return true;
}
export class ServiceStartingError extends Error {}
export async function controlService(record: ServiceRecord, action: ServiceAction): Promise<ServiceReply> {
  const nonce = `${Date.now()}:${randomBytes(32).toString('hex')}`;
  const response = await fetch(record.origin + serviceControlPath, { method: methods[action], redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'x-mandala-nonce': nonce, 'x-mandala-proof': serviceProof(record, `${action}:${nonce}`) } });
  await response.body?.cancel();
  if (response.status === 503) throw new ServiceStartingError('The background runtime is still starting.');
  const signature = `reply:${action}:${nonce}`;
  const verify = (header: string, message: string) => matches(response.headers.get(header) ?? '', serviceProof(record, message));
  const verificationError = () => new Error('Could not verify the existing desktop runtime. No service was taken over.');
  if (!response.ok || !verify('x-mandala-proof', signature)) throw verificationError();
  const payload = response.headers.get('x-mandala-runtime');
  if (payload === null) return {};
  if (!verify('x-mandala-runtime-proof', `${signature}:${payload}`)) throw verificationError();
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ServiceReply;
  return { build: parseRuntimeBuild(value.build), canStopIfIdle: value.canStopIfIdle === true, idleStop: value.idleStop };
}
