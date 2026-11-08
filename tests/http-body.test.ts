import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHttpServer } from '../server/http';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createSessionManager } from '../server/sessions';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function closeServer(server: Server) {
  if (!server.listening) { server.emit('close'); return; }
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'json-body-'));
  cleanups.push(async () => rmSync(home, { recursive: true, force: true }));
  const store = openStore(home), manager = createSessionManager(store, async () => (await readConfig(home)).config, undefined, undefined, home);
  const chat = store.createConversation({ projectId: '', agentId: '', cli: 'codex', model: null });
  const server = createHttpServer({ home, store, manager, requireIdentity: false });
  cleanups.push(async () => { await closeServer(server); await manager.close(); store.close(); });
  return { server, method: 'PATCH', path: '/api/conversations/' + chat.id, value: { title: '中文🙂标题' }, success: 200, store, chat };
}
async function invoke(server: Server, method: string, path: string, chunks: Buffer[], contentType = 'application/json') {
  // Async source keeps each byte boundary observable without relying on TCP packet timing.
  const req = Readable.from((async function* () { for (const chunk of chunks) { yield chunk; await new Promise<void>(resolve => setImmediate(resolve)); } })(), { objectMode: false }) as IncomingMessage;
  Object.assign(req, { headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': contentType }, method, url: path, socket: { remoteAddress: '127.0.0.1' } });
  let status = 0, value: any, destroyedAtResponse = false;
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    setHeader() {},
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { value = JSON.parse(text); destroyedAtResponse = req.destroyed; },
  });
  const handler = server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  await handler(req, res as unknown as ServerResponse);
  return { status, value, destroyedAtResponse };
}
for (const kind of ['local'] as const) {
  const max = kind === 'local' ? 262144 : 8192;
  test(`${kind} JSON route preserves Chinese and emoji split across byte chunks`, async () => {
    const f = await fixture();
    const bytes = Buffer.from(JSON.stringify(f.value));
    const chunks = Array.from(bytes, byte => Buffer.from([byte]));
    const response = await invoke(f.server, f.method, f.path, chunks);
    expect(response.status).toBe(200);
    if (f.store) expect(f.store.getConversation(f.chat!.id)?.title).toBe('中文🙂标题');
  });
  test(`${kind} JSON route accepts the exact byte limit and rejects one extra byte without destroying the response socket`, async () => {
    const f = await fixture(), prefix = JSON.stringify({ ...f.value, padding: '' });
    const exact = Buffer.from(prefix.slice(0, -2) + 'x'.repeat(max - Buffer.byteLength(prefix)) + '"}');
    expect(exact.length).toBe(max);
    expect((await invoke(f.server, f.method, f.path, [exact])).status).toBe(f.success);
    const over = await invoke(f.server, f.method, f.path, [exact, Buffer.from(' ')]);
    expect(over.status).toBe(400);
    expect(over.destroyedAtResponse).toBe(false);
    expect(over.value.error).toBe(kind === 'local' ? 'invalid request size' : 'Invalid request');
  });
  test(`${kind} HTTP connection receives a useful oversized-body error`, async () => {
    const f = await fixture();
    f.server.listen(0, '127.0.0.1');
    await once(f.server, 'listening');
    const port = (f.server.address() as { port: number }).port;
    const response = await new Promise<{ status: number; value: any }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: f.path, method: f.method,
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.end(' '.repeat(max + 1));
    });
    expect(response.status).toBe(400);
    expect(response.value.error).toBe(kind === 'local' ? 'invalid request size' : 'Invalid request');
  });
  test(`${kind} JSON route retains malformed JSON, empty-body and content-type contracts`, async () => {
    const f = await fixture();
    const invalid = await invoke(f.server, f.method, f.path, [Buffer.from('{')]);
    expect(invalid.status).toBe(400);
    expect(invalid.value.error).toBe(kind === 'local' ? 'invalid JSON' : 'Invalid request');
    expect((await invoke(f.server, f.method, f.path, [])).status).toBe(kind === 'local' ? 400 : 401);
    expect((await invoke(f.server, f.method, f.path, [Buffer.from('{}')], 'text/plain')).status).toBe(400);
  });
}
