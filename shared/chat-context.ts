import type { Agent, Config } from './types';
export function isSystemAgent(config: Config, agent: Agent | undefined): boolean {
  return !!agent && agent.id === config.mandala?.agentId && agent.systemRole === 'mandala';
}

export function projectAgentChoice(config: Config, projectId: string, currentAgentId: string, remembered: Record<string, string>): string {
  const project = config.projects.find(item => item.id === projectId);
  if (projectId && !project) return '';
  const valid = (id: string) => !id || config.agents.some(item => item.id === id && (isSystemAgent(config, item) || !item.systemRole && (!project || project.agentIds.includes(id))));
  if (Object.hasOwn(remembered, projectId) && valid(remembered[projectId])) return remembered[projectId];
  return valid(currentAgentId) ? currentAgentId : '';
}
