import { afterEach, expect, test, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crossSpawn from 'cross-spawn';
import { createBusinessCliRuntime } from '../server/business-cli-runtime';
import { mandalaPlanningSkill } from '../server/mandala-planning-skill';
import { codexMailboxSid, ownedPrivatePath, protectInvocationDirectory } from '../cli/private-path.mjs';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { resolveNativeCli } from '../server/native-spawn';
import { startCodex } from '../server/codex';
vi.mock('cross-spawn', async importOriginal => {
  const actual = await importOriginal<{ default: typeof crossSpawn }>();
  return { default: vi.fn(actual.default) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('../cli/private-path.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../cli/private-path.mjs')>();
  return process.platform === 'win32' ? actual : { ...actual, protectInvocationDirectory() {} };
});
const homes: string[] = [];
if (process.platform !== 'win32') vi.stubEnv('SystemRoot', 'C:\\Windows');
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

test('Windows invocation emits a native PowerShell launcher and keeps credential bytes out of the executable command', async () => {
  const home = mkdtempSync(join(tmpdir(), "mandala-win-$path-'")); homes.push(home);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const runtime = await createBusinessCliRuntime(home, 'invocation', { baseUrl: 'http://127.0.0.1:1', token: 'private-Windows-token' });
    expect(runtime.launcher).toMatch(/\.ps1$/);
    expect(runtime.command).toContain(win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(runtime.command).toContain("-File '");
    expect(runtime.command).toContain("$path-''");
    expect(runtime.command).not.toContain('private-Windows-token');
    const code = readFileSync(runtime.launcher, 'utf8');
    expect(code).toContain("$env:PSModulePath=$PSHOME+'\\Modules'");
    expect(code.indexOf('$env:PSModulePath=')).toBeLessThan(code.indexOf('ConvertTo-Json'));
    expect(code).toContain('ConvertTo-Json');
    expect(code).not.toContain('#!/bin/sh'); expect(code).not.toContain('private-Windows-token');
    expect(readFileSync(runtime.contextFile, 'utf8')).toContain('private-Windows-token');
  } finally { Object.defineProperty(process, 'platform', original); }
});

test('native adapter spawn prepares npm cmd shims with escaping instead of interpolating raw arguments', async () => {
  // Execute the real selected launcher dependency under a Windows process view; no Windows behavior is claimed from this parser test.
  const require = createRequire(import.meta.url);
  const source = await import('../server/native-spawn').catch(() => null);
  expect(source, 'native adapters need an argument-safe Windows spawn path').not.toBeNull();
  const filename = require.resolve('cross-spawn/lib/parse');
  const module = { exports: {} as any };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    process: { platform: 'win32', env: { comspec: 'cmd.exe' } },
    require(name: string) {
      if (name === './util/resolveCommand') return () => 'C:\\Program Files\\npm\\node_modules\\.bin\\codex.cmd';
      if (name === './util/readShebang') return () => null;
      return require(name.startsWith('.') ? resolve(filename, '..', name) : name);
    }
  }, { filename });
  const input = ['app-server', '--stdio', 'x & whoami', 'quoted"value', '%TOKEN%'];
  const parsed = module.exports('codex', input, { shell: false });
  expect(parsed.command).toBe('cmd.exe');
  expect(parsed.options.windowsVerbatimArguments).toBe(true);
  expect(parsed.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  expect(parsed.args[3]).not.toContain('x & whoami');
  expect(input[2]).toBe('x & whoami');
});

test.skipIf(process.platform !== 'win32')('Windows PowerShell invocation preserves exact quoted arguments and succeeds without a credential on argv', async () => {
  const home = mkdtempSync(join(tmpdir(), "mandala win $ invocation '")); homes.push(home);
  const runtime = await createBusinessCliRuntime(home, 'invocation', { baseUrl: 'http://127.0.0.1:1', token: 'private-Windows-token' }, async request => ({ request }));
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', runtime.command + " project agents --key 'literal&key'"], { stdio: 'pipe' });
    let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    const code = await new Promise<number | null>((r, j) => { child.once('close', r); child.once('error', j); });
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, data: { request: { command: 'project agents', commandKey: 'literal&key' } } });
  } finally { runtime.dispose(); }
}, 20000);

// Use an explicit Codex executable for this integration test. No model or login is needed.
const sandboxCodex = process.env.MANDALA_TEST_CODEX;
test.skipIf(process.platform !== 'win32' || !sandboxCodex)('Windows Codex prepares a private mailbox before parallel commands in initial and resumed turns', async () => {
  // Codex refuses to create its helper executables under the Windows temp root.
  const home = mkdtempSync(join(homedir(), 'mandala sandbox ')); homes.push(home);
  const codexHome = join(home, 'codex-home');
  const project = join(home, 'project');
  const subdirectory = join(project, 'subdirectory');
  const temp = join(home, 'temp');
  mkdirSync(codexHome);
  protectInvocationDirectory(codexHome);
  mkdirSync(project);
  protectInvocationDirectory(project);
  mkdirSync(subdirectory);
  mkdirSync(temp);
  let roundCommands: { key: string; command: string; workdir: string }[] = [];
  // Drive the real native app-server without sending a model request off-machine.
  const model = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = payload.input ?? [];
    const shell = payload.tools?.find((tool: {name: string}) => ['exec_command', 'shell_command'].includes(tool.name))?.name;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type: string, data: object) => response.write('data: ' + JSON.stringify({ type, ...data }) + '\n\n');
    const answered = roundCommands.every(({ key }) => input.some((item: { type: string; call_id?: string }) => item.type === 'function_call_output' && item.call_id === key));
    const items = answered ? [{ id: 'fixture-message', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture ready.', annotations: [] }] }]
      : roundCommands.map(({ key, command, workdir }) => ({
        id: 'fc-' + key, call_id: key, type: 'function_call', name: shell, status: 'completed',
        arguments: JSON.stringify(shell === 'exec_command'
          ? { cmd: command, workdir, login: false, yield_time_ms: 10000 }
          : { command, workdir, login: false, timeout_ms: 15000 }),
      }));
    send('response.created', { response: { id: 'fixture-response', output: [] } });
    items.forEach((item, output_index) => {
      send('response.output_item.added', { output_index, item });
      send('response.output_item.done', { output_index, item });
    });
    send('response.completed', { response: { id: 'fixture-response', output: items } });
    response.end();
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const { port } = model.address() as { port: number };
  const configFile = join(codexHome, 'config.toml');
  const config = [
    'model="fixture"', 'model_provider="mandala_fixture"', 'sandbox_mode="workspace-write"',
    '[model_providers.mandala_fixture]', 'name="Local test fixture"', 'base_url="http://127.0.0.1:' + port + '/v1"', 'wire_api="responses"',
    '[windows]', 'sandbox="unelevated"',
  ].join('\n');
  const env = { ...process.env, CODEX_HOME: codexHome, TEMP: temp, TMP: temp };
  const capabilities = join(codexHome, 'cap_sid');
  let turnStatus: string | undefined;
  let parallelCommands = 0;
  const activeCommands = new Set<string>();
  const completedCommands: { exitCode: number; aggregatedOutput: string }[] = [];
  const openClient = () => {
    return startCodex({
      cwd: project, fullAccess: false,
      env: { CODEX_HOME: codexHome, TEMP: temp, TMP: temp, PATH: win32.dirname(sandboxCodex!) + ';' + process.env.PATH },
      onApproval() {}, onExit() {},
      onEvent(message) {
        if (message.method === 'turn/completed') turnStatus = message.params.turn.status;
        const item = message.params?.item;
        if (item?.type !== 'commandExecution') return;
        if (message.method === 'item/started') {
          activeCommands.add(item.id);
          parallelCommands = Math.max(parallelCommands, activeCommands.size);
        }
        if (message.method === 'item/completed') {
          activeCommands.delete(item.id);
          completedCommands.push(item);
        }
      },
    });
  };
  let client: Awaited<ReturnType<typeof openClient>> | undefined;
  const requests: unknown[] = [];
  let liveMailbox: string;
  let overlapChecked = false;
  const createRuntime = (round: string) => createBusinessCliRuntime(join(home, 'mandala-home'), round, { baseUrl: 'http://127.0.0.1:1', token: 'fixture' }, async request => {
    if (!overlapChecked) {
      overlapChecked = true;
      await expect.poll(() => readdirSync(liveMailbox).filter(name => name.endsWith('.request')).length, { timeout: 6000 }).toBe(2);
    }
    requests.push(request);
    return mandalaPlanningSkill;
  }, undefined, capabilities);
  const ps = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (runtime: Awaited<ReturnType<typeof createRuntime>>, key: string) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const permissions = 'permissions.mandala-test={extends=":read-only",filesystem={' + JSON.stringify(runtime.mailboxPath!) + '="write"}}';
    const args = ['sandbox', '-P', 'mandala-test', '-c', permissions, '-c', 'windows.sandbox="unelevated"', '-C', project, '--',
      ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runtime.launcher, 'mandala', 'planning-guide', '--key', key];
    execFile(sandboxCodex!, args, { cwd: project, env, windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      done({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, stdout, stderr });
    });
  });
  try {
    // The native compatibility sandbox for a named/read-only profile must not
    // be reused as authority to prepare write access to the project.
    writeFileSync(configFile, config.replace('sandbox_mode="workspace-write"', 'sandbox_mode="read-only"'));
    client = await openClient();
    const readOnly = await createRuntime('read-only');
    try {
      await client.startThread({ cwd: project, instructions: 'Read-only preparation probe.',
        runtimeWorkspaceRoots: [project, readOnly.mailboxPath!], runtimeMailboxPath: readOnly.mailboxPath });
      expect(await codexMailboxSid(capabilities, readOnly.mailboxPath!)).toBeDefined();
      expect(ownedPrivatePath(project, lstatSync(project)), 'Read-only preparation must preserve the project ACL').toBe(true);
    } finally {
      await client.close();
      client = undefined;
      readOnly.dispose();
    }
    writeFileSync(configFile, config);
    client = await openClient();
    let threadId: string | undefined;
    for (const round of ['initial', 'resume']) {
      const runtime = await createRuntime(round);
      try {
        const roots = [project, runtime.mailboxPath!];
        if (threadId) await client.resumeThread(threadId, [], 'Current launcher', undefined, roots, runtime.mailboxPath);
        else threadId = await client.startThread({ cwd: project, instructions: 'Initial launcher', runtimeWorkspaceRoots: roots, runtimeMailboxPath: runtime.mailboxPath });
        const prepared = await codexMailboxSid(capabilities, runtime.mailboxPath!);
        expect(prepared, 'Codex must register the exact mailbox SID before its first command').toBeDefined();
        const registration = JSON.parse(readFileSync(capabilities, 'utf8'));
        const projectKey = project.replaceAll('\\', '/').toLowerCase();
        expect(registration.workspace_by_cwd[projectKey], 'Prepare the authorized workspace root before cold parallel commands').toBeDefined();
        expect(registration.writable_root_by_path[projectKey], 'Prepare the same project for commands run from subdirectories').toBeDefined();
        expect(ownedPrivatePath(runtime.contextFile, lstatSync(runtime.contextFile))).toBe(true);
        liveMailbox = runtime.mailboxPath!;
        overlapChecked = false;
        turnStatus = undefined;
        parallelCommands = 0;
        completedCommands.length = 0;
        roundCommands = [project, subdirectory].map((workdir, index) => {
          const key = round + (index === 0 ? '-a' : '-b');
          return { key, workdir, command: runtime.command + ' mandala planning-guide --key ' + key };
        });
        await client.startTurn(threadId!, 'Synthetic planning turn.', 'auto', roots);
        await expect.poll(() => turnStatus, { timeout: 25000 }).toBe('completed');
        expect(parallelCommands).toBe(2);
        expect(completedCommands).toHaveLength(2);
        for (const command of completedCommands) {
          expect(command.exitCode, command.aggregatedOutput).toBe(0);
          expect(command.aggregatedOutput).toContain('"name":"mandala-work-team-planning"');
        }
        expect(await codexMailboxSid(capabilities, runtime.mailboxPath!)).toBe(prepared);
        if (round === 'initial') {
          await client.close();
          client = await openClient();
        }
        if (round === 'resume') {
          const icacls = win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe');
          for (const path of [runtime.contextFile, runtime.mailboxPath!, capabilities]) {
            execFileSync(icacls, [path, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
            const denied = await run(runtime, 'denied');
            expect(denied.code, denied.stderr).toBe(1);
            expect(denied.stderr).toContain('"code":"invalid_context"');
            execFileSync(icacls, [path, '/remove:g', '*S-1-1-0'], { windowsHide: true });
          }
        }
      } finally { runtime.dispose(); }
    }
    expect(requests).toHaveLength(4);
    for (const key of ['initial-a', 'initial-b', 'resume-a', 'resume-b'])
      expect(requests).toContainEqual({ command: 'mandala planning-guide', args: {}, commandKey: key });
  } finally {
    await client?.close();
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
  }
}, 90000);

test.skipIf(process.platform !== 'win32')('Windows npm-style codex.cmd uses a hidden piped launch and starts the mock protocol', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mandala cmd shim ')); homes.push(home);
  const shim = join(home, 'codex.cmd');
  const fixture = resolve('tests/fixtures/fake-cli.mjs');
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  const client = await startCodex({ cwd: home, env: { PATH: home + ';' + process.env.PATH }, onEvent() {}, onApproval() {}, onExit() {} });
  try {
    expect(await client.getStatus()).toMatchObject({ status: 'ready' });
    expect(await client.listModels()).toEqual([{ id: 'model-fixture', label: 'Fixture' }]);
    const launch = vi.mocked(crossSpawn).mock.calls.find(([command]) => command === shim);
    expect(launch?.[2]?.windowsHide).toBe(true);
    expect(launch?.[2]?.stdio).toBe('pipe');
  }
  finally { await client.close(); }
}, 20000);

test.skipIf(process.platform !== 'win32')('running desktop discovers a newly registered Codex on retry without changing its inherited PATH', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mandala path refresh ')); homes.push(home);
  const installed = join(home, '新安装 CLI'); mkdirSync(installed);
  const fixture = pathToFileURL(resolve('tests/fixtures/fake-cli.mjs')).href;
  const bridge = join(home, 'check-path.mjs');
  writeFileSync(bridge, `if (!process.env.PATH?.split(';').includes(${JSON.stringify(installed)})) process.exit(42);\nawait import(${JSON.stringify(fixture)});\n`);
  writeFileSync(join(installed, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${bridge}" %*\r\n`);
  const inherited = join(home, 'startup-path');
  vi.stubEnv('PATH', inherited);
  vi.stubEnv('MANDALA_DESKTOP', '1');
  const query = vi.mocked(execFileSync);
  const options = { cwd: home, onEvent() {}, onApproval() {}, onExit() {} };
  try {
    query.mockReturnValueOnce('');
    await expect(startCodex(options)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(query).toHaveBeenCalledTimes(1);
    query.mockReset();
    query.mockReturnValueOnce(installed);
    const client = await startCodex(options);
    try {
      expect(await client.getStatus()).toMatchObject({ status: 'ready' });
      expect(process.env.PATH).toBe(inherited);
    } finally { await client.close(); }
  } finally { query.mockReset(); vi.unstubAllEnvs(); }
}, 20000);

test.skipIf(process.platform !== 'win32').each(['PATH', 'Path'])('desktop respects an explicit %s even when it matches the inherited PATH', async key => {
  const home = mkdtempSync(join(tmpdir(), 'mandala path override ')); homes.push(home);
  vi.stubEnv('MANDALA_DESKTOP', '1');
  vi.stubEnv('PATH', home);
  const query = vi.mocked(execFileSync);
  query.mockReset();
  query.mockReturnValue('');
  try {
    await expect(startCodex({ cwd: home, env: { [key]: home }, onEvent() {}, onApproval() {}, onExit() {} })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(query).not.toHaveBeenCalled();
  } finally { query.mockReset(); vi.unstubAllEnvs(); }
});

test('generated Windows Node bridge really invokes CLI main and propagates error exit codes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mandala-bridge-entry-')); homes.push(home);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let runtime;
  try { runtime = await createBusinessCliRuntime(home, 'invocation', { baseUrl: 'http://127.0.0.1:1', token: 'private-bridge-token' }); }
  finally { Object.defineProperty(process, 'platform', original); }
  try {
    const bridge = join(runtime.launcher, '..', 'invoke.mjs');
    const help = spawnSync(process.execPath, [bridge], { env: { ...process.env, MANDALA_CLI_ARGUMENTS: JSON.stringify(['--help']) }, encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('mandala');
    const invalid = spawnSync(process.execPath, [bridge], { env: { ...process.env, MANDALA_CLI_ARGUMENTS: JSON.stringify(['invalid-command']) }, encoding: 'utf8' });
    expect(invalid.status).toBe(1); expect(JSON.parse(invalid.stderr)).toMatchObject({ ok: false });
  } finally { runtime.dispose(); }
});

test('default native CLI resolution selects an explicit PATH entry and never a project-cwd shim', () => {
  const home = mkdtempSync(join(tmpdir(), 'mandala-cli-cwd-')); homes.push(home);
  const trusted = join(home, 'trusted'), project = join(home, 'project'); mkdirSync(trusted); mkdirSync(project);
  writeFileSync(join(trusted, 'codex.cmd'), 'trusted'); writeFileSync(join(project, 'codex.cmd'), 'project hijack'); chmodSync(join(trusted, 'codex.cmd'),0o700);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!; Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(resolveNativeCli('codex', { PATH: ';.;' + trusted, PATHEXT: '.CMD' })).toBe(join(trusted, 'codex.cmd'));
    expect(() => resolveNativeCli('omp', { PATH: project, PATHEXT: '.CMD' })).toThrow(/not found/);
  } finally { Object.defineProperty(process, 'platform', original); }
});
