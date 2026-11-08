import { expect, it } from "vitest";
import { organizationGraph, agentActivity, filterOrganization, organizationOrder, organizationLayout } from "../src/organization";
import type { Config, Conversation, Task } from "../shared/types";
const config: Config = { version: 2,
  projects: ["one", "two"].map(id => ({ id, name: id, cwd: "/tmp", agentIds: ["shared"], resources: [], mcp: [], skills: [] })),
  agents: ["shared", "unlinked"].map(id => ({ id, name: id, instructions: "", defaultCli: "omp", models: {}, mcp: [], skills: [] })),
};
it("represents a shared Agent once and includes unassociated identities", () => {
  const graph = organizationGraph(config);
  expect(graph.nodes.map(n => n.id)).toEqual(["project:one", "project:two", "agent:shared", "agent:unlinked"]);
  expect(graph.edges).toEqual([{ projectId: "one", agentId: "shared" }, { projectId: "two", agentId: "shared" }]);
});
it("separates default CLI from actual running conversations and counts dispatch receipts accurately", () => {
  const chats = [{ id: "c1", agentId: "shared", cli: "codex", status: "running" },
    { id: "c2", agentId: "shared", cli: "omp", status: "approval" },
    { id: "c3", agentId: "shared", cli: "omp", status: "idle" },
    { id: "other", agentId: "unlinked", cli: "omp", status: "running" }] as Conversation[];
  const tasks = [{ kind: "dispatch", targetConversationId: "c1" }, { kind: "dispatch", targetConversationId: "c3" },
    { kind: "return", targetConversationId: "c2" }, { kind: "dispatch", targetConversationId: "other" }] as Task[];
  expect(agentActivity("shared", chats, tasks)).toEqual({ conversations: 3, received: 2, running: { codex: 1, omp: 1, claude: 0, gemini: 0, opencode: 0, codebuddy:0,pi:0,cursor:0,kimi:0,dsh:0,antigravity:0,grok:0,hermes:0,openclaw:0 } });
});

it('counts ACP conversations under their actual runtime',()=>{
 const chats=[{id:'g',agentId:'a',cli:'gemini',status:'running'}] as Conversation[];
 expect(agentActivity('a',chats,[]).running.gemini).toBe(1);
});

it('filters focused graphs to direct relations only',()=>{
 const graph=organizationGraph(config,'project:one');
 expect(graph.nodes.map(n=>n.id)).toEqual(['project:one','agent:shared']);
 expect(graph.edges).toEqual([{projectId:'one',agentId:'shared'}]);
 expect(organizationGraph(config,'agent:unlinked').nodes.map(n=>n.id)).toEqual(['agent:unlinked']);
});

it('combines project, CLI and search filters without pulling in unrelated projects through shared agents', () => {
 const c = structuredClone(config); c.agents[0].name = 'Shared builder'; c.agents[1].defaultCli = 'codex';
 expect(filterOrganization(c, { search: 'builder', project: 'project:two', cli: 'omp', activity: 'all' }, []).nodes.map(n => n.id))
  .toEqual(['project:two', 'agent:shared']);
 expect(filterOrganization(c, { search: '', project: '', cli: 'codex', activity: 'all' }, []).nodes.map(n => n.id)).toEqual(['agent:unlinked']);
 expect(filterOrganization(c, { search: 'two', project: '', cli: '', activity: 'all' }, []).nodes.map(n => n.id)).toEqual(['project:two', 'agent:shared']);
});

it('keeps ungrouped agents and empty projects findable and filters active work by actual runtime snapshots', () => {
 const c = structuredClone(config); c.projects.push({ ...c.projects[0], id: 'empty', name: 'Empty', agentIds: [] });
 const base = { search: '', project: '', cli: '', activity: 'all' } as const;
 expect(filterOrganization(c, { ...base, project: 'unassigned' }, []).nodes.map(n => n.id)).toEqual(['agent:unlinked']);
 expect(filterOrganization(c, { ...base, search: 'empty' }, []).nodes.map(n => n.id)).toEqual(['project:empty']);
 const execution = { agentId: 'shared', projectId: 'two', state: 'approval' } as any;
 expect(filterOrganization(c, { ...base, activity: 'attention' }, [execution]).nodes.map(n => n.id)).toEqual(['project:two', 'agent:shared']);
 expect(filterOrganization(c, { ...base, activity: 'active' }, []).nodes).toEqual([]);
 expect(filterOrganization(c, { ...base, search: 'one', activity: 'active' }, [execution]).nodes).toEqual([]);
});

it('orders related nodes together to remove avoidable crossings without mutating config', () => {
 const c = structuredClone(config);
 c.projects = ['a', 'b', 'c'].map((id, i) => ({ ...c.projects[0], id, agentIds: ['z', 'y', 'x'].slice(i, i + 1) }));
 c.agents = ['x', 'y', 'z'].map(id => ({ ...c.agents[0], id }));
 const before = structuredClone(c), ordered = organizationOrder(organizationGraph(c));
 const projects = ordered.filter(n => n.kind === 'project').map(n => n.identity.id);
 const agents = ordered.filter(n => n.kind === 'agent').map(n => n.identity.id);
 expect(c).toEqual(before);
 expect(agents).toEqual(projects.map(id => c.projects.find(p => p.id === id)!.agentIds[0]));
 expect(organizationOrder(organizationGraph(c)).map(n => n.id)).toEqual(ordered.map(n => n.id));
});

it('packs disconnected teams to fit the viewport while preserving typed lanes and shared Agent identity',()=>{
 const c=structuredClone(config);
 c.projects=['a','b','c'].map(id=>({...config.projects[0],id,agentIds:Array.from({length:6},(_,i)=>id+i)}));
 c.agents=c.projects.flatMap(p=>p.agentIds.map(id=>({...config.agents[0],id})));
 c.projects[1].agentIds.push('b0');
 const graph=organizationGraph(c),wide=organizationLayout(graph,{width:1100,height:700},232),tall=organizationLayout(graph,{width:500,height:1600},232);
 expect(Object.keys(wide.positions).sort()).toEqual(graph.nodes.map(n=>n.id).sort());
 expect(wide.height).toBeLessThan(tall.height);
 for(const edge of graph.edges)expect(wide.positions['project:'+edge.projectId].x+232).toBeLessThan(wide.positions['agent:'+edge.agentId].x);
 const points=Object.values(wide.positions);
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)expect(Math.abs(points[i].x-points[j].x)>=232||Math.abs(points[i].y-points[j].y)>=64).toBe(true);
});

it('keeps taller execution-state nodes and their column headings separated', () => {
 const graph = organizationGraph(config);
 const layout = organizationLayout(graph, { width: 1100, height: 700 }, 232, 108);
 const points = Object.values(layout.positions);
 for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
  expect(Math.abs(points[i].x - points[j].x) >= 232 || Math.abs(points[i].y - points[j].y) >= 108).toBe(true);
 }
});


it('omits system identities and legacy membership edges while keeping actual activity attribution',()=>{
 const c=structuredClone(config);c.agents.push({...c.agents[0],id:'system',systemRole:'mandala'});c.projects[0].agentIds.push('system');
 const graph=organizationGraph(c);expect(graph.nodes.some(n=>n.id==='agent:system')).toBe(false);expect(graph.edges.some(e=>e.agentId==='system')).toBe(false);
 expect(agentActivity('system',[{id:'actual',agentId:'system',cli:'codex',status:'running'}] as Conversation[],[]).running.codex).toBe(1);
});
