import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../server/store";
import { createSessionManager, type SessionManager } from "../server/sessions";
import type { CodexClient, CodexOptions } from "../server/codex";
import type { OmpOptions } from "../server/omp";
import type { Config } from "../shared/types";

let home: string, store: Store, manager: SessionManager | undefined;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mana-managed-session-")); store = openStore(home); });
afterEach(async () => { await manager?.close(); store.close(); await rm(home, { recursive: true, force: true }); });

it.each(["codex", "omp"] as const)("hands %s the current managed skill body, then removes paused assignments on the next turn", async cli => {
  const original = "---\nname: review\ndescription: Review changes\n---\nOriginal instructions.";
  const config: Config = { version: 2,
    projects: [{ id: "p", name: "Project", cwd: home, agentIds: ["a"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "a", name: "Reviewer", defaultCli: cli, instructions: "", models: {}, mcp: [], skills: [], skillIds: ["review"], connectionIds: ["docs"] }],
    skillLibrary: [{ id: "review", name: "review", path: "", content: original }],
    connections: [{ id: "docs", name: "docs", transport: "http", url: "https://example.test/mcp" }],
  };
  let callbacks: CodexOptions, sequence = 0;
  const received: (string | null)[] = [];
  const mcpConfigurations: string[][] = [];
  const factory = async (options: OmpOptions): Promise<CodexClient> => {
    callbacks = options;
    let skillRoot = options.pluginDir ? join(options.pluginDir, "skills") : "";
    return {
      getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
      setSkillRoots: async roots => { skillRoot = roots[0] ?? ""; },
      startThread: async input => { mcpConfigurations.push((input.mcp ?? []).map(item => item.name)); return "native-managed"; },
      resumeThread: async (_id, mcp) => { mcpConfigurations.push((mcp ?? []).map(item => item.name)); },
      startTurn: async () => {
        received.push(skillRoot ? await readFile(join(skillRoot, "review", "SKILL.md"), "utf8").catch(() => null) : null);
        return `turn-${++sequence}`;
      },
      interrupt: async () => {}, replyApproval: () => {}, close: () => {},
    };
  };
  manager = createSessionManager(store, async () => structuredClone(config), factory, factory, home);
  const conversation = await manager.create("p", "a");
  const send = async () => {
    await manager!.send(conversation.id, "Review the changes");
    callbacks.onEvent({ method: "turn/completed", params: { threadId: "native-managed", turn: { id: `turn-${sequence}`, status: "completed" } } });
    await expect.poll(() => store.getConversation(conversation.id)?.status).toBe("idle");
  };
  await send();
  expect(received).toEqual([original]);
  config.skillLibrary![0].content = original + "\nUpdated instructions.";
  await send();
  expect(received.at(-1)).toContain("Updated instructions.");
  config.agents[0].disabledSkillIds = ["review"];
  config.agents[0].disabledConnectionIds = ["docs"];
  await send();
  expect(received).toEqual([original, original + "\nUpdated instructions.", null]);
  if (cli === "codex") expect(mcpConfigurations.at(-1)).toEqual([]);
  else {
    // OMP receives connections through the isolated plugin rather than resume arguments.
    await expect(readFile(join(home, "runtime", conversation.id, "mcp.json"), "utf8")).rejects.toThrow();
  }
  expect(config.agents[0].skillIds).toEqual(["review"]);
  expect(config.skillLibrary).toHaveLength(1);
});
it.each(['inline','project'] as const)('native handoff uses only the effective %s Skill identity for a same-name collision',async mode=>{
 const {readConfig,writeConfig}=await import('../server/config');const content='---\nname: review\ndescription: Review changes\n---\n';const initial=await readConfig(home);
 await writeConfig(home,{version:2,projects:[{id:'p',name:'p',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[],skillIds:mode==='project'?['project-review']:[]}],agents:[{id:'a',name:'a',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[],skillIds:mode==='project'?['agent-review']:[]}],skillLibrary:[{id:'agent-review',name:'review',path:'',content:content+'Agent body'},{id:'project-review',name:'review',path:'',content:content+'Project body'}]},initial.revision);
 const config=(await readConfig(home)).config;if(mode==='inline')config.agents[0].skills=[{name:'review',path:'',content:content+'Inline body'}];let submitted=0,root='';
 const factory=async():Promise<CodexClient>=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],setSkillRoots:async roots=>{root=roots[0];},startThread:async()=> 'same-name',resumeThread:async()=>{},startTurn:async()=>{submitted++;expect(await readFile(join(root,'review','SKILL.md'),'utf8')).toContain(mode==='inline'?'Inline body':'Project body');return 'turn';},interrupt:async()=>{},replyApproval(){},close(){}});
 manager=createSessionManager(store,async()=>config,factory,undefined,home);const c=await manager.create('p','a');await manager.send(c.id,'Review');expect(submitted).toBe(1);const provided=store.listEvents(c.id,0).find(event=>event.kind==='metadata'&&(event.data as any).skillVersions)?.data as any;expect(provided.skillVersions.map((item:any)=>item.skillId)).toEqual(mode==='inline'?[]:['project-review']);
});
