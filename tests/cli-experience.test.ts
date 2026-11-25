import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';

const executable = resolve('cli/mandala.mjs');
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function home() { const path = await mkdtemp(join(tmpdir(), 'mandala-cli-experience-')); cleanups.push(() => rm(path, { recursive: true, force: true })); return path; }
async function run(args: string[], extra: Record<string, string> = {}, tty = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, MANDALA_HOME: await home(), ...extra };
  for (const name of ['MANDALA_BASE_URL', 'OPEN_MANA_BASE_URL', 'MANDALA_CONTEXT', 'OPEN_MANA_CONTEXT']) if (!(name in extra)) delete env[name];
  if (tty) return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const child = pty.spawn(process.execPath, [executable, ...args], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env });
    let stdout = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('PTY timed out')); }, 15000);
    child.onData(chunk => { stdout += chunk; }); child.onExit(({ exitCode }) => { clearTimeout(timer); done({ code: exitCode, stdout: stdout.replaceAll('\r\n', '\n'), stderr: '' }); });
  });
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => execFile(process.execPath, [executable, ...args], { env }, (error, stdout, stderr) => done({ code: error ? 1 : 0, stdout, stderr })));
}
const reply = (res: ServerResponse, value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function server(handler: RequestListener) {
  const service = createServer(handler); await new Promise<void>(done => service.listen(0, '127.0.0.1', done));
  cleanups.push(() => { service.closeAllConnections(); return new Promise<void>(done => service.close(() => done())); });
  return `http://127.0.0.1:${(service.address() as { port: number }).port}`;
}

test('TTY help progressively exposes groups, actions and executable examples without HTTP internals', async () => {
  const root = await run(['--help'], {}, true);
  expect(root.code).toBe(0); expect(root.stdout).toContain('Usage: mandala'); expect(root.stdout).toContain('Groups:'); expect(root.stdout).not.toContain('/api/'); expect(root.stdout).not.toContain('  start <taskId>');
  const group = await run(['tasks', '--help'], {}, true);
  expect(group.stdout).toContain('mark-completed'); expect(group.stdout).not.toContain('conversations send');
  const action = await run(['tasks', 'start', '--help'], {}, true);
  expect(action.stdout).toContain('<taskId>'); expect(action.stdout).toContain('expectedRevision'); expect(action.stdout).toContain('--key');
  expect(action.stdout).not.toContain('/api/');
});

test('pipes and explicit JSON preserve help envelope while --human is available outside TTY', async () => {
  for (const tty of [false, true]) {
    const result = await run(['tasks', 'create', '--help', '--json'], { NO_COLOR: '1' }, tty);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { commands: [{ command: 'tasks create', agent: true }] } });
    expect(result.stdout).not.toContain('\u001b');
  }
  const human = await run(['--help', '--human']); expect(human.stdout).toContain('Groups:'); expect(human.stdout).not.toContain('\u001b');
});

test('every Agent command exposes a usable input example and both format options', async () => {
  const result = JSON.parse((await run(['--help', '--json'])).stdout);
  expect(result.data.options).toHaveProperty('--human'); expect(result.data.options).toHaveProperty('--json');
  for (const command of result.data.commands.filter((item: any) => item.agent)) expect(command.agentDataExample, command.command).toBeDefined();
  const skill = await run(['skills', 'register', '--help', '--human']); expect(skill.stdout).toContain('--data'); expect(skill.stdout).toContain('description:');
  const wiki = await run(['wiki', 'create', '--help', '--human']); expect(wiki.stdout).toContain('purpose'); expect(wiki.stdout).toContain('name');
  const system = await run(['system-tasks', 'run', '--help', '--human']); expect(system.stdout).toContain('title | memory');
});

test('required local request bodies are discoverable from action help', async () => {
  for (const [command, fields] of [['tasks draft', ['description']], ['knowledge create', ['kind', 'title', 'content', 'scope', 'status']], ['assets maintain', ['enabled', 'expectedRevision']]] as const) {
    const result = JSON.parse((await run([...command.split(' '), '--help', '--json'])).stdout);
    for (const field of fields) expect(result.data.commands[0].dataExample, command).toHaveProperty(field);
  }
});

test('Agent context forces JSON even in PTY with --human, including argument and context errors', async () => {
  for (const args of [['--help'], ['--human', '--help'], ['--human', '--wat'], ['--human', 'tasks', 'list']]) {
    const result = await run(args, { OPEN_MANA_CONTEXT: '/nonexistent/context' }, true);
    expect(() => JSON.parse(result.stdout)).not.toThrow(); expect(result.stdout).not.toContain('\u001b');
  }
});

test.skipIf(process.platform === 'win32')('redirected stderr remains JSON even when stdout is a terminal', async () => {
  const root = await home(), errors = join(root, 'errors');
  const result = await new Promise<number>((done, reject) => {
    const child = pty.spawn('/bin/sh', ['-c', 'exec "$TEST_NODE" "$TEST_CLI" tasks get 2>"$TEST_ERRORS"'], { cols: 80, rows: 24, cwd: process.cwd(), env: { ...process.env, MANDALA_CONTEXT: '', OPEN_MANA_CONTEXT: '', MANDALA_HOME: root, TEST_NODE: process.execPath, TEST_CLI: executable, TEST_ERRORS: errors } });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Redirected PTY timed out')); }, 15000);
    child.onExit(({ exitCode }) => { clearTimeout(timer); done(exitCode); });
  });
  expect(result).toBe(1); expect(JSON.parse(await readFile(errors, 'utf8'))).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
});

test('events preserve one JSON envelope per event and binary files never leak bytes into output', async () => {
  const base = await server((req, res) => {
    if (req.url?.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('id: 1\nevent: status\ndata: {"status":"queued"}\n\nid: 2\nevent: status\ndata: {"status":"unknown"}\n\n'); }
    else { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from([0, 1, 255, 2])); }
  });
  const events = await run(['conversations', 'events', 'chat-id', '--base-url', base]);
  expect(events.stdout.trim().split('\n').map(line => JSON.parse(line).data.data.status)).toEqual(['queued', 'unknown']);
  const human = await run(['conversations', 'events', 'chat-id', '--base-url', base, '--human']); expect(human.stdout).toContain('queued'); expect(human.stdout).toContain('unknown');
  const output = join(await home(), 'download.bin');
  const binary = await run(['assets', 'read', 'asset-id', 'version-id', '0', '--base-url', base, '--output', output, '--human']);
  expect(binary.code).toBe(0); expect(await readFile(output)).toEqual(Buffer.from([0, 1, 255, 2])); expect(binary.stdout).toContain(output); expect(binary.stdout).not.toContain('\0');
});

test('human results retain full nested values and distinguish accepted/queued/unknown from completed', async () => {
  const text = '原文 /long/path/' + 'x'.repeat(300);
  const base = await server((_req, res) => reply(res, { accepted: true, status: 'queued', id: 'task-id', result: { text } }));
  const result = await run(['tasks', 'start', 'task-id', '--data', '{"expectedRevision":1}', '--key', 'test-key', '--base-url', base, '--human']);
  expect(result.code).toBe(0); expect(result.stdout).toContain('queued'); expect(result.stdout).toContain(text); expect(result.stdout).toContain('test-key'); expect(result.stdout).not.toMatch(/successfully completed/i);
  const empty = await server((_req, res) => reply(res, []));
  expect((await run(['tasks', 'list', '--base-url', empty, '--human'])).stdout).toContain('No results');
});

test('human errors preserve code, details, key, exit and stderr with next steps', async () => {
  let calls = 0;
  const base = await server((_req, res) => { calls++; res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'command_unconfirmed', message: 'Outcome unknown', details: { taskId: 'task-id' } })); });
  const result = await run(['tasks', 'start', 'task-id', '--data', '{"expectedRevision":1}', '--key', 'retain-key', '--base-url', base, '--human']);
  expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('command_unconfirmed'); expect(result.stderr).toContain('retain-key'); expect(result.stderr).toContain('task-id'); expect(result.stderr).toMatch(/query|inspect/i); expect(calls).toBe(1);
});
