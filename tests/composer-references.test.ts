import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../server/store";
import { createSessionManager, type SessionManager } from "../server/sessions";
import type { Config } from "../shared/types";
import type { CodexClient, CodexOptions } from "../server/codex";
import { createMessageReference, listComposerReferences, resolveComposerReferences } from "../server/composer-references";
import { discoverNative } from "../server/capabilities";
import { DomainError } from "../shared/workspace-contracts";
import { createHash } from 'node:crypto';

vi.mock("../server/capabilities", async importOriginal => ({
  ...await importOriginal<typeof import("../server/capabilities")>(),
  discoverNative: vi.fn(async () => ({ mcp: [{ name: "reader", source: "native", path: "Native config" }], skills: [] })),
}));
let home: string, store: Store, manager: SessionManager, config: Config;
let turns: string[], instructions: string[], callbacks: CodexOptions;
const factory = async (options: CodexOptions): Promise<CodexClient> => {
  callbacks = options;
  return {
    getStatus: async () => ({ status: "ready", version: "fake" }), listModels: async () => [],
    startThread: async input => { instructions.push(input.instructions); return "native"; },
    resumeThread: async (_id, _mcp, text) => { instructions.push(text ?? ""); },
    startTurn: async (_id, text) => { turns.push(text); return "turn"; },
    interrupt: async () => {}, replyApproval: () => {}, close: () => {},
  };
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mana-references-"));
  const skill = (name: string, text: string) => {
    const path = join(home, name); mkdirSync(path); writeFileSync(join(path, "SKILL.md"), text); return path;
  };
  config = { version: 2, projects: [{ id: "p", name: "Project", cwd: home, agentIds: ["a"], resources: [],
    mcp: [{ name: "reader", transport: "stdio", command: "node", env: { SECRET: "never-expose" } }],
    skills: [{ name: "review", path: skill("project-review", "PROJECT SKILL EXACT BODY") }] }],
    agents: [{ id: "a", name: "Agent", instructions: "Be useful", defaultCli: "codex", models: {}, mcp: [],
      skills: [{ name: "review", path: skill("agent-review", "AGENT SHADOWED BODY") }] }] };
  turns = []; instructions = []; store = openStore(home);
  manager = createSessionManager(store, async () => config, factory, undefined, home);
});
afterEach(async () => { await manager.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
const args = (conversationId: string) => ({ home, store, manager, config, conversationId, principal: { userId: "local" } });

it("reads managed skill content directly and invalidates a selection when its content changes or assignment pauses", async () => {
  config.projects[0].skills = [];
  config.agents[0].skills = [];
  config.agents[0].skillIds = ["managed-review"];
  const header = "---\nname: review\ndescription: Review changes\n---\n";
  config.skillLibrary = [{ id: "managed-review", name: "review", path: "", content: header + "SYSTEM MANAGED BODY" }];
  const c = await manager.create("p", "a");
  const item = (await listComposerReferences(args(c.id))).find(i => i.kind === "skill")!;
  expect(item).toMatchObject({ name: "review", status: "available", detail: "System skill library" });
  const resolved = await resolveComposerReferences(args(c.id), [{ id: item.id }]);
  expect(resolved.context).toContain("SYSTEM MANAGED BODY");
  config.skillLibrary[0].content = header + "UPDATED SYSTEM BODY";
  await expect(resolveComposerReferences(args(c.id), [{ id: item.id }])).rejects.toThrow("Reference changed");
  const changed = (await listComposerReferences(args(c.id))).find(i => i.kind === "skill")!;
  expect(changed.id).not.toBe(item.id);
  config.agents[0].disabledSkillIds = ["managed-review"];
  expect((await listComposerReferences(args(c.id))).filter(i => i.kind === "skill")).toEqual([]);
  await expect(resolveComposerReferences(args(c.id), [{ id: changed.id }])).rejects.toThrow("Reference changed");
});

it("resolves Project > Agent > native, identifies exact sources, and never exports MCP secrets", async () => {
  const c = await manager.create("p", "a");
  const items = await listComposerReferences(args(c.id));
  expect(items.filter(item => item.name === "review")).toHaveLength(1);
  expect(items.find(item => item.name === "review")).toMatchObject({ kind: "skill", source: "Project · Project", status: "available" });
  expect(items.find(item => item.name === "reader")).toMatchObject({ kind: "mcp", source: "Project · Project", status: "unverified" });
  expect(JSON.stringify(items)).not.toContain("never-expose");
  const resolved = await resolveComposerReferences(args(c.id), items.map(({ id }) => ({ id })));
  expect(resolved.context).toContain("PROJECT SKILL EXACT BODY");
  expect(resolved.context).not.toContain("AGENT SHADOWED BODY");
  expect(resolved.context).toContain("explicitly requested");
  expect(resolved.context).toContain('"serverName":"reader"');
  expect(resolved.context).toContain("does not grant");
  expect(resolved.context).not.toContain("never-expose");
});

it("rejects forged, stale, removed, unreadable and unavailable selections", async () => {
  const c = await manager.create("p", "a"); const item = (await listComposerReferences(args(c.id))).find(i => i.kind === "skill")!;
  await expect(resolveComposerReferences(args(c.id), [{ id: "../../private" }])).rejects.toThrow();
  writeFileSync(join(config.projects[0].skills[0].path, "SKILL.md"), "CHANGED BODY");
  await expect(resolveComposerReferences(args(c.id), [{ id: item.id }])).rejects.toThrow("Reference changed");
  const changed = (await listComposerReferences(args(c.id))).find(i => i.kind === "skill")!;
  rmSync(config.projects[0].skills[0].path, { recursive: true });
  await expect(resolveComposerReferences(args(c.id), [{ id: changed.id }])).rejects.toThrow();
  await expect(resolveComposerReferences(args(c.id), [{ id: changed.id, path: "/private" } as any])).rejects.toThrow();
  expect(turns).toEqual([]);
});

it("filters tasks to the actual Agent scope and references exact context without starting tasks", async () => {
  const c = await manager.create("p", "a");
  const task = manager.taskService.createTask({ userId: "local" }, { goal: "Review unique result", projectId: "p", assigneeAgentId: "a", criteria: [{ id: "check", text: "Verify result", checkRef: null }] }, "visible");
  const other = manager.taskService.createTask({ userId: "local" }, { goal: "Private other Agent", projectId: "p", assigneeAgentId: "b" }, "other");
  const foreign = manager.taskService.createTask({ userId: "someone-else" }, { goal: "Other owner", assigneeAgentId: "a" }, "foreign");
  const items = await listComposerReferences(args(c.id));
  expect(items.filter(i => i.kind === "task")).toHaveLength(1);
  const chosen = items.find(i => i.kind === "task")!;
  const resolved = await resolveComposerReferences(args(c.id), [{ id: chosen.id }]);
  expect(resolved.context).toContain(task.id); expect(resolved.context).toContain("Verify result");
  expect(resolved.context).not.toContain(other.id); expect(resolved.context).not.toContain(foreign.id);
  expect(resolved.context).toContain("does not start");
  expect(manager.taskService.listRuns({ userId: "local" }, task.id)).toEqual([]);
});

it("offers an inquiry to a peer conversation without forwarding its private history or starting work", async () => {
  config.agents.push({id:'b',name:'Reviewer',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]});
  config.projects[0].agentIds.push('b');
  const source=await manager.create('p','a'),target=await manager.create('p','b');
  store.appendEvent(target.id,'user',{text:'PRIVATE TARGET TRANSCRIPT'});
  store.renameConversation(target.id,'Reviewer discussion');
  const input=args(source.id),items=await listComposerReferences(input);
  const inquiry=items.find(item=>item.kind==='chat'&&item.objectId===target.id&&item.intent==='inquiry');
  expect(inquiry).toBeDefined();
  expect(items.some(item=>item.kind==='chat'&&item.objectId===target.id&&item.intent!=='inquiry')).toBe(false);
  const resolved=await resolveComposerReferences(input,[{id:inquiry!.id}]);
  expect(resolved.context).toContain('message_ask');
  expect(resolved.context).toContain(target.id);
  expect(resolved.context).not.toContain('PRIVATE TARGET TRANSCRIPT');
  expect(store.listEvents(target.id,0).filter(event=>event.kind==='user')).toHaveLength(1);
  expect(manager.taskService.listTasks({userId:'local'})).toEqual([]);
  config.projects[0].agentIds=['a'];
  await expect(resolveComposerReferences(input,[{id:inquiry!.id}])).rejects.toThrow('Reference changed');
});

it("keeps read and inquiry IDs distinct and rejects an archived inquiry target", async () => {
  const source=await manager.create('p','a'),target=await manager.create('p','a'),input=args(source.id);
  const items=(await listComposerReferences(input)).filter(item=>item.kind==='chat'&&item.objectId===target.id);
  expect(items).toHaveLength(2);
  expect(new Set(items.map(item=>item.id)).size).toBe(2);
  expect((await listComposerReferences(input)).some(item=>item.objectId===source.id&&item.intent==='inquiry')).toBe(false);
  const inquiry=items.find(item=>item.intent==='inquiry')!;
  store.archiveConversation(target.id,true);
  await expect(resolveComposerReferences(input,[{id:inquiry.id}])).rejects.toThrow('Reference changed');
});

it("does not offer or resolve an inquiry to a conversation in another project",async()=>{
  config.agents.push({id:'b',name:'Reviewer',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]});config.projects[0].agentIds.push('b');
  config.projects.push({...config.projects[0],id:'q',name:'Other project',agentIds:['b']});
  const source=await manager.create('p','a'),target=await manager.create('q','b'),input=args(source.id);
  expect((await listComposerReferences(input)).some(item=>item.objectId===target.id&&item.intent==='inquiry')).toBe(false);
  const forged='chat:'+createHash('sha256').update(JSON.stringify({id:target.id,intent:'inquiry'})).digest('hex');
  await expect(resolveComposerReferences(input,[{id:forged}])).rejects.toThrow('Reference changed');
});

it("passes exact reference content to the native turn while persisting readable user text and identity", async () => {
  config.projects[0].mcp = [];
  const c = await manager.create("p", "a"); const item = (await manager.listComposerReferences(c.id)).find(i => i.kind === "skill")!;
  await manager.send(c.id, "Please review", [], [{ id: item.id }]);
  expect(turns[0]).toContain("PROJECT SKILL EXACT BODY");
  expect(turns[0]).toContain(config.projects[0].skills[0].path);
  expect(store.listEvents(c.id, 0).find(e => e.kind === "user")?.data).toMatchObject({ text: "Please review", references: [{ id: item.id }] });
  expect(instructions.join("\n")).not.toContain("PROJECT SKILL EXACT BODY");
  callbacks.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
  await manager.send(c.id, "Next turn"); expect(turns.at(-1)).toBe("Next turn");
});

it("stores only exact reference selections in queued input and rejects a changed skill before submission", async () => {
  config.projects[0].mcp = [];
  const c = await manager.create("p", "a"); const item = (await manager.listComposerReferences(c.id)).find(i => i.kind === "skill")!;
  await manager.send(c.id, "First turn");
  const queued = await manager.enqueueUserInput(c.id, "Queued review", "queued", [], [{ id: item.id }]);
  expect(queued).toMatchObject({ text: "Queued review", references: [{ id: item.id }] });
  expect(JSON.stringify(queued)).not.toContain("PROJECT SKILL EXACT BODY");
  writeFileSync(join(config.projects[0].skills[0].path, "SKILL.md"), "REPLACED");
  callbacks.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
  await vi.waitFor(() => expect(store.listEvents(c.id, 0).some(e => e.kind === "error" && String((e.data as any).message).includes("Reference changed"))).toBe(true));
  expect(turns).toEqual(["First turn"]);
  expect(manager.listUserInputs(c.id).find(input => input.id === queued.id)?.state).toBe("cancelled");
});

it("rejects disabled native MCPs without enabling their configuration", async () => {
  vi.mocked(discoverNative).mockResolvedValueOnce({ mcp: [{ name: "disabled-reader", source: "native", path: "Native config", enabled: false }], skills: [] });
  const c = await manager.create("p", "a"); const item = (await manager.listComposerReferences(c.id)).find(i => i.name === "disabled-reader")!;
  expect(item.status).toBe("disabled");
  vi.mocked(discoverNative).mockResolvedValueOnce({ mcp: [{ name: "disabled-reader", source: "native", path: "Native config", enabled: false }], skills: [] });
  await expect(manager.send(c.id, "Use disabled MCP", [], [{ id: item.id }])).rejects.toThrow("Reference changed");
  expect(turns).toEqual([]);
});

it("keeps pre-conversation catalog identities usable after conversation creation", async () => {
  config.projects[0].mcp = [];
  const items = await manager.listComposerReferences(undefined, { projectId: "p", agentId: "a", cli: "codex" });
  const item = items.find(i => i.kind === "skill")!;
  const c = await manager.create("p", "a"); await manager.send(c.id, "", [], [{ id: item.id }]);
  expect(turns[0]).toContain("PROJECT SKILL EXACT BODY");
});

it("rejects task access revoked during native preparation before model submission", async () => {
  config.projects[0].mcp = []; config.projects[0].skills = []; config.agents[0].skills = [];
  const c = await manager.create("p", "a"); const task = manager.taskService.createTask({ userId: "local" }, { goal: "Revoked during preparation", projectId: "p", assigneeAgentId: "a" }, "revoked");
  const item = (await manager.listComposerReferences(c.id)).find(i => i.kind === "task")!;
  await manager.close();
  manager = createSessionManager(store, async () => config, async options => {
    const client = await factory(options);
    return { ...client, startThread: async input => {
      manager.taskService.updateTask({ userId: "local" }, task.id, task.revision, { assigneeAgentId: "b" }, "revoke");
      return client.startThread(input);
    } };
  }, undefined, home);
  await expect(manager.send(c.id, "Use task", [], [{ id: item.id }])).rejects.toThrow("Reference changed");
  expect(turns).toEqual([]);
});

it("excludes tasks whose run content is no longer readable, even with a known catalog identity", async () => {
  const c = await manager.create("p", "a");
  const task = manager.taskService.createTask({ userId: "local" }, { goal: "Protected run result", projectId: "p", assigneeAgentId: "a" }, "protected");
  const chosen = (await manager.listComposerReferences(c.id)).find(item => item.kind === "task")!;
  const original = manager.taskService.listRuns;
  vi.spyOn(manager.taskService, "listRuns").mockImplementation((principal, id) => {
    if (id === task.id) throw new DomainError("forbidden", 403, "Run content revoked");
    return original(principal, id);
  });
  expect((await manager.listComposerReferences(c.id)).some(item => item.name === "Protected run result")).toBe(false);
  await expect(resolveComposerReferences(args(c.id), [{ id: chosen.id }])).rejects.toThrow("Reference changed");
  expect(turns).toEqual([]);
});

it("rejects a known native MCP reference when its effective configuration fingerprint changes", async () => {
  config.projects[0].mcp = [];
  const c = await manager.create("p", "a");
  vi.mocked(discoverNative).mockResolvedValueOnce({ mcp: [{ name: "native-reader", source: "native", path: "Native config", configurationFingerprint: "a".repeat(64) }], skills: [] });
  const chosen = (await manager.listComposerReferences(c.id)).find(item => item.name === "native-reader")!;
  vi.mocked(discoverNative).mockResolvedValueOnce({ mcp: [{ name: "native-reader", source: "native", path: "Native config", configurationFingerprint: "b".repeat(64) }], skills: [] });
  await expect(resolveComposerReferences(args(c.id), [{ id: chosen.id }])).rejects.toThrow("Reference changed");
  expect(turns).toEqual([]);
});

it('offers only other project Agents and rejects mentions after membership changes', async () => {
  config.agents.push({...config.agents[0], id:'peer', name:'Reviewer', instructions:'Review carefully'}, {...config.agents[0], id:'outside', name:'Outside'});
  config.projects[0].agentIds.push('peer');
  const c = await manager.create('p','a');
  const items = (await listComposerReferences(args(c.id))).filter(item=>item.kind==='agent');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({name:'Reviewer',kind:'agent'});
  const resolved = await resolveComposerReferences(args(c.id),[{id:items[0].id}]);
  expect(resolved.context).toContain('peer');
  expect(resolved.context).toContain('delegate');
  config.projects[0].agentIds = ['a'];
  await expect(resolveComposerReferences(args(c.id),[{id:items[0].id}])).rejects.toThrow('Reference changed');
});

it('keeps task creation as selected context until the user sends it to the Agent', async () => {
 config.projects[0].mcp = [];
 const c = await manager.create('p', 'a');
 const item = (await listComposerReferences(args(c.id))).find(item=>item.source==='/task');
 expect(item).toBeDefined();
 expect(manager.taskService.listTasks({userId:'local'})).toEqual([]);
 expect(turns).toEqual([]);
 await manager.send(c.id, 'Investigate missing workspace files', [], [{id:item!.id}]);
 expect(turns.at(-1)).toContain('Investigate missing workspace files');
 expect(turns.at(-1)).toContain('Create a Mandala task');
 expect(turns.at(-1)).toContain(c.id);
 expect(manager.taskService.listTasks({userId:'local'})).toEqual([]);
});

it('keeps object identities stable while Mandala references cross-project control metadata without permissions or private output',async()=>{
 const main={...config.agents[0],id:'main',name:'Mandala',systemRole:'mandala' as const};config.agents.push(main,{...config.agents[0],id:'peer',name:'Peer',instructions:'PRIVATE SOUL'});
 config.mandala={agentId:'main',name:'Mandala',soul:'',runtime:'codex',maxParallel:3} as any;
 config.projects.push({...config.projects[0],id:'q',name:'Other',agentIds:['peer']});config.projects[0].agentIds.push('peer');
 const c=store.createConversation({projectId:'',agentId:'main',cli:'codex',model:null,purpose:'mandala-main'});
 const task=manager.taskService.createTask({userId:'local'},{goal:'Unowned goal',projectId:'q',assigneeAgentId:'peer'},'cross');
 const foreign=manager.taskService.createTask({userId:'foreign'},{goal:'SECRET OWNER',projectId:'q',assigneeAgentId:'peer'},'foreign');
 const first=await listComposerReferences(args(c.id)),peer=first.find(i=>i.kind==='agent'&&i.name==='Peer')!,chosen=first.find(i=>i.kind==='task'&&i.name==='Unowned goal')!;
 expect(peer).toBeDefined();expect(chosen).toBeDefined();expect(first.filter(i=>i.kind==='project')).toHaveLength(2);
 expect(first.filter(i=>i.kind==='agent'&&i.name==='Peer')).toHaveLength(1);
 config.agents.find(a=>a.id==='peer')!.name='Renamed';
 const resolved=await resolveComposerReferences(args(c.id),[{id:peer.id},{id:chosen.id}]);
 expect(resolved.context).toContain('Renamed');expect(resolved.context).not.toContain('PRIVATE SOUL');expect(resolved.context).not.toContain(foreign.id);
 expect(manager.coordination.list()).toEqual([]);expect(manager.taskService.getTask({userId:'local'},task.id).participantAgentIds).toEqual([]);
 expect(()=>manager.taskService.getTask({userId:'local',agentId:'main'},task.id)).toThrow();
 config.agents.find(a=>a.id==='main')!.systemRole=undefined;
 await expect(resolveComposerReferences(args(c.id),[{id:chosen.id}])).rejects.toThrow();
});

it('forwards only the exact public message selection, rechecks resources, and rejects hidden or superseded content',async()=>{
 const source=await manager.create('p','a'),destination=await manager.create('p','a');
 const visible=store.appendEvent(source.id,'text',{text:'Public first. Exact selected 中文. Public last.',itemId:'answer'});
 const hidden=store.appendEvent(source.id,'tool',{method:'item/completed',params:{item:{id:'secret',type:'reasoning',text:'SECRET ANALYSIS'}}});
 const selected=await createMessageReference(args(destination.id),{sourceConversationId:source.id,eventId:visible.id,text:'Exact selected 中文.'});
 expect(selected.kind).toBe('message');expect(selected.detail).toBe('Exact selected 中文.');
 const resolved=await resolveComposerReferences(args(destination.id),[{id:selected.id}]);
 expect(resolved.context).toContain('Exact selected 中文.');expect(resolved.context).not.toContain('Public first');expect(resolved.context).not.toContain('Public last');
 await expect(createMessageReference(args(destination.id),{sourceConversationId:source.id,eventId:hidden.id,text:'SECRET ANALYSIS'})).rejects.toThrow();
 await expect(createMessageReference(args(destination.id),{sourceConversationId:destination.id,eventId:visible.id,text:'Exact selected 中文.'})).rejects.toThrow();
 await expect(createMessageReference(args(destination.id),{sourceConversationId:source.id,eventId:visible.id,text:'forged'})).rejects.toThrow();
 vi.spyOn(manager,'authorizeConversationReference').mockImplementation(()=>{throw new DomainError('forbidden',403,'Private resource');});
 await expect(resolveComposerReferences(args(destination.id),[{id:selected.id}])).rejects.toThrow('Private resource');
 vi.mocked(manager.authorizeConversationReference).mockRestore();
 store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(visible.id);
 await expect(resolveComposerReferences(args(destination.id),[{id:selected.id}])).rejects.toThrow();
 expect(turns).toEqual([]);
});

it('preserves a visible selection spanning Markdown formatting without forwarding surrounding content',async()=>{
 const source=await manager.create('p','a'),destination=await manager.create('p','a');
 const event=store.appendEvent(source.id,'text',{text:'Before **selected** words after.',itemId:'formatted'});
 const item=await createMessageReference(args(destination.id),{sourceConversationId:source.id,eventId:event.id,text:'selected words'});
 const resolved=await resolveComposerReferences(args(destination.id),[{id:item.id}]);
 expect(item.detail).toBe('selected words');expect(resolved.context).not.toContain('Before');expect(resolved.context).not.toContain('after.');
});
