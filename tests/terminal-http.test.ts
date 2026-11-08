import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHttpServer } from '../server/http';
import { createSessionManager } from '../server/sessions';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
let home: string, cwd: string, base: string, id: string;
let store: ReturnType<typeof openStore>, manager: ReturnType<typeof createSessionManager>, server: ReturnType<typeof createHttpServer>;
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mana-terminal-http-'))); cwd = join(home, 'work'); mkdirSync(cwd);
  await readConfig(home); store = openStore(home);
  manager = createSessionManager(store, async () => (await readConfig(home)).config, undefined, undefined, home);
  id = store.createConversation({ projectId: '', agentId: '', cwd, cli: 'codex', model: null }).id;
  server = createHttpServer({requireIdentity:false, home, store, manager }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/conversations/' + id + '/terminal';
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await manager.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
const post = (url: string, data: unknown, extra: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data) });

it('only starts explicitly and derives cwd from the conversation, rejecting arbitrary cwd and cross-site control', async () => {
  expect(await (await fetch(base)).json()).toEqual({ session: null });
  expect((await post(base, { cols: 80, rows: 24, cwd: '/etc' })).status).toBe(400);
  expect((await post(base, { cols: 80, rows: 24 }, { Origin: 'https://evil.example' })).status).toBe(403);
  const response = await post(base, { cols: 80, rows: 24 }); expect(response.status).toBe(201);
  const { session } = await response.json(); expect(session.cwd).toBe(cwd);
  expect((await post(base + '/input', { sessionId: 'another', data: 'exit\r' })).status).toBe(409);
  expect((await post(base + '/resize', { sessionId: session.id, cols: 0, rows: 24 })).status).toBe(400);
});
it('streams real shell output and restores its snapshot after the browser disconnects', async () => {
  const { session } = await (await post(base, { cols: 80, rows: 24 })).json();
  const controller = new AbortController();
  const events = await fetch(base + '/events?sessionId=' + session.id, { signal: controller.signal });
  expect(events.headers.get('content-type')).toContain('text/event-stream');
  const reader = events.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('snapshot');
  controller.abort(); await reader.cancel().catch(() => {});
  expect((await post(base + '/input', { sessionId: session.id, data: "printf 'RECONNECTED_OK\\n'\r" })).status).toBe(200);
  await expect.poll(async () => (await (await fetch(base)).json()).session.output).toContain('RECONNECTED_OK');
  expect((await (await fetch(base)).json()).session.id).toBe(session.id);
  expect((await fetch(base, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) })).status).toBe(200);
});
it('creates the private default directory for a conversation without a selected workspace', async () => {
  const chat = store.createConversation({ projectId: '', agentId: '', cli: 'codex', model: null });
  const response = await post(base.replace(id, chat.id), { cols: 80, rows: 24 });
  expect(response.status).toBe(201);
  expect((await response.json()).session.cwd).toBe(join(home, 'workspaces', 'conversations', chat.id));
});
it('runs extra terminal slots beside the first, only in worktrees of the same repository', async () => {
  const { execFileSync } = await import('node:child_process');
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
  const side = join(home, 'side'); git('worktree', 'add', '-q', '-b', 'side', side);
  const first = (await (await post(base, { cols: 80, rows: 24 })).json()).session;
  expect((await post(base + '?slot=1', { cols: 80, rows: 24, worktree: '/etc' })).status).toBe(400);
  expect((await post(base + '?slot=6', { cols: 80, rows: 24 })).status).toBe(400);
  const second = (await (await post(base + '?slot=1', { cols: 80, rows: 24, worktree: side })).json()).session;
  expect(second.cwd).toBe(side); expect(second.id).not.toBe(first.id);
  expect((await (await fetch(base)).json()).session.id).toBe(first.id);
  const listed = (await (await fetch(base + '/sessions')).json()).sessions;
  expect(listed.map((item: { slot: number; session: { cwd: string } }) => [item.slot, item.session.cwd]).sort()).toEqual([[0, cwd], [1, side]]);
  expect((await post(base + '/input?slot=1', { sessionId: first.id, data: 'x' })).status).toBe(409);
  for (const [slot, session] of [['0', first], ['1', second]] as const)
    expect((await fetch(base + '?slot=' + slot, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) })).status).toBe(200);
});
