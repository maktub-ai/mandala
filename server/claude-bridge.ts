import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from '../scripts/claude-bridge/manifest.json';
import { diagnoseNativeCli, resolveClaudeLauncher } from './native-spawn';
import type { RuntimeOptions } from './execution-client';

export { resolveClaudeLauncher };
const exec = promisify(execFile);
const bridgePaths = [
  // Standalone SSH runner, packaged backend, then source checkout.
  new URL(`./${manifest.entry}`, import.meta.url),
  new URL(`./ssh-runner/${manifest.entry}`, import.meta.url),
  new URL(`../release/ssh-runner/${manifest.entry}`, import.meta.url),
];

export async function verifyClaudeBridge(file: string, expected: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isFile() && !info.isSymbolicLink() && info.size < 16 * 1024 * 1024 &&
      createHash('sha256').update(await readFile(file)).digest('hex') === expected) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error('The Mandala Claude ACP bridge is missing from this installation.'), {code: 'claude-bridge-missing'});
    }
  }
  throw Object.assign(new Error('The Mandala Claude ACP bridge failed integrity verification.'), {code: 'claude-bridge-integrity'});
}

export function claudeBridgeOptions(safeSystem?: boolean) {
  return {
    // The upstream external executable override defaults to argv. Both new and
    // resumed sessions must explicitly send MCP and settings in initialize.
    mcpServersDelivery: 'initialize', settingsDelivery: 'initialize',
    allowDangerouslySkipPermissions: false, promptSuggestions: false,
    env: {CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'},
    ...(safeSystem ? {tools: [], settingSources: [], persistSession: false, strictMcpConfig: true, settings: {disableAllHooks: true}, mcpServers: {}} : {}),
  };
}

export async function prepareClaudeBridge(options: RuntimeOptions, env: Record<string, string>) {
  const environment = {...process.env, ...env};
  const found = resolveClaudeLauncher(environment);
  if (found.state !== 'executable') {
    if (environment.CLAUDE_CODE_EXECUTABLE) {
      throw Object.assign(new Error('The configured Claude Code executable is not runnable. Correct or remove CLAUDE_CODE_EXECUTABLE in the execution environment.'), {code: 'claude-override-unavailable'});
    }
    throw new Error('Claude Code is not runnable on the selected execution machine.');
  }
  let missing: unknown;
  for (const url of bridgePaths) {
    const bridge = fileURLToPath(url);
    try { await verifyClaudeBridge(bridge, manifest.sha256); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'claude-bridge-missing') throw error;
      missing = error;
      continue;
    }
    const executable = await realpath(found.path);
    if (diagnoseNativeCli(executable, environment).state !== 'executable' || /\.(?:cmd|bat)$/i.test(executable)) {
      throw Object.assign(new Error('The selected Claude Code launcher cannot be used as a native SDK executable.'), {code: 'claude-version-incompatible'});
    }
    let version: string | undefined;
    try {
      const result = await exec(executable, ['--version'], {cwd: options.cwd, env: {...environment, NODE_OPTIONS: ''}, timeout: 5000, windowsHide: true, signal: options.signal, maxBuffer: 64 * 1024});
      version = result.stdout.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
    } catch {
      options.signal?.throwIfAborted();
      throw Object.assign(new Error('The selected Claude Code executable could not return its version.'), {code: 'claude-version-probe-failed'});
    }
    if (!version || version.localeCompare(manifest.minimumNativeVersion, 'en', {numeric: true}) < 0) {
      throw Object.assign(new Error(`The selected Claude Code must be ${manifest.minimumNativeVersion} or newer to pass MCP securely.`), {code: 'claude-version-incompatible'});
    }
    return {command: [process.execPath, bridge], env: {...env, CLAUDE_CODE_EXECUTABLE: executable, NODE_OPTIONS: '', MANDALA_CLAUDE_RESTRICTED: options.safeSystem ? '1' : '0'}, version};
  }
  throw missing;
}


export async function probeClaudeAccount(executable: string, options: RuntimeOptions): Promise<boolean | undefined> {
  let stdout: string | undefined;
  try {
    ({stdout} = await exec(executable, ['auth', 'status', '--json'], {
      cwd: options.cwd, env: {...process.env, ...options.env, NODE_OPTIONS: ''},
      timeout: 5000, windowsHide: true, signal: options.signal, maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    options.signal?.throwIfAborted();
    // Claude exits nonzero for a signed-out profile but still emits its JSON.
    const result = error as {code?: unknown; stdout?: string};
    if (result.code === 1) stdout = result.stdout;
  }
  if (stdout) {
    try {
      const value: unknown = JSON.parse(stdout)?.loggedIn;
      if (typeof value === 'boolean') return value;
    } catch { /* Unknown output cannot attest account state. */ }
  }
}
