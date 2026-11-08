import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { claimServiceRecord, controlService, handleServiceControl, readServiceRecord, runtimeRecordPath } from '../desktop/service-discovery';
import { connectService, connectOrStartService, prepareDesktopHome, stopBackgroundService } from '../desktop/runtime';
import { ownedPrivatePath } from '../cli/private-path.mjs';

vi.mock('../cli/private-path.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../cli/private-path.mjs')>();
  return { ...actual, ownedPrivatePath: vi.fn(actual.ownedPrivatePath) };
});
const roots: string[] = [];
const home = () => {
  const parent = mkdtempSync(join(tmpdir(), 'mandala-discovery-')); roots.push(parent);
  const root = join(parent, 'data'); prepareDesktopHome(root); return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('refuses forged HTTP identity and leaves the foreign server untouched', async () => {
  const root = home(); const foreign = createServer((_req, res) => res.end('ready'));
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  const origin = `http://127.0.0.1:${(foreign.address() as { port: number }).port}`;
  claimServiceRecord(root, origin, 'a'.repeat(43));
  try {
    await expect(connectService(root)).rejects.toThrow(/verify/);
    expect(await (await fetch(origin)).text()).toBe('ready');
    expect(readServiceRecord(root)?.pid).toBe(process.pid);
  } finally { foreign.closeAllConnections(); await new Promise<void>(resolve => foreign.close(() => resolve())); }
});
test('rejects anonymous and browser control calls; authenticated probes do not stop work', async () => {
  const root = home(); let stopped = 0;
  let record: ReturnType<typeof claimServiceRecord>;
  const server = createServer((req, res) => { handleServiceControl(record, req, res, () => stopped++); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  record = claimServiceRecord(root, origin, 'a'.repeat(43));
  try {
    expect((await fetch(origin + '/__mandala_runtime', { method: 'POST' })).status).toBe(403);
    expect((await fetch(origin + '/__mandala_runtime', { method: 'POST', headers: { Origin: origin } })).status).toBe(403);
    await controlService(record, 'probe'); expect(stopped).toBe(0);
    await controlService(record, 'stop'); await new Promise(r => setImmediate(r)); expect(stopped).toBe(1);
    expect(() => claimServiceRecord(root, origin, 'b'.repeat(43))).toThrow(/Another desktop runtime/);
    expect(readServiceRecord(root)?.secret).toBe(record.secret);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test.skipIf(process.platform === 'win32')('rejects non-private or symlinked discovery credentials', () => {
  const root = home(); claimServiceRecord(root, 'http://127.0.0.1:12345', 'a'.repeat(43));
  chmodSync(runtimeRecordPath(root), 0o644);
  expect(() => readServiceRecord(root)).toThrow(/not private/);
  rmSync(runtimeRecordPath(root));
  const target = join(root, 'target'); writeFileSync(target, '{}', { mode: 0o600 });
  symlinkSync(target, runtimeRecordPath(root));
  expect(() => readServiceRecord(root)).toThrow(/not private/);
});

test('finishes authenticated shutdown when the record disappears during its privacy check', async () => {
  const root = home();
  let record: ReturnType<typeof claimServiceRecord>;
  const server = createServer((req, res) => { handleServiceControl(record, req, res, () => {}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  record = claimServiceRecord(root, origin, 'a'.repeat(43));
  try {
    // Windows ACL probing reports false if the runtime unlinks the file mid-check.
    vi.mocked(ownedPrivatePath).mockImplementationOnce(path => { rmSync(path); return false; });
    await expect(stopBackgroundService({ home: root, origin, record, setupToken: record.setupToken })).resolves.toBeUndefined();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('treats removal between the privacy check and the read as an absent record', () => {
  const root = home();
  claimServiceRecord(root, 'http://127.0.0.1:12345', 'a'.repeat(43));
  vi.mocked(ownedPrivatePath).mockImplementationOnce(path => { rmSync(path); return true; });
  expect(readServiceRecord(root)).toBeUndefined();
});

test('still rejects a discovery record that exists and fails its privacy check', () => {
  const root = home();
  claimServiceRecord(root, 'http://127.0.0.1:12345', 'a'.repeat(43));
  vi.mocked(ownedPrivatePath).mockReturnValueOnce(false);
  expect(() => readServiceRecord(root)).toThrow(/not private/);
});

test('does not report an absent record when a replacement link cannot be read', () => {
  const root = home();
  claimServiceRecord(root, 'http://127.0.0.1:12345', 'a'.repeat(43));
  vi.mocked(ownedPrivatePath).mockImplementationOnce(path => {
    rmSync(path);
    symlinkSync(join(root, 'missing'), path, 'junction');
    return true;
  });
  expect(() => readServiceRecord(root)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

test('reopening during runtime initialization waits for verified readiness without spawning', async () => {
  const root = home(); let ready = false;
  let record: ReturnType<typeof claimServiceRecord>;
  const server = createServer((req, res) => {
    if (!ready) { res.writeHead(503); res.end('Starting'); return; }
    handleServiceControl(record, req, res, () => {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  record = claimServiceRecord(root, origin, 'a'.repeat(43));
  try {
    const timer = setTimeout(() => { ready = true; }, 150);
    const service = await connectOrStartService({ home: root, node: 'must-not-spawn', entry: '', cwd: root, env: {}, timeoutMs: 2000 });
    clearTimeout(timer);
    expect(service.origin).toBe(origin); expect(service.record.pid).toBe(process.pid);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('reopening tolerates a busy runtime while still requiring its signed response', async () => {
  const root = home(); let stopped = false;
  let record: ReturnType<typeof claimServiceRecord>;
  const server = createServer((req, res) => {
    setTimeout(() => handleServiceControl(record, req, res, () => { stopped = true; }), 2500);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  record = claimServiceRecord(root, origin, 'a'.repeat(43));
  try {
    const service = await connectOrStartService({ home: root, node: 'must-not-spawn', entry: '', cwd: root, env: {} });
    expect(service.origin).toBe(origin); expect(service.record.pid).toBe(process.pid);
    expect(stopped).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);
