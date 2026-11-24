import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeCatalog } from '../shared/runtimes';
import { diagnoseRuntimePrerequisites, spawn } from '../server/native-spawn';

const fixture = vi.hoisted(() => ({
  paths: new Map<string, 'file' | 'alias' | 'blocked'>(),
  lstat: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));
// Windows path semantics, not Mac path semantics with a mocked platform string.
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, isAbsolute: actual.win32.isAbsolute, join: actual.win32.join, resolve: actual.win32.resolve };
});
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  lstatSync: fixture.lstat, statSync: fixture.stat, accessSync: fixture.access,
}));
vi.mock('node:child_process', () => ({ execFileSync: fixture.exec }));
vi.mock('cross-spawn', () => ({ default: fixture.spawn }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const selected = 'C:\\fixture cli';
const second = 'C:\\later cli';
const registered = 'C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps';
const cwd = 'C:\\workspace';
const options = { cwd, env: { Path: `"${selected}";relative;${second}`, PATHEXT: '.CMD;.EXE' }, stdio: 'pipe' as const };
const missing = () => Object.assign(new Error('fixture missing'), { code: 'ENOENT' });

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('MANDALA_DESKTOP', '1');
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  vi.stubEnv('comspec', undefined);
  fixture.paths.clear();
  fixture.lstat.mockReset().mockImplementation((path: string) => {
    const found = fixture.paths.get(path);
    if (!found) throw missing();
    return { isSymbolicLink: () => false };
  });
  fixture.stat.mockReset().mockImplementation((path: string) => {
    if (fixture.paths.get(path) === 'blocked') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return { isFile: () => true };
  });
  fixture.access.mockReset();
  fixture.exec.mockReset().mockImplementation(() => { throw new Error('unexpected fixture system command'); });
  fixture.spawn.mockReset().mockImplementation(() => ({ kill: vi.fn(), pid: 0 }));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
});

it.each(Object.entries(runtimeCatalog))('binds Windows catalog %s to the first matching explicit PATH/PATHEXT entry', (_cli, { command }) => {
  fixture.paths.set(`${selected}\\${command}.exe`, 'file');
  fixture.paths.set(`${selected}\\${command}.cmd`, 'file');
  fixture.paths.set(`${second}\\${command}.cmd`, 'file');
  spawn(command, ['--version'], options);
  expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith(`${selected}\\${command}.cmd`, ['--version'], {
    ...options, env: { ...options.env, PWD: cwd }, windowsHide: true,
  });
  expect(fixture.exec).not.toHaveBeenCalled();
});

it('tries registered paths only on explicitly permitted desktop refresh, preserving caller env', () => {
  const alias = `${registered}\\codex.exe`;
  fixture.paths.set(alias, 'alias');
  fixture.exec.mockReturnValue(`relative;\\root-without-drive\r\n"${registered}"\r\n`);
  spawn('codex', ['--version'], { ...options, refreshWindowsPath: true });
  expect(fixture.exec).toHaveBeenCalledExactlyOnceWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)],
    { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith(alias, ['--version'], {
    ...options, env: { ...options.env, PATH: `${options.env.Path};${registered}`, PWD: cwd }, windowsHide: true,
  });
  const command = Buffer.from(fixture.exec.mock.calls[0][1].at(-1), 'base64').toString('utf16le');
  expect(command).toContain("GetEnvironmentVariable('Path', 'Machine')");
  expect(command).toContain("GetEnvironmentVariable('Path', 'User')");
  expect(options.env).not.toHaveProperty('PATH');
});

it.each([[true, '0'], [false, '1']] as const)('never queries registered paths without desktop mode and opt-in (%s, %s)', (refreshWindowsPath, desktop) => {
  vi.stubEnv('MANDALA_DESKTOP', desktop);
  fixture.paths.set(`${registered}\\codex.exe`, 'alias');
  expect(() => spawn('codex', [], { ...options, refreshWindowsPath })).toThrow(/not found in explicit PATH directories/);
  expect(fixture.exec).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});

it('does not spawn a WindowsApps entry with inaccessible target metadata', () => {
  fixture.paths.set(`${registered}\\codex.exe`, 'blocked');
  expect(() => spawn('codex', [], { ...options, env: { Path: registered } })).toThrow(/not found/);
  expect(fixture.exec).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});

it('reports standalone Claude without treating it as its missing ACP adapter', () => {
  fixture.paths.set(`${selected}\\claude.exe`, 'file');
  expect(diagnoseRuntimePrerequisites('claude', options.env)).toEqual({ executable: 'missing', standaloneClaude: true });
  expect(() => spawn(runtimeCatalog.claude.command, [], options)).toThrow(/not found/);
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fixture.exec).not.toHaveBeenCalled();
});

it('does not hand a bare command to cross-spawn if the refreshed path is also missing', () => {
  fixture.exec.mockReturnValue(registered);
  expect(() => spawn('codex', [], { ...options, refreshWindowsPath: true })).toThrow(/not found in explicit PATH directories/);
  expect(fixture.exec).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).not.toHaveBeenCalled();
});

it('does not refresh or choose another executable after the selected executable fails to launch', () => {
  fixture.paths.set(`${selected}\\codex.exe`, 'file');
  fixture.paths.set(`${second}\\codex.exe`, 'file');
  const terminal = Object.assign(new Error('fixture launch denied'), { code: 'EACCES' });
  fixture.spawn.mockImplementation(() => { throw terminal; });
  expect(() => spawn('codex', [], { ...options, refreshWindowsPath: true })).toThrow(terminal);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  expect(fixture.spawn.mock.calls[0][0]).toBe(`${selected}\\codex.exe`);
  expect(fixture.exec).not.toHaveBeenCalled();
});
