import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { refreshDesktopRuntimePath } from '../server/native-spawn';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import type { Config } from '../shared/types';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mandala-mac-cli-')); roots.push(home);
  const path = join(home, 'stale bin'), late = join(home, 'late bin'), shell = join(home, 'login-shell');
  const shellPath = join(home, 'shell-path'), shellCalls = join(home, 'shell-calls');
  await Promise.all([mkdir(path), mkdir(late), writeFile(shellPath, path)]);
  await writeFile(shell+'.cjs', `const fs = require('node:fs');
if (process.env.HOME !== ${JSON.stringify(home)} || process.cwd() !== fs.realpathSync(process.env.HOME) || process.env.FIXTURE_SECRET) process.exit(3);
console.log('startup noise');
console.log('MANDALA_PATH=' + fs.readFileSync(${JSON.stringify(shellPath)}, 'utf8'));
`);
  await writeFile(shell, `#!/bin/sh\nprintf 'checked\\n' >> '${shellCalls}'\nexec '${process.execPath}' '${shell}.cjs'\n`, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('SHELL', shell);
  vi.stubEnv('PATH', path);
  vi.stubEnv('MANDALA_DESKTOP', '1');
  vi.stubEnv('FIXTURE_SECRET', 'do-not-forward');
  const calls = async () => (await readFile(shellCalls, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return { home, path, late, shell, shellPath, calls };
}

const mac = it.skipIf(process.platform !== 'darwin');

mac('re-reads shell PATH for missing launchers, shares concurrent probes, and leaves daemon PATH untouched', async () => {
  const { path, late, shellPath, calls } = await fixture();
  expect(await Promise.all([refreshDesktopRuntimePath('gemini'), refreshDesktopRuntimePath('codex')])).toEqual([undefined, undefined]);
  expect(await calls()).toBe(1);
  await writeFile(shellPath, ['.', 'relative/bin', late, late].join(delimiter));
  await writeFile(join(late, 'gemini'), 'not executed', { mode: 0o700 });
  expect(await refreshDesktopRuntimePath('gemini', { SERVICE: 'configured' })).toEqual({ SERVICE: 'configured', PATH: [path, late].join(delimiter) });
  expect(process.env.PATH).toBe(path);
  expect(await calls()).toBe(2);
});

mac('keeps working launchers, explicit runtime paths and Claude overrides; does not refresh headless runtimes', async () => {
  const { path, late, calls } = await fixture();
  await writeFile(join(path, 'opencode'), 'not executed', { mode: 0o700 });
  expect(await refreshDesktopRuntimePath('opencode')).toBeUndefined();
  const explicit = { PATH: late };
  expect(await refreshDesktopRuntimePath('opencode', explicit)).toBe(explicit);
  const claudeOverride = { CLAUDE_CODE_EXECUTABLE: join(late, 'missing-claude') };
  expect(await refreshDesktopRuntimePath('claude', claudeOverride)).toBe(claudeOverride);
  vi.stubEnv('MANDALA_DESKTOP', '0');
  expect(await refreshDesktopRuntimePath('gemini')).toBeUndefined();
  expect(await calls()).toBe(0);
});

mac('rechecks OpenCode on the same daemon and uses its normal installer directory even when shell probing fails', async () => {
  const { home, path, shell } = await fixture();
  const store = openStore(home);
  const config: Config = { version: 2, runtimes: ['opencode'], projects: [], agents: [] };
  const manager = createSessionManager(store, async () => config, undefined, undefined, home);
  const status = () => manager.getCliStatus(undefined, 'opencode', undefined, 'runtime', true);
  const bin = join(home, '.opencode', 'bin'), launcher = join(bin, 'opencode');
  try {
    await expect(status()).resolves.toMatchObject({ status: 'unavailable', diagnostics: { executable: 'missing', failureStage: 'launch' } });
    await mkdir(bin, { recursive: true });
    await writeFile(shell, '#!/bin/sh\nexit 1\n');
    await writeFile(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await expect(status()).resolves.toMatchObject({ status: 'unavailable', diagnostics: { executable: 'executable', failureStage: 'handshake' } });
    await writeFile(launcher, `#!${process.execPath}
if (process.env.PATH !== ${JSON.stringify([path, bin].join(delimiter))}) process.exit(4);
if (process.argv.includes('--version')) { console.log('2.4.1'); process.exit(0); }
if (process.argv[2] !== 'acp') process.exit(4);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const {id,method} = JSON.parse(line);
  if (id === undefined) return;
  const result = method === 'initialize' ? {protocolVersion:1,agentInfo:{name:'fixture',version:'2.4.1'},agentCapabilities:{loadSession:true}}
    : method === 'session/new' ? {sessionId:'fixture',models:{currentModelId:'fixture/model',availableModels:[{modelId:'fixture/model',name:'Fixture'}]}} : undefined;
  if (!result) process.exit(4);
  console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
});
`);
    await expect(status()).resolves.toMatchObject({ status: 'ready', version: '2.4.1', diagnostics: { executable: 'executable', probe: 'acp', auth: 'not-verified' } });
    await expect(manager.listModels(undefined, 'opencode')).resolves.toMatchObject([{ id: 'fixture/model' }]);
    expect(process.env.PATH).toBe(path);
  } finally { await manager.close(); store.close(); }
}, 20000);

mac('prefers the current login-shell Claude over an executable left on the daemon PATH', async () => {
  const { home, path, late, shellPath, calls } = await fixture();
  const old = join(path, 'claude'), fresh = join(late, 'claude');
  await writeFile(old, 'old launcher', { mode: 0o700 });
  const { resolveClaudeLauncher } = await import('../server/native-spawn');
  const selected = async () => resolveClaudeLauncher({ ...process.env, ...await refreshDesktopRuntimePath('claude') });
  expect(await selected()).toEqual({ state: 'executable', path: old });
  await writeFile(fresh, 'new launcher', { mode: 0o700 });
  await writeFile(shellPath, [late, path].join(delimiter));
  expect(await selected()).toEqual({ state: 'executable', path: fresh });
  expect(process.env.PATH).toBe(path);
  expect(await calls()).toBe(2);

  // Explicit overrides (even broken ones) are not implicitly switched.
  const override = { CLAUDE_CODE_EXECUTABLE: join(home, 'custom', 'claude') };
  expect(await refreshDesktopRuntimePath('claude', override)).toBe(override);
  expect(await calls()).toBe(2);
});


mac('inventories a not-enabled Claude launcher without running it', async () => {
  const { home, path } = await fixture();
  const store = openStore(home);
  const manager = createSessionManager(store, async () => ({version:2,runtimes:[],projects:[],agents:[]}), undefined, undefined, home);
  try {
    expect(await manager.getLocalCliLauncher('claude')).toEqual({executable:'missing'});
    // Executable by mode but deliberately not runnable: a launch probe would fail.
    await writeFile(join(path,'claude'), '#!/nonexistent-interpreter\n', {mode:0o700});
    expect(await manager.getLocalCliLauncher('claude')).toEqual({executable:'executable'});
    expect(await manager.getLocalCliLauncher('gemini')).toEqual({executable:'missing'});
  } finally { await manager.close(); store.close(); }
});
