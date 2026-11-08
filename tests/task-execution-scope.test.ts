import {expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {memoryServices} from '../server/memory-runtime';

test('memory asset authority uses the execution Agent and project rather than the task default',()=>{
 const home=mkdtempSync(join(tmpdir(),'execution-scope-')),store=openStore(home),owner={userId:store.ownerUserId};
 try{
  const tasks=createTasks(store,{resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
  const task=tasks.createTask(owner,{goal:'Investigate',assigneeAgentId:'default',projectId:'task-project'},'task');
  const chat=store.createConversation({agentId:'worker',projectId:'execution-project',cli:'codex',model:null});
  const prepared=tasks.prepareStart(owner,task.id,task.revision,'execute',undefined,{agentId:'worker',projectId:'execution-project'});
  const run=store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}));
  const {memory,recall}=memoryServices(home,store),reader={...owner,agentId:'worker',runId:run.id};
  const matching=memory.ensureCollection(owner,{projectId:'execution-project',agentId:'worker'});
  const other=memory.ensureCollection(owner,{projectId:'task-project',agentId:'worker'});
  expect(memory.collection(reader,matching.id,'execution-project').id).toBe(matching.id);
  expect(()=>memory.collection(reader,other.id,'task-project')).toThrow();
  expect(()=>memory.profile(reader,{projectId:'execution-project',agentId:'worker'})).not.toThrow();
  expect(()=>memory.validateReferences(reader,{projectId:'task-project',items:[]})).toThrow();
  expect(()=>recall.recordUse(reader,{runId:run.id,query:'Execution request',items:[]})).not.toThrow();
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
