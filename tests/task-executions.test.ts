import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(){const home=mkdtempSync(join(tmpdir(),'task-executions-')),store=openStore(home);cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});const tasks=createTasks(store,{resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'host',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});return {store,tasks};}
it('runs two different agents in parallel on one task, reports to its origin, and waits for acceptance',()=>{
 const {store,tasks}=setup(),p={userId:store.ownerUserId},origin=store.createConversation({agentId:'coordinator',projectId:'',cli:'codex',model:null});
 const task=tasks.createTask(p,{goal:'Investigate',originConversationId:origin.id},'task');
 const runs=['a','b'].map(agentId=>{const chat=store.createConversation({agentId,projectId:'',cli:'codex',model:null}),execution=tasks.createExecution(p,task.id,{conversationId:chat.id,agentId,projectId:null,request:'Evidence '+agentId},agentId);const prepare=tasks.prepareStart(p,task.id,tasks.getTask(p,task.id).revision,'start-'+agentId,undefined,{executionId:execution.id});const run=store.transaction(()=>prepare.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:origin.id}));tasks.bindRunIdentity({runId:run.id,hostId:'host',nativeSessionId:run.id,nativeTurnId:'turn'});return run;});
 expect(tasks.listTasks(p)).toHaveLength(1);expect(tasks.getTask(p,task.id).executions).toHaveLength(2);
 for(const [index,run] of runs.entries()){tasks.applyRunEvent({runId:run.id,hostId:'host',nativeSessionId:run.id,nativeTurnId:'turn',eventKey:run.id,outcome:'succeeded',summary:'Evidence',artifactVersions:[]});expect(tasks.getTask(p,task.id).state).toBe(index===0?'running':'review');}
 expect(tasks.listReceipts(p,task.id).map(r=>r.destinationConversationId)).toEqual([origin.id,origin.id]);
 expect(tasks.listReceipts(p,task.id).map(r=>r.executionId).sort()).toEqual(runs.map(r=>r.executionId).sort());
 expect(tasks.userCommand(p,task.id,tasks.getTask(p,task.id).revision,'accept').state).toBe('completed');
});
it('enforces one task per execution chat and idempotent execution creation',()=>{
 const {store,tasks}=setup(),p={userId:store.ownerUserId},chat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),task=tasks.createTask(p,{goal:'First'},'first'),other=tasks.createTask(p,{goal:'Other'},'other'),input={conversationId:chat.id,agentId:'a',projectId:null,request:'Work'};
 const execution=tasks.createExecution(p,task.id,input,'execution');expect(tasks.createExecution(p,task.id,input,'execution').id).toBe(execution.id);expect(()=>tasks.createExecution(p,other.id,input,'other-execution')).toThrow(expect.objectContaining({code:'execution_conversation_in_use'}));
});

it('a fresh execution retry supersedes failed progress while retaining its uncertain native occupancy',()=>{
 const {store,tasks}=setup(),p={userId:store.ownerUserId},task=tasks.createTask(p,{goal:'Recover work',assigneeAgentId:'a'},'task'),run=tasks.startTask(p,task.id,1,'start');
 tasks.bindRunIdentity({runId:run.id,hostId:'host',nativeSessionId:'old-native',nativeTurnId:'old-turn'});tasks.markUnknown(run.id);tasks.abandonUnknown(p,run.id,tasks.getTask(p,task.id).revision);
 const nextChat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),prepared=tasks.prepareStart(p,task.id,tasks.getTask(p,task.id).revision,'retry',undefined,{supersedesExecutionId:run.executionId}),next=store.transaction(()=>prepared.commit({executionConversationId:nextChat.id,mode:'dedicated',destinationConversationId:null}));
 tasks.bindRunIdentity({runId:next.id,hostId:'host',nativeSessionId:'new-native',nativeTurnId:'new-turn'});tasks.applyRunEvent({runId:next.id,hostId:'host',nativeSessionId:'new-native',nativeTurnId:'new-turn',eventKey:'delivered',outcome:'succeeded',summary:'Recovered delivery',artifactVersions:[]});
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'review',completion:null});expect(tasks.listExecutions(p,task.id)).toHaveLength(2);expect(tasks.getExecution(p,run.executionId).supersededByExecutionId).toBe(next.executionId);expect(tasks.getRun(p,run.id).state).toBe('interrupted');expect(store.database.prepare("SELECT claim_id FROM task_native_uncertainty WHERE kind='run' AND claim_id=?").get(run.id)).toBeDefined();
});

it.each([false,true])('a peer reply resumes its execution after sibling progress (sibling finished=%s)',async siblingFinished=>{
 const {createAgentMessages}=await import('../server/agent-messages');
 const {store,tasks}=setup(),p={userId:store.ownerUserId},task=tasks.createTask(p,{goal:'Parallel investigation',assigneeAgentId:'a'},'task');
 const chats=['a','b','c'].map(agentId=>store.createConversation({agentId,projectId:'',cli:'codex',model:null}));
 const runs=chats.slice(0,2).map(chat=>{const execution=tasks.createExecution(p,task.id,{conversationId:chat.id,agentId:chat.agentId,projectId:null,request:'Investigate'},chat.agentId);const prepared=tasks.prepareStart(p,task.id,tasks.getTask(p,task.id).revision,'start-'+chat.agentId,undefined,{executionId:execution.id}),run=store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}));tasks.bindRunIdentity({runId:run.id,hostId:'host',nativeSessionId:run.id,nativeTurnId:'turn'});return run;});
 let input=0;const messages=createAgentMessages(store,(conversationId,text)=>({id:'input-'+(++input),conversationId,text,state:'queued',createdAt:new Date().toISOString()}));
 const sourceEvent=store.appendEvent(chats[1].id,'user',{text:'Investigate'});messages.create(chats[1].id,chats[2].id,{targetAgentId:'c',text:'Check a detail'},{eventId:sourceEvent.id,invocationId:runs[1].id},'ask');
 const finish=(run:typeof runs[number])=>tasks.applyRunEvent({runId:run.id,hostId:'host',nativeSessionId:run.id,nativeTurnId:'turn',eventKey:run.id,outcome:'succeeded',summary:'Evidence',artifactVersions:[]});
 finish(runs[1]);if(siblingFinished)finish(runs[0]);messages.finish('input-1','succeeded','Confirmed');messages.queueReplies(chats[1].id);
 const prepared=tasks.prepareInquiryResume(p,runs[1].id,'Confirmed','reply'),next=store.transaction(()=>prepared.commit());expect(next).toMatchObject({executionId:runs[1].executionId,state:'queued'});expect(tasks.getExecution(p,next.executionId).agentId).toBe('b');
});

it('rejects reactivating an execution that a fresh retry superseded',()=>{
 const {store,tasks}=setup(),p={userId:store.ownerUserId},task=tasks.createTask(p,{goal:'Work',assigneeAgentId:'a'},'task'),old=tasks.startTask(p,task.id,1,'old');
 tasks.bindRunIdentity({runId:old.id,hostId:'host',nativeSessionId:'old',nativeTurnId:'turn'});tasks.applyRunEvent({runId:old.id,hostId:'host',nativeSessionId:'old',nativeTurnId:'turn',eventKey:'failed',outcome:'failed',summary:'Failure',artifactVersions:[]});
 const chat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),prepared=tasks.prepareStart(p,task.id,tasks.getTask(p,task.id).revision,'new',undefined,{supersedesExecutionId:old.executionId});store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}));
 const obsolete=tasks.prepareStart(p,task.id,tasks.getTask(p,task.id).revision,'obsolete',undefined,{executionId:old.executionId});expect(()=>store.transaction(()=>obsolete.commit(old.routing!))).toThrow(expect.objectContaining({code:'execution_superseded'}));
});
