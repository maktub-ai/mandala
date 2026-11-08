import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Config } from '../shared/types';
import type { CodexOptions } from '../server/codex';
import { openStore, type Store } from '../server/store';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';

let home: string, store: Store, manager: SessionManager, options: CodexOptions, server: Server | undefined;
const forkThread = vi.fn(async () => 'fork-native');
const startTurn = vi.fn(async () => 'turn');
const resumeThread = vi.fn(async () => {});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mana-fork-'));
  store = openStore(home);
  forkThread.mockClear(); startTurn.mockClear(); resumeThread.mockClear();
  const config: Config = { version: 2, projects: [{id:'p', name:'Project', cwd:home, workspaces:[{id:'w',name:'Workspace',cwd:home,resources:[]}], agentIds:['a'], resources:[], mcp:[], skills:[]}],
    agents:[{id:'a',name:'Agent',instructions:'Synthetic fixture',defaultCli:'codex',models:{},mcp:[],skills:[]}] };
  manager = createSessionManager(store, async () => config, async o => {
    options = o;
    return { getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'source-native',
      forkThread,resumeThread,startTurn,interrupt:async()=>{},replyApproval(){},close(){} };
  }, undefined, home);
});
afterEach(async () => {
  await manager.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(()=>resolve())); server=undefined; }
  store.close(); rmSync(home,{recursive:true,force:true});
});
function finish(text: string) {
  options.onEvent({method:'item/agentMessage/delta',params:{threadId:'source-native',turnId:'turn',itemId:crypto.randomUUID(),delta:text}});
  options.onEvent({method:'turn/completed',params:{threadId:'source-native',turn:{id:'turn',status:'completed'}}});
}

it('forks the whole completed conversation, preserves defaults and continues independently without rerunning', async () => {
  const source=await manager.create('p','a','selected-model','codex',{workspaceId:'w',effort:'high',approvalMode:'auto'});
  for(const text of ['Remember blue','Then green']) { await manager.send(source.id,text);finish('Answer: '+text); }
  const original=store.getConversation(source.id),history=store.listEvents(source.id,0),sent=startTurn.mock.calls.length;
  const fork=await manager.fork(source.id);
  expect(fork).toMatchObject({nativeId:'fork-native',status:'idle',projectId:'p',agentId:'a',workspaceId:'w',cwd:home,workspaceName:'Workspace',model:'selected-model',effort:'high',approvalMode:'auto'});
  expect(fork.id).not.toBe(source.id);
  expect(forkThread).toHaveBeenCalledWith('source-native',['Remember blue','Then green'],2,'selected-model');
  expect(startTurn).toHaveBeenCalledTimes(sent);
  expect(store.listEvents(fork.id,0).filter(e=>['user','text'].includes(e.kind)).map(e=>e.data)).toEqual(history.filter(e=>['user','text'].includes(e.kind)).map(e=>e.data));
  expect(store.getConversation(source.id)).toEqual(original);expect(store.listEvents(source.id,0)).toEqual(history);
  await manager.send(fork.id,'Only in fork');expect(resumeThread.mock.calls.at(-1)?.slice(0,4)).toEqual(['fork-native',[],expect.any(String),'selected-model']);
  expect(store.listEvents(source.id,0)).toEqual(history);
});

it('rejects empty, running and interrupted whole-conversation forks without creating a misleading partial copy',async()=>{
  const source=await manager.create('p','a');
  await expect(manager.fork(source.id)).rejects.toThrow();
  await manager.send(source.id,'In progress');
  await expect(manager.fork(source.id)).rejects.toThrow('conversation busy');
  options.onEvent({method:'turn/completed',params:{threadId:'source-native',turn:{id:'turn',status:'interrupted'}}});
  await expect(manager.fork(source.id)).rejects.toThrow();
  expect(forkThread).not.toHaveBeenCalled();expect(store.listConversations()).toHaveLength(1);
});

it('accepts a whole-conversation HTTP fork with no eventId while retaining origin and input validation',async()=>{
  const source=await manager.create('p','a');await manager.send(source.id,'Remember context');finish('Acknowledged');
  server=createHttpServer({home,store,manager,requireIdentity:false});server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post=(data:unknown,origin=url)=>fetch(url+`/api/conversations/${source.id}/fork`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(data)});
  expect((await post({},'https://foreign.test')).status).toBe(403);
  expect((await post({eventId:'wrong'})).status).toBe(400);
  const response=await post({});expect(response.status).toBe(201);
  expect((await response.json()).conversation).toMatchObject({nativeId:'fork-native',branchedFrom:{conversationId:source.id}});
});

it('rejects forking the continuous Mandala primary chat',async()=>{
  const main=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null,purpose:'mandala-main'});
  await expect(manager.fork(main.id)).rejects.toThrow('cannot be forked');
  await expect(manager.fork(main.id,1)).rejects.toThrow('cannot be forked');
  expect(forkThread).not.toHaveBeenCalled();
});

it('rejects editing a message in the continuous Mandala primary chat',async()=>{
  const main=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null,purpose:'mandala-main'});
  await expect(manager.edit(main.id,1,'Revised')).rejects.toThrow('cannot be edited');
  expect(forkThread).not.toHaveBeenCalled();
});
