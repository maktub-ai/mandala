import {readConfiguredRuntime} from './configured-runtime';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createHttpServer } from '../server/http';
import { createSessionManager } from '../server/sessions';
import { writeConfig } from '../server/config';
import { openStore } from '../server/store';
let home: string, store: ReturnType<typeof openStore>, manager: ReturnType<typeof createSessionManager>, server: ReturnType<typeof createHttpServer>, base: string;
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'mana-business-http-'));store=openStore(home);
 manager=createSessionManager(store,async()=>(await readConfiguredRuntime(home)).config);
 server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});});
const post=(path:string,data:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
test('CLI boundary maps named commands and never trusts client identity or user routes',async()=>{
 const call=vi.spyOn(manager,'callBoundTool').mockResolvedValue({id:'task'});
 const response=await post('/api/cli/invoke',{command:'tasks delegate',args:{targetAgentId:'b',request:'work'},commandKey:'repeat'},{Authorization:'Bearer synthetic'});
 expect(response.status).toBe(200);expect(call).toHaveBeenCalledWith('synthetic','delegate',{targetAgentId:'b',request:'work'},'repeat');
 for(const command of ['config get','agents upsert','unknown command'])expect((await post('/api/cli/invoke',{command,args:{},commandKey:'k'},{Authorization:'Bearer synthetic'})).status).toBe(403);
 expect((await post('/api/cli/invoke',{command:'tasks delegate',args:{},commandKey:'k',agentId:'admin'},{Authorization:'Bearer synthetic'})).status).toBe(422);
 expect((await post('/api/cli/invoke',{command:'tasks delegate',args:{},commandKey:'k'})).status).toBe(403);
 expect(call).toHaveBeenCalledTimes(1);
});
test('real forged or expired CLI identity is rejected and domain error code survives',async()=>{
 const response=await post('/api/cli/invoke',{command:'memory search',args:{query:'secret'},commandKey:'k'},{Authorization:'Bearer forged'});
 expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'forbidden'});
});
test('CLI writes replay one committed response, reject changed payload and survive service recreation',async()=>{
 const headers={'X-OpenMana-CLI':'1','Idempotency-Key':'same'};
 const [a,b]=await Promise.all([post('/api/conversations',{},headers),post('/api/conversations',{},headers)]);
 expect(a.status).toBe(201);expect([201,409]).toContain(b.status);const first=await a.json();
 const replay=await post('/api/conversations',{},headers);expect(await replay.json()).toEqual(first);expect(store.listConversations()).toHaveLength(1);
 expect((await post('/api/conversations',{agentId:'different'},headers)).status).toBe(409);
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 expect(await(await post('/api/conversations',{},headers)).json()).toEqual(first);expect(store.listConversations()).toHaveLength(1);
});
test('service status and finite event history provide queryable CLI results',async()=>{
 expect(await(await fetch(base+'/api/status')).json()).toMatchObject({service:'mandala',status:'ready'});
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});const event=store.appendEvent(chat.id,'text',{text:'sample'});
 expect(await(await fetch(base+`/api/conversations/${chat.id}/history?after=0`)).json()).toEqual([event]);
 expect((await fetch(base+`/api/conversations/${chat.id}/history?after=-1`)).status).toBe(400);
});

test('entity config commands replay removal and reject stale revisions at the shared config service',async()=>{
 const before=await(await fetch(base+'/api/config')).json();
 const upsert={revision:before.revision,project:{id:'sample',name:'Sample',cwd:'',agentIds:[],resources:[],mcp:[],skills:[]}};
 const createHeaders={'X-OpenMana-CLI':'1','Idempotency-Key':'project-upsert'};
 const saved=await(await post('/api/cli/config/projects/upsert',upsert,createHeaders)).json();
 expect(saved.config.projects).toHaveLength(1);
 expect(await(await post('/api/cli/config/projects/upsert',upsert,createHeaders)).json()).toEqual(saved);
 expect((await post('/api/cli/config/projects/upsert',{...upsert,project:{...upsert.project,name:'New'}},{'X-OpenMana-CLI':'1','Idempotency-Key':'stale-edit'})).status).toBe(409);
 const remove={id:'sample',revision:saved.revision},headers={'X-OpenMana-CLI':'1','Idempotency-Key':'project-remove'};
 const deleted=await(await post('/api/cli/config/projects/remove',remove,headers)).json();
 expect(deleted.config.projects).toHaveLength(0);
 expect(await(await post('/api/cli/config/projects/remove',remove,headers)).json()).toEqual(deleted);
});

 test('removing a linked Agent atomically removes its project memberships',async()=>{
 const before=await readConfiguredRuntime(home);
 const agent={id:'a',name:'A',instructions:'',defaultCli:'codex' as const,models:{},mcp:[],skills:[]};
 const project={id:'p',name:'P',cwd:'',agentIds:['a'],resources:[],mcp:[],skills:[]};
 await writeConfig(home,{...before.config,agents:[agent],projects:[project]},before.revision);
 const revision=(await readConfiguredRuntime(home)).revision;
 const response=await post('/api/cli/config/agents/remove',{id:'a',revision},{'X-OpenMana-CLI':'1','Idempotency-Key':'remove-linked-agent'});
 expect(response.status).toBe(200);
 const saved=await response.json();expect(saved.config.agents).toEqual([]);expect(saved.config.projects[0].agentIds).toEqual([]);
 expect(saved.config.projects[0].name).toBe('P');
 });


test('Task and conversation business commands map to their bound host operation',async()=>{
 const call=vi.spyOn(manager,'callBoundTool').mockResolvedValue({state:'review'});
 const mappings:Record<string,string>={'tasks context':'task_context','tasks list':'task_list','tasks get':'task_read','tasks create':'task_create','tasks update':'task_update','tasks execution-add':'task_execution_add','tasks execution-remove':'task_execution_remove','tasks review':'task_review','tasks complete':'task_review','tasks mark-completed':'task_mark_completed','tasks accept':'task_accept','tasks reopen':'task_reopen','tasks assign':'task_assign','tasks request-changes':'task_request_changes','tasks cancel':'task_cancel','conversations list':'conversation_list','conversations get':'conversation_read','conversations history':'conversation_history'};
 for(const [command,tool]of Object.entries(mappings)){
  const args=command==='tasks create'?{goal:'Independent goal',projectId:null}:{};
  const response=await post('/api/cli/invoke',{command,args,commandKey:'stable'},{Authorization:'Bearer bound'});
  expect(response.status).toBe(200);expect(call).toHaveBeenLastCalledWith('bound',tool,args,'stable');
 }
 expect(call).toHaveBeenCalledTimes(Object.keys(mappings).length);
});


test('executable CLI persists editable independent goals and explicit links then requires separate user acceptance',async()=>{
 const cli=async(args:string[])=>new Promise<any>((done,reject)=>execFile(process.execPath,[resolve('cli/openmana.mjs'),...args,'--base-url',base],{env:{...process.env,OPEN_MANA_CONTEXT:''}},(error,stdout,stderr)=>error?reject(new Error(stderr)):done(JSON.parse(stdout).data)));
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 let task=await cli(['tasks','create','--data',JSON.stringify({goal:'Independent objective',projectId:null})]);
 expect(task).toMatchObject({state:'todo',projectId:null,conversationIds:[],criteria:[]});
 task=await cli(['tasks','update',task.id,'--data',JSON.stringify({expectedRevision:task.revision,goal:'Edited objective'})]);
 expect(task.goal).toBe('Edited objective');
 task=await cli(['tasks','execution-add',task.id,'--data',JSON.stringify({expectedRevision:task.revision,conversationId:chat.id})]);expect(task.conversationIds).toEqual([chat.id]);
 expect(await cli(['tasks','list','--query',JSON.stringify({conversationId:chat.id})])).toMatchObject([{id:task.id}]);
 task=await cli(['tasks','execution-remove',task.id,task.executions[0].id,'--data',JSON.stringify({expectedRevision:task.revision})]);expect(task.conversationIds).toEqual([]);
 task=await cli(['tasks','review',task.id,'--data',JSON.stringify({expectedRevision:task.revision})]);expect(task.state).toBe('review');expect(task.completion).toBeNull();
 const detail=await cli(['tasks','get',task.id]);expect(detail.task.id).toBe(task.id);expect(detail.runs).toEqual([]);
 task=await cli(['tasks','accept',task.id,'--data',JSON.stringify({expectedRevision:task.revision})]);expect(task).toMatchObject({state:'completed',completion:{completedBy:'user',sourceRunId:null}});
});
