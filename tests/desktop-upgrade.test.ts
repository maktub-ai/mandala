import { afterEach, expect, test } from 'vitest';
import { buildSync } from 'esbuild';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectOrStartService, connectService, prepareDesktopHome, stopBackgroundService } from '../desktop/runtime';
import { createDesktopGateway } from '../server/desktop-gateway';
import { openStore } from '../server/store';
import { openDesktopAccounts } from '../server/desktop-accounts';
import { claimServiceRecord, handleServiceControl, readServiceRecord, removeServiceRecord } from '../desktop/service-discovery';

const oldBuild = { version: '1.0.1', commit: 'a'.repeat(40) };
const newBuild = { version: '1.0.1', commit: 'b'.repeat(40) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(join(process.cwd(), '.upgrade-runtime-'));
  roots.push(cwd);
  const data = mkdtempSync(join(tmpdir(), 'mandala-upgrade-'));
  roots.push(data);
  const home = join(data, 'account-gateway');
  prepareDesktopHome(home);
  const entry = join(cwd, 'server', 'account-desktop-main.mjs');
  mkdirSync(join(cwd, 'server'));
  buildSync({ entryPoints: ['server/account-desktop-main.ts'], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  writeFileSync(join(cwd, 'server', 'main.mjs'), `import ${JSON.stringify(pathToFileURL(resolve('server/main.ts')).href)};`);
  const writeBuild = (build: typeof oldBuild) => writeFileSync(join(cwd, 'build.json'), JSON.stringify(build));
  writeBuild(oldBuild);
  return { writeBuild, options: { home, node: process.execPath, entry, cwd, env: {
    ...process.env, NODE_OPTIONS: '--import tsx', MANDALA_HOME: data, OPEN_MANA_HOME: data,
    MANDALA_ACCOUNT_ORIGIN: 'http://127.0.0.1:9', MANDALA_DESKTOP: '1', MANDALA_DESKTOP_PERSIST: '1',
  } } };
}

test('reopening reuses an identical build, then replaces the idle gateway after an in-place rebuild', async () => {
  const { options, writeBuild } = fixture();
  try {
    const first = await connectOrStartService({ ...options, build: oldBuild });
    expect((await connectOrStartService({ ...options, build: oldBuild })).record.pid).toBe(first.record.pid);

    writeBuild(newBuild);
    const replacement = await connectOrStartService({ ...options, build: newBuild });
    expect(replacement.record.pid).not.toBe(first.record.pid);
    expect(replacement.build).toEqual(newBuild);
    expect(await fetch(first.origin).catch(() => null)).toBeNull();
  } finally {
    const running = await connectService(options.home);
    if (running) await stopBackgroundService(running);
  }
}, 20000);

test('an unversioned gateway requires confirmation and a shutdown timeout keeps its identity for retry', async () => {
  const { options, writeBuild } = fixture();
  writeBuild(newBuild);
  let stopped = 0;
  let record: ReturnType<typeof claimServiceRecord>;
  const server = createServer((req, res) => {
    handleServiceControl(record, req, res, () => {
      stopped++;
      if (stopped === 2) removeServiceRecord(options.home, record);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  record = claimServiceRecord(options.home, origin, 'a'.repeat(43));
  try {
    const pending = await connectOrStartService({ ...options, build: newBuild, confirmLegacy: async () => false });
    expect(pending.upgradePending).toBe('confirmation');
    expect(stopped).toBe(0);

    await expect(connectOrStartService({ ...options, build: newBuild, confirmLegacy: async () => true, shutdownTimeoutMs: 30 })).rejects.toThrow(/still shutting down/);
    expect(stopped).toBe(1);
    expect(readServiceRecord(options.home)?.secret).toBe(record.secret);

    const replacement = await connectOrStartService({ ...options, build: newBuild, confirmLegacy: async () => true });
    expect(replacement.build).toEqual(newBuild);
    expect(replacement.record.pid).not.toBe(record.pid);
    await stopBackgroundService(replacement);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an active terminal defers the upgrade until it exits', async () => {
  const { options, writeBuild } = fixture();
  const accounts = openDesktopAccounts(dirname(options.home), options.env.MANDALA_ACCOUNT_ORIGIN);
  const lease = accounts.activate({
    user: { id: 'test', username: 'test', createdAt: new Date().toISOString() },
    token: 'test', csrfToken: 'test', expiresAt: Date.now() + 120000,
  }, false);
  const profile = accounts.home(lease.user.id);
  prepareDesktopHome(profile);
  const store = openStore(profile);
  const { id } = store.createConversation({ projectId: '', agentId: '', cwd: profile, cli: 'codex', model: null });
  store.close();
  try {
    const first = await connectOrStartService({ ...options, build: oldBuild });
    const headers = { Origin: first.origin, Cookie: 'mandala_desktop=' + lease.localToken, 'Content-Type': 'application/json' };
    const call = (path: string, method = 'GET', body?: unknown) => fetch(first.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const path = '/api/conversations/' + id + '/terminal';
    const started = await call(path, 'POST', { cols: 80, rows: 24 });
    expect(started.status, await started.clone().text()).toBe(201);
    const { session } = await started.json();

    writeBuild(newBuild);
    const pending = await connectOrStartService({ ...options, build: newBuild });
    expect(pending.upgradePending).toBe('busy');
    expect(pending.upgradePendingReason).toBeUndefined();
    expect(pending.record.pid).toBe(first.record.pid);
    expect((await (await call(path)).json()).session).toMatchObject({ id: session.id, state: 'running' });

    const stopped = await call(path, 'DELETE', { sessionId: session.id });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    // node-pty drains Windows ConPTY output for 1s before publishing the exit event.
    await expect.poll(async () => (await (await call(path)).json()).session.state, { timeout: 5000 }).toBe('exited');
    await expect.poll(async () => (await connectOrStartService({ ...options, build: newBuild })).build, { timeout: 10000 }).toEqual(newBuild);
  } finally {
    const running = await connectService(options.home);
    if (running) await stopBackgroundService(running);
  }
}, 30000);

test('historical unresolved input defers upgrade without claiming active work or offering forced stop', async () => {
  const { options, writeBuild } = fixture();
  const accounts = openDesktopAccounts(dirname(options.home), options.env.MANDALA_ACCOUNT_ORIGIN);
  const lease = accounts.activate({
    user: { id: 'test', username: 'test', createdAt: new Date().toISOString() },
    token: 'test', csrfToken: 'test', expiresAt: Date.now() + 120000,
  }, false);
  const profile = accounts.home(lease.user.id);
  prepareDesktopHome(profile);
  const initial = openStore(profile);
  const { id } = initial.createConversation({ projectId: '', agentId: '', cwd: profile, cli: 'codex', model: null });
  initial.close();
  try {
    const first = await connectOrStartService({ ...options, build: oldBuild });
    const session = await fetch(first.origin + '/auth/session', { headers: { Cookie: 'mandala_desktop=' + lease.localToken } });
    expect(session.status).toBe(200);
    expect((await session.json()).user.username).toBe('test');
    const state = openStore(profile);
    try {
      state.database.prepare("INSERT INTO task_user_inputs(id,owner_user_id,conversation_id,text,command_key,state,created_at) VALUES(?,?,?,?,?,'unknown',?)")
        .run('synthetic-history',state.ownerUserId,id,'Unresolved historical input','synthetic-history-key','2020-01-01T00:00:00.000Z');
      const before = state.database.prepare("SELECT * FROM task_user_inputs").all();
      writeBuild(newBuild);
      let forced = 0;
      const pending = await connectOrStartService({ ...options, build: newBuild, confirmLegacy: async () => { forced++; return true; } });
      expect(pending.upgradePending).toBe('busy');
      expect(pending.upgradePendingReason).toBe('unresolved-native');
      expect(pending.record.pid).toBe(first.record.pid);
      expect(forced).toBe(0);
      expect(state.database.prepare("SELECT * FROM task_user_inputs").all()).toEqual(before);
      const terminalPath = '/api/conversations/' + id + '/terminal';
      const headers = { Origin: first.origin, Cookie: 'mandala_desktop=' + lease.localToken, 'Content-Type': 'application/json' };
      const terminal = await fetch(first.origin + terminalPath, { method: 'POST', headers, body: JSON.stringify({ cols: 80, rows: 24 }) });
      expect(terminal.status).toBe(201);
      const { session: shell } = await terminal.json();
      try {
        const activelyBusy = await connectOrStartService({ ...options, build: newBuild, confirmLegacy: async () => { forced++; return true; } });
        expect(activelyBusy.upgradePending).toBe('busy');
        expect(activelyBusy.upgradePendingReason).toBeUndefined();
        expect(activelyBusy.record.pid).toBe(first.record.pid);
        expect(forced).toBe(0);
        expect((await (await fetch(first.origin + terminalPath, { headers })).json()).session)
          .toMatchObject({ id: shell.id, state: 'running' });
        expect(state.database.prepare("SELECT * FROM task_user_inputs").all()).toEqual(before);
      } finally {
        await fetch(first.origin + terminalPath, { method: 'DELETE', headers, body: JSON.stringify({ sessionId: shell.id }) });
      }

    } finally { state.close(); }
  } finally {
    const running = await connectService(options.home);
    if (running) await stopBackgroundService(running); // only the synthetic fixture
  }
}, 20000);

test('the gateway refuses new work while the workspace is deciding whether to stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mandala-upgrade-admission-'));
  roots.push(root);
  const controlOrigin = 'http://127.0.0.1:9';
  const lease = openDesktopAccounts(root, controlOrigin).activate({
    user: { id: 'test', username: 'test', createdAt: new Date().toISOString() },
    token: 'test', csrfToken: 'test', expiresAt: Date.now() + 120000,
  }, false);
  let writes = 0;
  const worker = createServer((req, res) => {
    if (req.method === 'POST') writes++;
    res.end('{}');
  });
  worker.listen(0, '127.0.0.1');
  await once(worker, 'listening');
  let release!: (value: 'busy' | 'accepted') => void;
  let entered!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const gateway = createDesktopGateway({
    root, controlOrigin, setupToken: 'test',
    async startWorkspace() {
      return {
        origin: `http://127.0.0.1:${(worker.address() as { port: number }).port}`,
        cookie: 'internal', csrfToken: 'internal', key: 'internal', close: async () => {},
        stopIfIdle() { entered(); return new Promise(resolve => { release = resolve; }); },
      };
    },
  });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const call = (method: string) => fetch(origin + '/api/tasks', {
    method, headers: { Origin: origin, Cookie: 'mandala_desktop=' + lease.localToken },
  });
  try {
    expect((await call('GET')).status).toBe(200);
    const stop = gateway.reserveIdleShutdown();
    await checking;
    expect((await call('POST')).status).toBe(503);
    expect(writes).toBe(0);
    release('busy');
    expect(await stop).toBe('busy');
    expect((await call('POST')).status).toBe(200);
    expect(writes).toBe(1);
  } finally {
    release?.('busy');
    await gateway.close();
    worker.closeAllConnections();
    await new Promise<void>(resolve => worker.close(() => resolve()));
  }
});
