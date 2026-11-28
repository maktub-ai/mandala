import {runtimeCatalog} from '../shared/runtimes';
import type {Cli,CliStatus} from '../shared/types';
import { windowsSystemBinary } from '../cli/windows-system.mjs';
import { productEnv } from '../cli/product-env.mjs';
import { loginShellPath } from '../desktop/login-shell-path';
import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';
import crossSpawn from 'cross-spawn';
import { fileURLToPath } from 'node:url';
import { execFileSync, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
export type NativeCliDetection = {state:'missing'|'broken'|'blocked'} | {state:'executable';path:string};
export function diagnoseNativeCli(command: string, env: NodeJS.ProcessEnv = process.env): NativeCliDetection {
  const windows = process.platform === 'win32';
  const direct = isAbsolute(command) || windows && win32.isAbsolute(command);
  const extensions = windows && /\.(?:com|exe|bat|cmd)$/i.test(command) ? [''] : windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.toLowerCase()).filter(value => ['.com','.exe','.bat','.cmd'].includes(value)) : [''];
  const candidates=direct?[command]:(env.PATH ?? env.Path ?? '').split(windows ? ';' : delimiter).flatMap(entry=>{
    const directory=entry.replace(/^"(.*)"$/, '$1');
    return !directory||!isAbsolute(directory)?[]:extensions.map(extension=>resolve(join(directory,command+extension)));
  });
  let problem: 'missing'|'broken'|'blocked'='missing';
  for(const path of candidates){
    try {
      const node=lstatSync(path);
      let target;
      try {target=statSync(path);}
      catch(error){
        if(node.isSymbolicLink()&&['ENOENT','ENOTDIR','ELOOP'].includes((error as NodeJS.ErrnoException).code??'')){if(problem==='missing')problem='broken';continue;}
        problem='blocked';continue;
      }
      if(!target.isFile()){problem='blocked';continue;}
      accessSync(path,constants.X_OK);return {state:'executable',path};
    }catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))problem='blocked';}
  }
  return {state:problem};
}
export function resolveClaudeLauncher(env: NodeJS.ProcessEnv): NativeCliDetection {
  const command = env.CLAUDE_CODE_EXECUTABLE || (process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (!(isAbsolute(command) || process.platform === 'win32' && win32.isAbsolute(command) || /^[a-z0-9_.-]+$/i.test(command))) {
    return {state: 'missing'};
  }
  return diagnoseNativeCli(command, env);
}

export function diagnoseRuntimePrerequisites(cli: Cli, env: NodeJS.ProcessEnv = process.env): Pick<NonNullable<CliStatus['diagnostics']>, 'executable' | 'requiredDependency'> {
  if (cli !== 'claude') return {executable: diagnoseNativeCli(runtimeCatalog[cli].command, env).state};
  const executable = resolveClaudeLauncher(env).state;
  return {executable, ...(env.CLAUDE_CODE_EXECUTABLE && executable !== 'executable' ? {requiredDependency: 'claude-override-unavailable'} : {})};
}

let pendingLoginPath: Promise<string> | undefined;
/** Recheck local desktop launchers without replacing explicit choices or the daemon's PATH. */
export async function refreshDesktopRuntimePath(cli: Cli, runtimeEnv?: Record<string, string>): Promise<Record<string, string> | undefined> {
  if (process.platform !== 'darwin' || productEnv('DESKTOP') !== '1' || Object.hasOwn(runtimeEnv ?? {}, 'PATH')) return runtimeEnv;
  const env = { ...process.env, ...runtimeEnv };
  // A long-running desktop worker may see a stale, but still executable,
  // Claude installation. Honor a pin; otherwise use today's login-shell order
  // for both catalog checks and new sessions.
  if (cli === 'claude' ? env.CLAUDE_CODE_EXECUTABLE : diagnoseRuntimePrerequisites(cli, env).executable === 'executable') return runtimeEnv;

  const home = homedir();
  if (!isAbsolute(home)) return runtimeEnv;
  const { PATH, SHELL, USER, LOGNAME, LANG, TERM, TMPDIR, ZDOTDIR } = process.env;
  // Concurrent checks share one probe; the next check can see newly installed
  // tools. Never send request-specific variables or daemon secrets to the shell.
  const discovered = await (pendingLoginPath ??= loginShellPath({ HOME: home, PATH, SHELL, USER, LOGNAME, LANG, TERM, TMPDIR, ZDOTDIR }, home)
    .finally(() => { pendingLoginPath = undefined; }));
  const candidates = discovered.split(delimiter).filter(isAbsolute);
  if (cli === 'opencode') candidates.push(join(home, '.opencode', 'bin'));
  const existing = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const refreshed = [...new Set(cli === 'claude' ? [...candidates, ...existing] : [...existing, ...candidates])].join(delimiter);
  return diagnoseRuntimePrerequisites(cli, { ...env, PATH: refreshed }).executable === 'executable'
    ? { ...runtimeEnv, PATH: refreshed } : runtimeEnv;
}

export function resolveNativeCli(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const found=diagnoseNativeCli(command,env);
  if(found.state==='executable')return found.path;
  throw Object.assign(new Error(isAbsolute(command) || process.platform==='win32'&&win32.isAbsolute(command)? `${command} not found` : `${command} not found in explicit PATH directories`),{code:'ENOENT'});
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
export function spawn(command: string, args: string[], { refreshWindowsPath = false, catalogRuntime, ...options }: SpawnOptionsWithoutStdio & {
  stdio: 'pipe'; refreshWindowsPath?: boolean; catalogRuntime?: Cli;
}): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') process.env.comspec = windowsSystemBinary('cmd.exe');
  // Native tools can use PWD before their protocol session supplies cwd.
  const cwd = typeof options.cwd === 'string' || options.cwd === undefined ? resolve(options.cwd ?? process.cwd()) : fileURLToPath(options.cwd);
  const env = { ...(options.env ?? process.env), PWD: cwd };
  // Unix built-ins use the same ordered absolute PATH candidates as diagnostics.
  // Custom commands and explicit paths keep their existing launch semantics.
  const executable = process.platform === 'win32' ? resolveWindowsLaunch(command, env, refreshWindowsPath)
    : catalogRuntime && runtimeCatalog[catalogRuntime].command === command ? resolveNativeCli(command, env) : command;
  const child = crossSpawn(executable, args, { ...options, env, windowsHide: true }) as ChildProcessWithoutNullStreams;
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
