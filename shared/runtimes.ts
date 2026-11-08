import type { Cli, Config, RuntimeConfig } from "./types";

export const runtimeIds = ['codex', 'omp', 'claude', 'gemini', 'opencode', 'codebuddy', 'pi', 'cursor', 'kimi', 'dsh', 'antigravity', 'grok', 'hermes', 'openclaw'] as const;
export const runtimeCatalog = {
  codex: { name: 'Codex', command: 'codex', args: ['app-server'], protocol: 'native', docs: 'https://developers.openai.com/codex/cli/' },
  omp: { name: 'OMP', command: 'omp', args: ['--mode=rpc'], protocol: 'native', docs: 'https://github.com/can1357/oh-my-pi' },
  claude: { name: 'Claude Code', command: 'claude-agent-acp', args: [], docs: 'https://github.com/agentclientprotocol/claude-agent-acp', protocol: 'acp' },
  gemini: { name: 'Gemini CLI', command: 'gemini', args: ['--acp'], docs: 'https://geminicli.com/docs/cli/acp-mode/', protocol: 'acp' },
  opencode: { name: 'OpenCode', command: 'opencode', args: ['acp'], docs: 'https://opencode.ai/docs/acp/', protocol: 'acp' },
  codebuddy: { name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'], protocol: 'acp', docs: 'https://www.codebuddy.ai/docs/cli/cli-reference' },
  pi: { name: 'Pi', command: 'pi', args: ['--mode=rpc'], protocol: 'rpc', docs: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent' },
  cursor: { name: 'Cursor Agent', command: 'agent', args: ['--print', '--output-format', 'stream-json'], protocol: 'stream', docs: 'https://cursor.com/docs/cli/overview' },
  kimi: { name: 'Kimi Code', command: 'kimi', args: ['acp'], protocol: 'acp', docs: 'https://moonshotai.github.io/kimi-code/' },
  dsh: { name: 'DSH', command: 'dsh', args: ['acp'], protocol: 'acp', docs: 'https://github.com/deepseek-ai/deepseek-harness' },
  antigravity: { name: 'Antigravity', command: 'agy', args: ['--print', '--output-format', 'stream-json'], protocol: 'stream', docs: 'https://antigravity.google/docs/getting-started?tab=cli' },
  grok: { name: 'Grok', command: 'grok', args: ['agent', '--no-leader', 'stdio'], protocol: 'acp', docs: 'https://docs.x.ai/build/cli/reference' },
  hermes: { name: 'Hermes Agent', command: 'hermes', args: ['acp'], protocol: 'acp', docs: 'https://hermes-agent.nousresearch.com/docs/' },
  openclaw: { name: 'OpenClaw', command: 'openclaw', args: ['acp'], protocol: 'acp', docs: 'https://docs.openclaw.ai/cli/acp' },
} as const;
export function isCli(value: unknown): value is Cli { return runtimeIds.includes(value as Cli); }
export function runtimeLabel(cli: Cli): string { return runtimeCatalog[cli].name; }
// A system transformation requires native tools to be disabled before launch.
export function supportsSystemTasks(cli:Cli):boolean { return ['codex','omp','claude','gemini','opencode','codebuddy','pi'].includes(cli); }
export function enabledRuntimes(config: Pick<Config, "runtimes"> & Partial<Pick<Config, "agents" | "system">>): Cli[] {
  // Missing legacy registration retains saved executor choices, never vendor defaults.
  return [...(config.runtimes ?? new Set([...(config.agents ?? []).filter(a => !a.archivedAt).map(a => a.defaultCli), ...(config.system ? [...(config.system.cli ? [config.system.cli] : []), ...Object.values(config.system.tasks ?? {}).map(task => task.cli)] : [])]))];
}

// Defined Agent fields override workspace defaults; environment references merge by key.
export function effectiveRuntime(cli: Cli, agent?: RuntimeConfig, defaults?: RuntimeConfig) {
  const current = agent?.[cli], base = defaults?.[cli];
  const approvalMode = current?.approvalMode ?? base?.approvalMode;
  return {
    ...((current?.gateway ?? base?.gateway) !== undefined ? { gateway: current?.gateway ?? base?.gateway } : {}),
    ...(cli === "codex" ? { fullAccess: current?.fullAccess ?? base?.fullAccess ?? true } : {}),
    args: [...(current?.args ?? base?.args ?? [])],
    env: { ...base?.env, ...current?.env },
    ...(approvalMode !== undefined ? { approvalMode } : {}),
  };
}
