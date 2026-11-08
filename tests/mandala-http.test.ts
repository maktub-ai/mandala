import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { openStore, type Store } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
let home:string,store:Store,manager:SessionManager,server:Server,url:string;
beforeEach(async()=>{
  home=await mkdtemp(join(tmpdir(),'mandala-http-'));store=openStore(home);
  const initial=await readConfig(home);await writeConfig(home,{...initial.config,runtimes:['codex','omp']},initial.revision);
  manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
  server=createHttpServer({home,store,manager,requireIdentity:false});server.listen(0,'127.0.0.1');await once(server,'listening');
  url='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterEach(async()=>{await manager.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));store.close();await rm(home,{recursive:true,force:true});});
const request=(path:string,method='GET',body?:unknown,headers={})=>fetch(url+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
it('binds one primary conversation on concurrent requests and protects settings and primary archive endpoints',async()=>{
  const copies=await Promise.all(Array.from({length:6},async()=>await(await request('/api/mandala')).json()));
  expect(new Set(copies.map(item=>item.conversation.id)).size).toBe(1);
  const first=copies[0],settings={name:'Manbo',cli:'omp',soul:'Calm and concise',maxParallel:5};
  expect((await request('/api/mandala','PUT',{revision:first.revision,settings})).status).toBe(200);
  expect((await request('/api/mandala','PUT',{revision:first.revision,settings})).status).toBe(409);
  const current=await(await request('/api/mandala')).json();
  expect(current.conversation.id).toBe(first.conversation.id);
  for(const patch of [{workspace:'/tmp'},{tools:[]},{maxParallel:0},{soul:42}])
    expect((await request('/api/mandala','PUT',{revision:current.revision,settings:{...settings,...patch}})).ok).toBe(false);
  for(const [action,body] of [['archive',{archived:true}],['model',{model:'injected'}],['approval-mode',{approvalMode:'auto'}]] as const)
    expect((await request(`/api/conversations/${first.conversation.id}/${action}`,'POST',body)).ok).toBe(false);
  expect((await request('/api/chat-preferences/approval','PATCH',{agentId:first.config.mandala.agentId,cli:'codex',approvalMode:'auto'})).ok).toBe(false);
  const background=await(await request('/api/conversations','POST',{agentId:first.config.mandala.agentId,purpose:'mandala-main'})).json();
  expect(background.purpose).toBe('mandala-background');
  expect((await request('/api/mandala','GET',undefined,{Authorization:'Bearer invocation-token'})).status).toBe(403);
  expect((await request('/api/mandala','PUT',{revision:current.revision,settings},{Origin:'https://foreign.example'})).status).toBe(403);
});

it('owner confirms only a concrete proposal version; invocation credentials cannot confirm',async()=>{
 const current=await(await request('/api/mandala')).json(),chat=current.conversation;
 const event=store.appendEvent(chat.id,'user',{text:'Consider a helper',invocationId:'proposal-turn'});
 const proposal=await manager.coordination.configure({agentId:chat.agentId,conversationId:chat.id,invocationId:'proposal-turn',humanEventId:event.id},{kind:'agent',action:'create',values:{id:'helper',name:'Helper',instructions:'Help',defaultCli:'codex',models:{},mcp:[],skills:[]}},'propose','proposal',()=>{});
 const path='/api/mandala/proposals/'+proposal.id;
 expect((await request(path,'POST',{version:proposal.version,decision:'approve'},{Authorization:'Bearer invocation-token'})).status).toBe(403);
 expect((await request(path,'POST',{version:'stale',decision:'approve'})).status).toBe(409);
 expect((await request(path,'POST',{version:proposal.version,decision:'approve'})).status).toBe(200);
 expect((await readConfig(home)).config.agents.some(a=>a.id==='helper')).toBe(true);
 expect((await(await request('/api/mandala/proposals?conversationId='+chat.id)).json())[0].status).toBe('applied');
});

it('provisions protected system config on a fresh config read without creating primary chat',async()=>{
 expect(store.listConversations()).toEqual([]);
 const first=await(await request('/api/config')).json();
 const id=first.config.mandala?.agentId;expect(id).toEqual(expect.any(String));
 expect(first.config.agents.find((agent:{id:string})=>agent.id===id)).toMatchObject({systemRole:'mandala'});
 expect(store.listConversations()).toEqual([]);
 const copies=await Promise.all(Array.from({length:4},async()=>await(await request('/api/config')).json()));
 expect(copies.every(copy=>copy.revision===first.revision&&copy.config.mandala.agentId===id)).toBe(true);
 expect(store.listConversations()).toEqual([]);
 for(const config of [
  {...first.config,agents:first.config.agents.filter((agent:{id:string})=>agent.id!==id)},
  {...first.config,agents:first.config.agents.map((agent:{id:string})=>agent.id===id?{...agent,instructions:'Override system'}:agent)},
 ])expect((await request('/api/config','PUT',{revision:first.revision,config})).ok).toBe(false);
 const after=await(await request('/api/config')).json();expect(after.revision).toBe(first.revision);expect(store.listConversations()).toEqual([]);
});

it('saves system settings without creating primary chat until the primary endpoint is opened',async()=>{
 const current=await(await request('/api/config')).json();expect(store.listConversations()).toEqual([]);
 const response=await request('/api/mandala','PUT',{revision:current.revision,settings:{name:'Quiet coordinator',cli:'codex',soul:'Concise',maxParallel:4}});
 expect(response.status).toBe(200);const saved=await response.json();
 expect(saved.config.agents.find((agent:{id:string})=>agent.id===saved.config.mandala.agentId).name).toBe('Quiet coordinator');
 expect(saved.revision).not.toBe(current.revision);expect(store.listConversations()).toEqual([]);
 const opened=await(await request('/api/mandala')).json();expect(opened.conversation.purpose).toBe('mandala-main');
 expect(store.listConversations()).toHaveLength(1);expect(opened.revision).toBe(saved.revision);
});

it('updates ordinary system chat approval without changing protected system preferences',async()=>{
 const current=await(await request('/api/config')).json(),agentId=current.config.mandala.agentId;
 const created=await(await request('/api/conversations','POST',{agentId,approvalMode:'strict'})).json();
 expect(created).toMatchObject({purpose:'mandala-background',approvalMode:'strict'});
 const updated=await request(`/api/conversations/${created.id}/approval-mode`,'POST',{approvalMode:'auto'});
 expect(updated.status).toBe(200);expect((await updated.json()).conversation.approvalMode).toBe('auto');
 expect(store.getConversation(created.id)?.approvalMode).toBe('auto');
 expect((await request('/api/chat-preferences/approval','PATCH',{agentId,cli:'codex',approvalMode:'auto'})).status).toBe(403);
 expect(await(await request(`/api/chat-preferences/approval?agentId=${encodeURIComponent(agentId)}&cli=codex`)).json()).toEqual({approvalMode:null});
 const primary=(await(await request('/api/mandala')).json()).conversation;
 expect((await request(`/api/conversations/${primary.id}/approval-mode`,'POST',{approvalMode:'auto'})).ok).toBe(false);
 expect(store.getConversation(primary.id)?.approvalMode??null).toBeNull();
});
it('returns an unselected Mandala entry and manual draft when no runtime is registered',async()=>{
 const before=await readConfig(home);await writeConfig(home,{...before.config,runtimes:[]},before.revision);
 const entry=await(await request('/api/mandala')).json();
 expect(entry.conversation).toBeNull();expect(entry.config.agents).toEqual([]);
 expect(store.listConversations()).toEqual([]);
 const draft=await(await request('/api/v2/tasks/draft','POST',{description:'Review the application'})).json();
 expect(draft.goal).toBe('Review the application');expect(draft.unresolved.join(' ')).toContain('系统任务执行端');
 expect((await readConfig(home)).config.system).toBeUndefined();
});
