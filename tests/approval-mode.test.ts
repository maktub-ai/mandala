import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCodex, type CodexOptions, type CodexClient } from "../server/codex";
import { createSessionManager, type SessionManager } from "../server/sessions";
import { openStore, type Store } from "../server/store";
import type { Config } from "../shared/types";
import { readConfig, writeConfig } from "../server/config";
let home: string, store: Store, manager: SessionManager, callbacks: CodexOptions;
let starts: any[], turns: any[], config: Config;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mana-approval-")); store = openStore(home); starts = []; turns = [];
  config = {runtimes:['codex','omp'], version: 2, projects: [{ id: "p", name: "Personal sample", cwd: home, resources: [], agentIds: ["a"], mcp: [], skills: [] }],
    agents: [{ id: "a", name: "Reader", defaultCli: "codex", instructions: "Personal sample only", models: {}, mcp: [], skills: [] }] };
  const factory = async (o: CodexOptions): Promise<CodexClient> => {
    callbacks = o; starts.push(o);
    return { getStatus: async () => ({status:"ready",version:null}),listModels:async()=>[],
      startThread:async()=>"native",resumeThread:async()=>{},
      startTurn:async(_id,text,mode)=>{turns.push({text,mode});return "turn";},interrupt:async()=>{},replyApproval(){},close(){} };
  };
  manager = createSessionManager(store, async () => config, factory, factory, home);
});
afterEach(() => { manager.close(); store.close(); rmSync(home,{recursive:true,force:true}); });
const finish = () => callbacks.onEvent({method:"turn/completed",params:{threadId:"native",turn:{id:"turn",status:"completed"}}});
it("uses Agent approval defaults independently of Project and supports conversation overrides", async () => {
  config.agents[0].runtime={omp:{approvalMode:"auto"}};
  config.projects[0].runtime={omp:{approvalMode:"default"}};
  const c=await manager.create("p","a",undefined,"omp");
  await manager.send(c.id,"Read personal sample");
  expect(starts[0].approvalMode).toBe("auto");finish();
  await manager.setApprovalMode(c.id,"default");
  await manager.send(c.id,"Next personal sample");
  expect(starts[1].approvalMode).toBe("default");
  expect(store.getConversation(c.id)?.approvalMode).toBe("default");
  await expect(manager.setApprovalMode(c.id,"default")).rejects.toThrow("conversation busy");
  finish();await manager.setApprovalMode(c.id,null);
  await manager.send(c.id,"Restore inherited mode");expect(starts[2].approvalMode).toBe("auto");
});
it("restores native Codex policy after an automatic turn and preserves manual approvals", async () => {
  const c=await manager.create("p","a",undefined,"codex",{approvalMode:"auto"});
  await manager.send(c.id,"First personal sample");expect(turns[0].mode).toBe("auto");finish();
  await manager.setApprovalMode(c.id,"default");
  await manager.send(c.id,"Next personal sample");expect(turns[1].mode).toBe("default");
});
it("rejects invalid modes without overwriting readable configuration", async () => {
  const initial=await readConfig(home);
  await expect(writeConfig(home,{...config,agents:[{...config.agents[0],runtime:{omp:{approvalMode:"typo" as any}}}]},initial.revision)).rejects.toThrow();
});
it("Codex auto mode changes approvalPolicy only and default restores the native project policy", async () => {
  const request=vi.fn(async(method:string,_params:unknown)=> method==="config/read"?{config:{approval_policy:"untrusted"}}:method==="turn/start"?{turn:{id:"t"}}:{userAgent:"open_mana/0.154.0"});
  const client=await connectCodex({request,notify(){},reply(){},close(){}},home);
  await client.startTurn("native","Personal request","auto");
  expect(request.mock.calls.at(-1)).toEqual(["turn/start",{threadId:"native",input:[{type:"text",text:"Personal request",text_elements:[]}],approvalPolicy:"never"}]);
  await client.startTurn("native","Another personal request","default");
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({approvalPolicy:"untrusted"});
  expect(request.mock.calls.at(-2)).toEqual(["config/read",{cwd:home}]);
  expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("sandboxPolicy");
});

it("restores Codex's native on-request default when configuration leaves the policy unset", async () => {
  const request = vi.fn(async (method: string, _params: unknown) => method === "config/read" ? { config: { approval_policy: null } } : method === "turn/start" ? { turn: { id: "t" } } : { userAgent: "open_mana/0.154.0" });
  const client = await connectCodex({ request, notify() {}, reply() {}, close() {} }, home);
  await client.startTurn("native", "Restore defaults", "default");
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ approvalPolicy: "on-request" });
});

it("saves restored defaults without releasing unknown native directory after lost acknowledgement", async () => {
  manager.close();
  let failed = false;
  manager = createSessionManager(store, async () => config, async (o) => {
    callbacks = o;
    return { getStatus: async () => ({ status: "ready", version: null }), listModels: async () => [],
      startThread: async () => "native", resumeThread: async () => {}, interrupt: async () => {}, replyApproval() {}, close() {},
      startTurn: async (_id, text, mode) => {
        turns.push({ text, mode });
        if (!failed) { failed = true; throw new Error("response lost"); }
        return "turn";
      } };
  }, undefined, home);
  const c = await manager.create("p", "a", undefined, "codex", { approvalMode: "auto" });
  await expect(manager.send(c.id, "First sample")).rejects.toThrow("response lost");
  await manager.setApprovalMode(c.id, "default");
  await manager.continue(c.id, "Retry sample");
  expect(store.getConversation(c.id)?.approvalMode).toBe("default");
  expect(turns.map(t => t.mode)).toEqual(["auto"]);
  expect(manager.listUserInputs(c.id)).toMatchObject([{text:"Retry sample",state:"queued"}]);
});

it.each(['never','on-request'] as const)('strict Codex mode does not inherit permissive native %s approval',async(native)=>{
 const request=vi.fn(async(method:string,_params:unknown)=>method==='config/read'?{config:{approval_policy:native}}:method==='turn/start'?{turn:{id:'t'}}:{userAgent:'open_mana/0.160.0'});
 const client=await connectCodex({request,notify(){},reply(){},close(){}},home);
 await client.startTurn('native','Strict request','strict');expect(request.mock.calls.at(-1)?.[1]).toMatchObject({approvalPolicy:'untrusted'});
});
it('records chat authorization against the running directory, not a newly edited Project directory',async()=>{
 const c=await manager.create('p','a',undefined,'codex');await manager.send(c.id,'First request');
 callbacks.onApproval({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn',command:'sample'}});
 const a=manager.getApprovals(c.id)[0];config.projects[0].cwd='/private/tmp';
 await manager.approve(c.id,a.id,'approve-conversation');
 expect(store.database.prepare('SELECT cwd FROM conversation_tool_approvals').get()?.cwd).toBe(realpathSync(home));
 expect(await manager.conversationApproval(c.id)).toEqual({granted:true});
});
