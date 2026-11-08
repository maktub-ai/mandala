import { windowsSystemBinary } from '../cli/windows-system.mjs';
import { productEnv } from '../cli/product-env.mjs';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';
import crossSpawn from 'cross-spawn';
import { fileURLToPath } from 'node:url';
import { execFileSync, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
export function resolveNativeCli(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const windows = process.platform === 'win32';
  const extensions = windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.toLowerCase()).filter(value => ['.com','.exe','.bat','.cmd'].includes(value)) : [''];
  for (const entry of (env.PATH ?? env.Path ?? '').split(windows ? ';' : delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const file = resolve(join(directory, command + extension));
      try { if (!statSync(file).isFile()) continue; accessSync(file, constants.X_OK); return file; } catch {}
    }
  }
  throw Object.assign(new Error(`${command} not found in explicit PATH directories`), { code: 'ENOENT' });
}

const registeredPathScript = Buffer.from(`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::WriteLine([Environment]::GetEnvironmentVariable('Path', 'Machine'))
[Console]::WriteLine([Environment]::GetEnvironmentVariable('Path', 'User'))
`, 'utf16le').toString('base64');

function registeredWindowsPath(): string[] {
  try {
    const output = execFileSync(windowsSystemBinary('powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', registeredPathScript],
      { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
    return output.split(/[;\r\n]+/).map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
      .filter(directory => win32.isAbsolute(directory) && win32.parse(directory).root.length > 1);
  } catch { return []; }
}

function resolveWindowsLaunch(command: string, env: NodeJS.ProcessEnv, refreshWindowsPath: boolean): string {
  try { return resolveNativeCli(command, env); }
  catch (error) {
    if (!refreshWindowsPath || productEnv('DESKTOP') !== '1' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Desktop backends outlive installers that update the registered PATH.
    const registered = registeredWindowsPath();
    if (!registered.length) throw error;
    env.PATH = [env.PATH ?? env.Path, ...registered].filter(Boolean).join(';');
    return resolveNativeCli(command, env);
  }
}

// Native CLI adapters always use three pipes; cross-spawn also resolves/escapes Windows npm shims.
export function spawn(command: string, args: string[], { refreshWindowsPath = false, ...options }: SpawnOptionsWithoutStdio & { stdio: 'pipe'; refreshWindowsPath?: boolean }): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') process.env.comspec = windowsSystemBinary('cmd.exe');
  // Native tools can use PWD before their protocol session supplies cwd.
  const cwd = typeof options.cwd === 'string' || options.cwd === undefined ? resolve(options.cwd ?? process.cwd()) : fileURLToPath(options.cwd);
  const env = { ...(options.env ?? process.env), PWD: cwd };
  const child = crossSpawn(process.platform === 'win32' ? resolveWindowsLaunch(command, env, refreshWindowsPath) : command, args, { ...options, env, windowsHide: true }) as ChildProcessWithoutNullStreams;
  if (process.platform === 'win32') {
    const kill = child.kill.bind(child);
    child.kill = signal => {
      if (signal === 0 || !child.pid || child.exitCode !== null || child.signalCode !== null) return kill(signal);
      // npm shims add cmd.exe as a parent; stop its tree so the actual native CLI cannot remain orphaned.
      try { execFileSync(windowsSystemBinary('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); return true; }
      catch { return kill(signal); }
    };
  }
  return child;
}
