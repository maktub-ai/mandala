import { effectiveRuntime, supportsSystemTasks } from "../shared/runtimes";
import type { Agent, Cli, RuntimeConfig } from "../shared/types";

const reservedEnv = new Set(["HOME", "CODEX_HOME", "OMP_PROFILE", "PI_CODING_AGENT_DIR", "NODE_OPTIONS"]);
export function validateRuntimeEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env))
    if (reservedEnv.has(key)) throw new Error(`Reserved runtime environment variable: ${key}`);
}

const reserved = {
  codex: new Set(["--config", "-c", "--stdio", "--listen", "--code-mode-host", "--help", "-h", "--version", "-V",
    "--ws-auth", "--ws-token-file", "--ws-token-sha256", "--ws-shared-secret-file", "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds"]),
  omp: new Set(["--config", "--mode", "--cwd", "--model", "--provider", "--api-key", "--profile", "--alias",
    "--system-prompt", "--append-system-prompt", "--add-dir", "--resume", "-r", "--continue", "-c", "--session-dir",
    "--no-session", "--from-claude", "--from-codex", "--plugin-dir", "--approval-mode", "--auto-approve", "--yolo",
    "--plan-yolo", "--plan-yolo-into", "--print", "-p", "--export", "--help", "-h", "--version", "-v"]),
};
const valued = {
  codex: new Set(["--enable", "--disable", "--profile", "-p"]),
  omp: new Set(["--thinking", "--service-tier", "--tools", "--skills", "--hook", "--extension", "-e", "--max-time",
    "--smol", "--slow", "--plan", "--prewalk-into", "--models"]),
};
export function validateRuntimeArgs(cli: Cli, args: string[]): void {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0")))
    throw new Error("Invalid CLI runtime arguments");
  if (cli !== "codex" && cli !== "omp") {
    if (args.length) throw new Error("ACP runtime arguments are managed by Mandala");
    return;
  }
  let expectsValue: string | undefined;
  for (const argument of args) {
    if (!argument.startsWith("-")) {
      if (!expectsValue) throw new Error("Runtime positional arguments are not allowed");
      if (!argument.trim()) throw new Error(`Missing value for runtime argument: ${expectsValue}`);
      expectsValue = undefined;
      continue;
    }
    if (expectsValue) throw new Error(`Missing value for runtime argument: ${expectsValue}`);
    const flag = argument.split("=", 1)[0];
    const short = flag.startsWith("--") ? flag : flag.slice(0, 2);
    if (flag === "--" || reserved[cli].has(flag) || reserved[cli].has(short))
      throw new Error(`Reserved ${cli} runtime argument: ${short}`);
    if (valued[cli].has(flag)) {
      if (!argument.includes("=")) expectsValue = flag;
      else if (!argument.slice(argument.indexOf("=") + 1).trim())
        throw new Error(`Missing value for runtime argument: ${flag}`);
    }
  }
  if (expectsValue) throw new Error(`Missing value for runtime argument: ${expectsValue}`);
}
export const configuredRuntime = effectiveRuntime;
export function resolveRuntime(cli: Cli, agent?: RuntimeConfig, defaults?: RuntimeConfig): { extraArgs: string[]; env: Record<string, string>; fullAccess?: boolean; gateway?: 'native' | 'unavailable' } {
  const runtime = configuredRuntime(cli, agent, defaults);
  if(runtime.gateway && runtime.gateway !== 'native')throw new Error('This model route is unavailable; select native CLI settings before continuing');
  validateRuntimeArgs(cli, runtime.args);
  validateRuntimeEnv(runtime.env);
  const env = Object.fromEntries(Object.entries(runtime.env).map(([key, reference]) => {
    const name = reference.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
    if (!name) throw new Error(`Invalid environment reference for: ${key}`);
    if (process.env[name] === undefined) throw new Error(`Missing environment variable: ${name}`);
    return [key, process.env[name]];
  }));
  return { extraArgs: runtime.args, env, ...(runtime.fullAccess !== undefined ? { fullAccess: runtime.fullAccess } : {}), ...(runtime.gateway !== undefined ? {gateway:runtime.gateway}: {}) };
}
// Managed coordinators inherit connection routing only; execution policy stays host-owned.
export function executionRuntimePolicy(cli: Cli, agent: Pick<Agent, 'systemRole'|'runtime'> | undefined, defaults?: RuntimeConfig): RuntimeConfig {
  const connection = defaults?.[cli];
  return { [cli]: configuredRuntime(cli, agent?.runtime,
    agent?.systemRole === 'mandala' ? { [cli]: { env: connection?.env, gateway: connection?.gateway } } : defaults) };
}
export function runtimeSignature(cli: Cli, agent?: RuntimeConfig, defaults?: RuntimeConfig): string {
  return JSON.stringify(configuredRuntime(cli, agent, defaults));
}
export function runtimeError(reason: string, stderr: string, env: Record<string, string> = {}): string {
  let detail = stderr.trim();
  for (const value of Object.values(env)) if (value) detail = detail.replaceAll(value, "[redacted]");
  return detail ? `${reason}: ${detail.slice(-4096)}` : reason;
}

// Background transformations inherit credential routing, never execution permissions or arguments.
export function systemRuntime(cli: Cli, defaults?: RuntimeConfig) {
  if(!supportsSystemTasks(cli))throw new Error(`${cli} cannot disable all tools; select another system task runtime`);
  const connection = defaults?.[cli];
  const resolved = resolveRuntime(cli, undefined, { [cli]: { env: connection?.env, gateway: connection?.gateway } });
  return { safeSystem: true, ...(connection?.env ? { env: resolved.env } : {}),
    ...(resolved.gateway !== undefined ? { gateway: resolved.gateway } : {}) };
}
