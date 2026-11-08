import type { Cli, CliStatus, Config } from '../shared/types';
import { enabledRuntimes, runtimeCatalog, runtimeIds } from '../shared/runtimes';
import { api } from './api';

type Saved = { config: Config; revision: string };
export type RuntimeProbe = CliStatus | null | undefined; // undefined: checking, null: the check itself failed

/** Asking for a URL flag reopens the first-use guide on demand, independent of existing data. */
export const welcomeRequested = (route: string) => {
  const [path, query = ''] = route.split('?');
  return path === '/' && new URLSearchParams(query).get('welcome') === '1';
};

/** Native sign-in happens in each CLI; these are the commands users actually type. */
export function loginCommand(cli: Cli): string {
  const known: Partial<Record<Cli, string>> = { codex: 'codex login', claude: 'claude', gemini: 'gemini', cursor: 'agent login', kimi: 'kimi', opencode: 'opencode auth login' };
  return known[cli] ?? runtimeCatalog[cli].command;
}

/** Probes every runtime with bounded concurrency so a slow CLI never hides the fast ones. */
export function scanRuntimes(onResult: (cli: Cli, status: RuntimeProbe, error?: string) => void, preferred: Cli[] = [], concurrency = 4) {
  let cancelled = false;
  const queue = [...new Set([...preferred, ...runtimeIds])];
  const next = async (): Promise<void> => {
    const cli = queue.shift();
    if (!cli || cancelled) return;
    try {
      const status = await api<CliStatus>('/cli/status?scope=runtime&cli=' + cli);
      if (!cancelled) onResult(cli, status);
    } catch (reason) {
      if (!cancelled) onResult(cli, null, (reason as Error).message);
    }
    return next();
  };
  void Promise.all(Array.from({ length: concurrency }, next));
  return () => { cancelled = true; };
}

/** Enables the chosen runtime (if needed) and makes it Mandala's runtime, so the first message can run. */
export async function adoptRuntime(cli: Cli, forMandala: boolean): Promise<Saved> {
  let current = await api<Saved>('/config');
  if (!current.config.runtimes?.includes(cli)) {
    // Legacy executors are real configuration; the automatically created coordinator is not a registration.
    const registered = enabledRuntimes({...current.config,agents:current.config.agents.filter(agent => !agent.systemRole || agent.id === current.config.mandala?.agentId)});
    await api('/config', 'PUT', { revision: current.revision, config: { ...current.config, runtimes: [...new Set([...registered, cli])] } });
    current = await api<Saved>('/config');
  }
  const mandala = current.config.agents.find(agent => agent.id === current.config.mandala?.agentId);
  if (forMandala && current.config.mandala && mandala && mandala.defaultCli !== cli)
    current = await api<Saved>('/mandala', 'PUT', { revision: current.revision, settings: { name: mandala.name, soul: current.config.mandala.soul, cli, models: mandala.models, maxParallel: current.config.mandala.maxParallel } });
  return current;
}
