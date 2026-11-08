import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { openStore, type Store } from '../server/store';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { readConfig } from '../server/config';
import { openAccountStore } from '../server/account-store';
import { createHttpServer } from '../server/http';
const homes: string[] = [], servers: Server[] = [], stores: Store[] = [], managers: SessionManager[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const m of managers.splice(0)) await m.close();
  for (const s of stores.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mandala-setup-')); homes.push(home);
  const store = openStore(home); stores.push(store);
  const manager = createSessionManager(store, async () => (await readConfig(home)).config); managers.push(manager);
  const token = 'synthetic-first-run-token';
  const server = createHttpServer({ home, store, manager, setupToken: token }); servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `mandala_setup=${token}`, 'X-Setup-Token': token };
  const submit = (extra = {}, password = 'synthetic-owner-password') => fetch(origin + '/auth/setup', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ username: 'owner', password }) });
  return { home, store, token, origin, headers, submit };
}
it('discloses first-use setup only to the launcher cookie and rejects forged or relayed bootstrap', async () => {
  const f = await setup();
  expect(await fetch(f.origin + '/auth/session').then(r => r.json())).toMatchObject({ setup: { available: false } });
  expect(await fetch(f.origin + '/auth/session', { headers: { Cookie: f.headers.Cookie } }).then(r => r.json())).toMatchObject({ setup: { available: true, token: f.token } });
  expect((await f.submit({ Cookie: '' })).status).toBe(403);
  expect((await f.submit({ 'X-Setup-Token': 'forged' })).status).toBe(403);
  expect((await f.submit({ Origin: 'https://foreign.example' })).status).toBe(403);
  expect((await f.submit({ 'X-OpenMana-Bridge-Key': 'forged' })).status).toBe(403);
  expect(openAccountStore(f.home).listUsers()).toHaveLength(0);
});
it('creates exactly one owner, binds legacy data, and establishes an HttpOnly session', async () => {
  const f = await setup();
  const chat = f.store.createConversation({ projectId: '', agentId: '', cli: 'codex', model: null });
  f.store.appendEvent(chat.id, 'user', { text: 'Retained history' });
  const results = await Promise.all([f.submit(), f.submit()]);
  expect(results.map(r => r.status).sort()).toEqual([201, 409]);
  const created = results.find(r => r.status === 201)!;
  const sessionCookie = created.headers.getSetCookie().find(c => c.startsWith('openmana_local_session='))!;
  expect(sessionCookie).toContain('HttpOnly');
  const currentCookie = created.headers.getSetCookie().find(c => c.startsWith('mandala_local_session='))!;
  expect(currentCookie.split(';')[0].split('=')[1]).toBe(sessionCookie.split(';')[0].split('=')[1]);
  expect(currentCookie).toContain('HttpOnly');
  expect(created.headers.getSetCookie()).toContain('mandala_setup=; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=0');
  const data = await created.json();
  expect(f.store.ownerUserId).toBe(data.user.id);
  expect(openAccountStore(f.home).listUsers()).toHaveLength(1);
  expect(readFileSync(join(f.home, 'accounts.json'), 'utf8')).not.toContain('synthetic-owner-password');
  const cookie = sessionCookie.split(';')[0];
  expect((await fetch(f.origin + '/api/config', { headers: { Cookie: cookie } })).status).toBe(200);
  expect(await fetch(f.origin + '/api/status', { headers: { Cookie: cookie } }).then(r => r.json())).toMatchObject({ runtime: { nodeVersion: process.versions.node, nodeSupported: true, minimumNodeVersion: '22.23.2' } });
  expect((await f.submit()).status).toBe(409);
  expect(await fetch(f.origin + '/auth/session', { headers: { Cookie: f.headers.Cookie } }).then(r => r.json())).toMatchObject({ setup: { available: false } });
});
it('rejects invalid account input without consuming the first-run capability', async () => {
  const f = await setup();
  expect((await f.submit({}, 'short')).status).toBe(422);
  expect(openAccountStore(f.home).listUsers()).toHaveLength(0);
  expect((await f.submit()).status).toBe(201);
});
