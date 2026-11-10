export { readRuntimeBuild } from './service-discovery';
export { desktopCliStatus, installDesktopCli } from './cli-registration';
export { readDesktopPreferences, writeDesktopPreference } from './preferences';
export { readDesktopAppearance, writeDesktopAppearance } from './appearance';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readServiceRecord, serviceAlive, removeServiceRecord, controlService, ServiceStartingError, type RuntimeBuild, type ServiceRecord } from './service-discovery';
import { windowsSystemBinary } from '../cli/windows-system.mjs';
import { ownedPrivatePath, protectInvocationDirectory } from '../cli/private-path.mjs';
import { productHome } from '../cli/product-env.mjs';

export function resolveDesktopHome(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  return resolve(productHome('workspace', env, userHome));
}
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return env.PATH ?? '';
  try {
    const output = execFileSync(env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\nMANDALA_PATH=%s\\n" "$PATH"'], { env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    return output.split('\n').find(line => line.startsWith('MANDALA_PATH='))?.slice(13) ?? env.PATH ?? '';
  } catch { return env.PATH ?? ''; }
}
export function desktopEnvironment({ env = process.env, home, runtime, userHome = homedir(), platform = process.platform, loginPath = '' }: {
  env?: NodeJS.ProcessEnv; home: string; runtime: string; userHome?: string; platform?: string; loginPath?: string;
}): NodeJS.ProcessEnv {
  const separator = platform === 'win32' ? ';' : ':';
  const paths = [join(runtime, 'bin'), ...loginPath.split(separator), join(userHome, '.local', 'bin'), join(userHome, '.bun', 'bin'), ...(platform === 'win32' ? [join(env.APPDATA ?? join(userHome, 'AppData', 'Roaming'), 'npm')] : ['/opt/homebrew/bin', '/usr/local/bin']), ...(env.PATH ?? env.Path ?? '').split(separator)].filter(Boolean);
  const clean = { ...env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'OPEN_MANA_DEV', 'MANDALA_DEV']) delete clean[key];
  return { ...clean, PATH: [...new Set(paths)].join(separator), OPEN_MANA_HOME: home, MANDALA_HOME: home, OPEN_MANA_PORT: '0', MANDALA_PORT: '0', MANDALA_DESKTOP: '1', MANDALA_DESKTOP_PERSIST: '1' };
}
export function assertHomeAvailable(home: string): void {
  if (process.platform === 'win32' && existsSync(home) && !ownedPrivatePath(home, statSync(home))) throw new Error('Choose a private Windows data directory accessible only to your user, SYSTEM and administrators.');
  const leases = join(home, '.store-leases');
  if (!existsSync(leases)) return;
  for (const lease of readdirSync(leases)) {
    const pid = Number(lease.split('-')[0]);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Data directory has an unknown active lease. Use a separate MANDALA_HOME.');
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw new Error('Another service is using this data directory. Stop it or select a separate MANDALA_HOME before opening Mandala.');
  }
}
export function prepareDesktopHome(home: string): void {
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') protectInvocationDirectory(home);
  }
  if (process.platform === 'win32' && !ownedPrivatePath(home, statSync(home))) throw new Error('Data directory permissions are not private.');
}
export function allowedNavigation(value: string, origin: string): boolean {
  try { return new URL(value).origin === origin; } catch { return false; }
}
export type DesktopService = { child: ChildProcess; origin: string; setupToken?: string };
export async function startService({ node, entry, cwd, env, timeoutMs = 30000, onSpawn }: {
  node: string; entry: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; onSpawn?: (child: ChildProcess) => void;
}): Promise<DesktopService> {
  const child = spawn(node, [entry], { cwd, env, windowsHide: true, detached: true, stdio: env.MANDALA_DESKTOP_PERSIST === '1' ? ['ignore', 'ignore', 'ignore', 'ipc'] : ['ignore', 'pipe', 'pipe', 'ipc'] });
  onSpawn?.(child);
  // Do not write CLI output or business content into a desktop log.
  child.stdout?.resume(); child.stderr?.resume();
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { clearTimeout(timer); child.removeListener('message', ready); reject(error); };
    const ready = (message: any) => {
      if (message?.type !== 'mandala:ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
      clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', exited); child.removeListener('message', ready);
      resolve({ child, origin: `http://127.0.0.1:${message.port}`, setupToken: typeof message.setupToken === 'string' ? message.setupToken : undefined });
    };
    const exited = (code: number | null) => fail(new Error(`Local service exited before startup (code ${code}). Check data-directory ownership and runtime compatibility.`));
    const timer = setTimeout(() => {
      child.removeListener('message', ready); child.removeListener('exit', exited);
      void (async () => {
        try { await stopService(child); }
        catch {
          // Startup never opened a window. Reap only this owned process tree before releasing supervision.
          await forceStopService(child);
        }
        fail(new Error('Local service startup timed out; its owned process has stopped.'));
      })();
    }, timeoutMs);
    child.once('error', fail); child.once('exit', exited); child.on('message', ready);
  });
}
export async function stopService(child: ChildProcess, timeoutMs = 15000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('Service has not finished shutting down. Force quitting may interrupt active work.')); }, timeoutMs);
    child.once('exit', done);
    if (child.connected) child.send({ type: 'mandala:stop' }, error => { if (error && child.exitCode === null) child.kill('SIGTERM'); });
    else child.kill('SIGTERM');
  });
}

export async function forceStopService(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (process.platform === 'win32') { try { execFileSync(windowsSystemBinary('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { child.kill(); } }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  await exited;
}

export type BackgroundService = {
  origin: string; setupToken: string; home: string; record: ServiceRecord;
  build?: RuntimeBuild; canStopIfIdle?: boolean; upgradePending?: 'busy' | 'confirmation';
};
function sameBuild(expected: RuntimeBuild, actual?: RuntimeBuild): boolean {
  return expected.version === actual?.version && expected.commit === actual.commit;
}
export class RuntimeShutdownTimeout extends Error {
  constructor() { super('Runtime is still shutting down. Wait a moment, then try again.'); }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
export async function connectService(home: string): Promise<BackgroundService | undefined> {
  const record = readServiceRecord(home);
  if (!record) return;
  if (!serviceAlive(record)) { removeServiceRecord(home, record); return; }
  const { build, canStopIfIdle } = await controlService(record, 'probe');
  return { home, record, origin: record.origin, setupToken: record.setupToken, build, canStopIfIdle };
}
export async function connectOrStartService(options: Parameters<typeof startService>[0] & {
  home: string; build?: RuntimeBuild; shutdownTimeoutMs?: number;
  confirmLegacy?: (service: BackgroundService) => Promise<boolean>;
}): Promise<BackgroundService> {
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  let existing: BackgroundService | undefined;
  while (true) {
    try {
      existing = await connectService(options.home);
      break;
    } catch (error) {
      // A frontend may reopen while the independently running daemon initializes.
      const waitingForShutdown = options.build && (error instanceof TypeError || (error as Error).name === 'TimeoutError');
      if (!waitingForShutdown && !(error instanceof ServiceStartingError)) throw error;
      if (Date.now() >= deadline) {
        if (waitingForShutdown) throw new RuntimeShutdownTimeout();
        throw error;
      }
      await pause();
    }
  }
  if (existing) {
    if (!options.build || sameBuild(options.build, existing.build)) return existing;
    const result = existing.canStopIfIdle ? (await requestUpgradeStop(existing, 'stop-if-idle')).idleStop : 'unknown';
    if (result === 'busy') return { ...existing, upgradePending: 'busy' };
    if (result === 'accepted') await waitForBackgroundShutdown(existing, options.shutdownTimeoutMs);
    else {
      if (!await options.confirmLegacy?.(existing)) return { ...existing, upgradePending: 'confirmation' };
      await requestUpgradeStop(existing, 'stop');
      await waitForBackgroundShutdown(existing, options.shutdownTimeoutMs);
    }
    // Another launcher could have won the claim after the old lock was released.
    const replacement = await connectService(options.home);
    if (replacement) {
      if (!sameBuild(options.build, replacement.build)) throw new Error('Another desktop runtime started with a different build. Reopen Mandala to check again.');
      return replacement;
    }
  }
  assertHomeAvailable(options.home);
  const service = await startService(options);
  try {
    const connected = await connectService(options.home);
    if (!connected || connected.record.pid !== service.child.pid) throw new Error('Desktop runtime did not publish its identity.');
    if (options.build && !sameBuild(options.build, connected.build)) throw new Error('The background runtime does not match the installed Mandala build.');
    // The daemon owns its lifecycle from this point, including across frontend crashes.
    service.child.disconnect(); service.child.unref();
    return connected;
  } catch (error) { await stopService(service.child); throw error; }
}
async function requestUpgradeStop(service: BackgroundService, action: 'stop' | 'stop-if-idle') {
  if (readServiceRecord(service.home)?.secret !== service.record.secret) return { idleStop: 'accepted' as const };
  try { return await controlService(service.record, action); }
  catch (error) {
    if (readServiceRecord(service.home)?.secret !== service.record.secret) return { idleStop: 'accepted' as const };
    if (error instanceof TypeError || (error as Error).name === 'TimeoutError') throw new RuntimeShutdownTimeout();
    throw error;
  }
}
export async function stopBackgroundService(service: BackgroundService, timeoutMs?: number): Promise<void> {
  // A confirmation may stay open while the verified process finishes independently.
  if (readServiceRecord(service.home)?.secret === service.record.secret) {
    try { await controlService(service.record, 'stop'); }
    catch (error) {
      if (readServiceRecord(service.home)?.secret === service.record.secret) throw error;
    }
  }
  await waitForBackgroundShutdown(service, timeoutMs);
}
async function waitForBackgroundShutdown(service: BackgroundService, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = readServiceRecord(service.home);
    if (current ? current.secret !== service.record.secret : !existsSync(join(service.home, '.service-home-lock'))) return;
    if (Date.now() >= deadline) throw new RuntimeShutdownTimeout();
    await pause();
  }
}
