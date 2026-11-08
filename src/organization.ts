import { runtimeIds } from "../shared/runtimes";
import type { Cli } from "../shared/types";
import type { Config, Conversation, Task } from "../shared/types";
import type { WorkbenchExecution } from '../shared/workbench';

export type OrganizationFilters = { search: string; project: string; cli: string; activity: 'all' | 'active' | 'attention' };

export function filterOrganization(config: Config, filters: OrganizationFilters, executions: WorkbenchExecution[]) {
  const graph = organizationGraph(config), query = filters.search.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(query);
  const projects = config.projects.filter(p => !filters.project || filters.project === `project:${p.id}`);
  const active = executions.filter(e => (!filters.project || filters.project === `project:${e.projectId}` || filters.project === 'unassigned' && !e.projectId) &&
    (filters.activity !== 'attention' || e.state === 'approval' || e.state === 'unknown'));
  const agents = config.agents.filter(a => !a.systemRole && (!filters.cli || a.defaultCli === filters.cli) &&
    (filters.project === 'unassigned' ? !config.projects.some(p => p.agentIds.includes(a.id)) : !filters.project || projects.some(p => p.agentIds.includes(a.id))) &&
    (filters.activity === 'all' || active.some(e => e.agentId === a.id && (matches(a.name) || projects.some(p => p.id === e.projectId && matches(p.name))))) &&
    (matches(a.name) || projects.some(p => matches(p.name) && p.agentIds.includes(a.id))));
  const ids = new Set(agents.map(a => `agent:${a.id}`));
  for (const p of projects) {
    if (filters.project === 'unassigned' || filters.activity !== 'all' && !active.some(e => e.projectId === p.id)) continue;
    if (agents.some(a => p.agentIds.includes(a.id) && (matches(p.name) || matches(a.name))) || !filters.cli && filters.activity === 'all' && matches(p.name)) ids.add(`project:${p.id}`);
  }
  return { nodes: graph.nodes.filter(n => ids.has(n.id)), edges: graph.edges.filter(e => ids.has(`project:${e.projectId}`) && ids.has(`agent:${e.agentId}`)) };
}

export function organizationOrder(graph: ReturnType<typeof organizationGraph>) {
  let projects = graph.nodes.filter(n => n.kind === 'project'), agents = graph.nodes.filter(n => n.kind === 'agent');
  const neighbors = new Map(graph.nodes.map(n => [n.id, [] as string[]]));
  for (const e of graph.edges) { neighbors.get(`project:${e.projectId}`)?.push(`agent:${e.agentId}`); neighbors.get(`agent:${e.agentId}`)?.push(`project:${e.projectId}`); }
  const ordered = <T extends typeof graph.nodes[number]>(nodes: T[], opposite: typeof graph.nodes) => {
    const indices = new Map(opposite.map((n, i) => [n.id, i]));
    const score = (id: string) => { const values = neighbors.get(id)!.map(n => indices.get(n)!).filter(i => i !== undefined); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Infinity; };
    return [...nodes].sort((a, b) => score(a.id) - score(b.id));
  };
  // Alternating barycenter sweeps bring connected neighbors together, with stable ties.
  for (let i = 0; i < 4; i++) { agents = ordered(agents, projects); projects = ordered(projects, agents); }
  return [...projects, ...agents];
}

export function organizationGraph(config: Config, selected?: string | null) {
  const graph = {
    nodes: [...config.projects.map(p => ({ id: `project:${p.id}`, kind: "project" as const, identity: p })),
      ...config.agents.filter(a=>!a.systemRole).map(a => ({ id: `agent:${a.id}`, kind: "agent" as const, identity: a }))],
    edges: config.projects.flatMap(p => [...new Set(p.agentIds)].filter(id => config.agents.some(a => a.id === id && !a.systemRole))
      .map(agentId => ({ projectId: p.id, agentId }))),
  };
  if (!selected) return graph;
  const edges = graph.edges.filter(edge => selected === `project:${edge.projectId}` || selected === `agent:${edge.agentId}`);
  const ids = new Set([selected, ...edges.flatMap(edge => [`project:${edge.projectId}`, `agent:${edge.agentId}`])]);
  return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges };
}

export function agentActivity(id: string, conversations: Conversation[], tasks: Task[]) {
  const own = conversations.filter(c => c.agentId === id);
  const ids = new Set(own.map(c => c.id));
  const active = own.filter(c => c.status === "running" || c.status === "approval");
  return { conversations: own.length,
    received: tasks.filter(task => task.kind === "dispatch" && ids.has(task.targetConversationId)).length,
    running: Object.fromEntries(runtimeIds.map(cli=>[cli,active.filter(c=>c.cli===cli).length])) as Record<Cli,number>,
  };
}

// Disconnected teams share a canvas, but each keeps its own Project → Agent lanes.
export function organizationLayout(graph: ReturnType<typeof organizationGraph>, viewport: { width: number; height: number }, nodeWidth: number, nodeHeight = 76) {
  const rowHeight = nodeHeight + 4;
  const remaining = new Set(graph.nodes.map(n => n.id)), components: typeof graph[] = [];
  while (remaining.size) {
    const ids = new Set<string>(), pending = [remaining.values().next().value!];
    while (pending.length) {
      const id = pending.pop()!; if (!remaining.delete(id)) continue; ids.add(id);
      for (const edge of graph.edges) {
        const project = `project:${edge.projectId}`, agent = `agent:${edge.agentId}`;
        if (id === project && remaining.has(agent)) pending.push(agent);
        if (id === agent && remaining.has(project)) pending.push(project);
      }
    }
    components.push({ nodes: graph.nodes.filter(n => ids.has(n.id)), edges: graph.edges.filter(e => ids.has(`project:${e.projectId}`)) });
  }
  const groups = components.map(component => {
    const ordered = organizationOrder(component), projects = ordered.filter(n => n.kind === 'project'), agents = ordered.filter(n => n.kind === 'agent');
    const rows = Math.max(projects.length, agents.length), positions: Record<string, { x: number; y: number }> = {};
    for (const column of [projects, agents]) column.forEach((node, i) => { positions[node.id] = { x: node.kind === 'agent' && projects.length ? nodeWidth + 64 : 0, y: 32 + (rows - column.length) * rowHeight / 2 + i * rowHeight }; });
    return { positions, width: nodeWidth * (projects.length && agents.length ? 2 : 1) + (projects.length && agents.length ? 64 : 0), height: rows * rowHeight + 32, projects: projects.length, agents: agents.length };
  });
  const candidates = Array.from({ length: Math.max(1, Math.min(groups.length, 3)) }, (_, i) => {
    const columns = i + 1, columnWidth = Math.max(nodeWidth, ...groups.map(g => g.width)), bottoms = Array(columns).fill(0) as number[];
    const placed = groups.map(group => {
      const column = bottoms.indexOf(Math.min(...bottoms)), x = 24 + column * (columnWidth + 32), y = 16 + bottoms[column];
      bottoms[column] += group.height + 24;
      return { ...group, x, y };
    });
    const width = columns * (columnWidth + 32) + 16, height = Math.max(0, ...bottoms) + 16;
    const scale = Math.min(1, (viewport.width - 32) / width, (viewport.height - 32) / height);
    return { width, height, groups: placed, scale, positions: Object.assign({}, ...placed.map(group => Object.fromEntries(Object.entries(group.positions).map(([id, p]) => [id, { x: p.x + group.x, y: p.y + group.y }])))) as Record<string, { x: number; y: number }> };
  });
  return candidates.sort((a, b) => b.scale - a.scale || a.width - b.width)[0];
}
