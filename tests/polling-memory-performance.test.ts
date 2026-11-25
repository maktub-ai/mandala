import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {openStore} from '../server/store';
import {createMemoryRuntime} from '../server/memory-runtime';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';
import {DomainError} from '../shared/workspace-contracts';
import {readConfiguredRuntime} from './configured-runtime';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0))await cleanup();});

test.each(['control','tasks','progress','results'])('%s polling reuses decoded shared memory and checks access again on the next request',async(view)=>{
 const home=mkdtempSync(join(tmpdir(),'mana-polling-')),store=openStore(home),root={userId:store.ownerUserId};
 const loadConfig=async()=>(await readConfiguredRuntime(home)).config;
 let revoked=false;
 const authorize=vi.fn(()=>{if(revoked)throw new DomainError('forbidden',403,'Source access revoked');});
 const memoryRuntime=createMemoryRuntime({home,store,loadConfig,schedule:false,authorizeConversationRead:authorize});
 const manager=createSessionManager(store,loadConfig,undefined,undefined,home,undefined,undefined,memoryRuntime);
 const server=createHttpServer({home,store,manager,memoryRuntime,requireIdentity:false});
 cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await manager.close();await memoryRuntime.close();store.close();rmSync(home,{recursive:true,force:true});});
 const sourceChat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const collection=memoryRuntime.memory.ensureCollection(root,{projectId:null,agentId:'a'});
 const text='Synthetic shared evidence',event=store.appendEvent(sourceChat.id,'user',{text});
 store.appendEvent(sourceChat.id,'status',{status:'idle'});
 const source=memoryRuntime.memory.captureConversation(root,{collectionId:collection.id,conversationId:sourceChat.id,trigger:'explicit',kind:'request'}).sources[0];
 const record=memoryRuntime.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'observed'},collection.generation,'evidence_extract')!;
 const tasks=manager.taskService;
 for(let i=0;i<3;i++){
  const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
  store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:record.recordId,revision:record.revision}]});
  const task=tasks.createTask(root,{goal:'Synthetic task '+i},'task-'+i);
  const execution=tasks.createExecution(root,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:'Synthetic request'},'execution-'+i);
  store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,summary,created_at) VALUES (?,?,?,1,'succeeded',?,'Synthetic result',?)")
   .run('run-'+i,task.id,execution.id,JSON.stringify({executionConversationId:chat.id,destinationConversationId:sourceChat.id,mode:'dedicated'}),new Date().toISOString());
  store.database.prepare("INSERT INTO task_receipts(id,task_id,source_run_id,destination_conversation_id,execution_id,policy,delivery_state,summary,artifact_versions,created_at) VALUES (?,?,?,?,?,'notify','consumed','Synthetic result','[]',?)")
   .run('receipt-'+i,task.id,'run-'+i,sourceChat.id,execution.id,new Date().toISOString());
 }
 const payload=store.database.prepare('SELECT data FROM memory_sources WHERE id=?').get(source.id)!.data;
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const path={control:'/tasks?view=control',tasks:'/v2/tasks',progress:'/conversation-progress',results:'/conversations/'+sourceChat.id+'/results'}[view];
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api'+path;
 memoryRuntime.memory.source(root,source.id);
 const parse=vi.spyOn(JSON,'parse');
 const response=await fetch(url);expect(response.status).toBe(200);
 const before=await response.json();expect(before.length).toBeGreaterThanOrEqual(3);
 expect(parse.mock.calls.filter(([value])=>value===payload)).toHaveLength(0);
 parse.mockClear();authorize.mockClear();revoked=true;
 const denied=await fetch(url);expect(denied.status).toBe(200);
 const after=await denied.json();
 if(view==='control')expect(after).toEqual([]);
 else if(view==='tasks')expect(after.every((task:{executions:unknown[]})=>task.executions.length===0)).toBe(true);
 else if(view==='progress')expect(after.every((chat:{taskIds:unknown[]})=>chat.taskIds.length===0)).toBe(true);
 else expect(after).toEqual(before); // Owner receipts remain readable independently of recalled memory.
 expect(authorize).toHaveBeenCalled();
 expect(parse.mock.calls.filter(([value])=>value===payload)).toHaveLength(0);
});
