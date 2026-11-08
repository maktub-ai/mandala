import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { createHttpServer } from "../server/http";
import { createAutomations } from "../server/automations";
import { openStore, type Store } from "../server/store";
import { readConfig, writeConfig } from "../server/config";
import { createSessionManager, type SessionManager } from "../server/sessions";
let manager:SessionManager;
let home:string,server:Server,store:Store,base:string,service:ReturnType<typeof createAutomations>;
const sample={name:"Personal daily review",instructions:"Review reading notes",projectId:"reading",agentId:"reader",cli:"codex",enabled:true,
  schedule:{kind:"daily",time:"09:00",timeZone:"Asia/Singapore"}};
beforeEach(async()=>{
  home=mkdtempSync(join(tmpdir(),"mana-schedule-http-"));store=openStore(home);
  const initial=await readConfig(home);await writeConfig(home,{version:2,projects:[{id:"reading",name:"Reading",cwd:home,agentIds:["reader"],resources:[],mcp:[],skills:[]}],
    agents:[{id:"reader",name:"Reader",instructions:"Personal only",defaultCli:"codex",models:{},mcp:[],skills:[]}]},initial.revision);
  manager=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>{throw new Error("Unexpected native invocation in HTTP contract test");},async()=>{throw new Error("Unexpected OMP invocation in HTTP contract test");},home);
  service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});
  server=createHttpServer({requireIdentity:false,home,store,manager,automations:service});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{service.close();manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});});
const call=(path:string,method="GET",data?:unknown,origin?:string)=>fetch(base+"/api/automations"+path,{method,headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
it("manages schedules and queued runs through the same origin API",async()=>{
  expect((await (await call("")).json()).automations).toEqual([]);
  const created=await call("","POST",sample);expect(created.status).toBe(201);const a=await created.json();
  expect(a.nextRunAt).toBeTruthy();expect((await call(`/${a.id}/run`,"POST")).status).toBe(202);
  const state=await (await call("")).json();expect(state.runs[0].status).toBe("queued");
  const stopped=await call(`/${state.runs[0].id}/stop`,"POST");expect((await stopped.json()).status).toBe("interrupted");
  const updated=await (await call(`/${a.id}`,"PATCH",{enabled:false,expectedRevision:a.revision})).json();expect(updated.enabled).toBe(false);
  expect((await call(`/${a.id}`,"DELETE",{expectedRevision:updated.revision})).ok).toBe(true);
  const end=await (await call("")).json();expect(end.automations).toEqual([]);expect(end.runs).toHaveLength(1);
});
it("rejects foreign origins, invalid task input and methods without changing storage",async()=>{
  expect((await call("","POST",sample,"https://example.com")).status).toBe(403);
  expect((await call("","POST",{...sample,agentId:"unknown"})).status).toBe(400);
  expect((await call("","POST",{...sample,shellCommand:"do not accept"})).status).toBe(400);
  expect((await call("","PUT",sample)).status).toBe(405);
  expect((await (await call("")).json()).automations).toEqual([]);
});
