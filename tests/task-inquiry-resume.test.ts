import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {createAgentMessages} from '../server/agent-messages';
const owner={userId:'local'},clean:(()=>void)[]=[];
afterEach(()=>clean.splice(0).forEach(f=>f()));
function setup(){
 const home=mkdtempSync(join(tmpdir(),'task-inquiry-resume-')),store=openStore(home);let input=0;
 const tasks=createTasks(store,{resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:'Fixed original goal',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial',continuation:{taskId:t.id,conversationId:t.originConversationId!,epoch:t.continuationEpoch,policy:'notify' as const}})});
 const messages=createAgentMessages(store,(conversationId,text)=>({id:'input-'+(++input),conversationId,text,state:'queued',createdAt:new Date().toISOString()})),upstream=store.createConversation({projectId:'',agentId:'parent',cli:'codex',model:null}),source=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),peer=store.createConversation({projectId:'',agentId:'b',cli:'codex',model:null});
 clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const task=tasks.createTask(owner,{goal:'Fixed original goal',assigneeAgentId:'a',participantAgentIds:['parent'],originConversationId:upstream.id},'task'),prepared=tasks.prepareStart(owner,task.id,1,'start'),run=store.transaction(()=>prepared.commit({executionConversationId:source.id,mode:'dedicated',destinationConversationId:upstream.id}));
 tasks.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t1'});const event=store.appendEvent(source.id,'user',{text:'Fixed original goal'});
 const inquiry=messages.create(source.id,peer.id,{targetAgentId:'b',text:'Confirm a detail'}, {eventId:event.id,invocationId:run.id},'question');
 return {store,tasks,messages,task,run,upstream,source,peer,inquiry};
}
function yieldForReply(f:ReturnType<typeof setup>,withIntent=true){
 if(withIntent)f.tasks.requestCompletion({...owner,agentId:'a',runId:f.run.id},f.task.id,f.tasks.getTask(owner,f.task.id).revision,'intent');
 f.tasks.applyRunEvent({runId:f.run.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t1',eventKey:'yield',outcome:'succeeded',summary:'Checking the detail',artifactVersions:[]});
}
function peerReply(f:ReturnType<typeof setup>){f.messages.finish('input-1','succeeded','The detail is confirmed');f.messages.queueReplies(f.source.id);}
test('durable executor yields truthfully without an upstream receipt, then resumes as a distinct Run with valid completion intent',()=>{
 const f=setup();yieldForReply(f);expect(f.tasks.getTask(owner,f.task.id)).toMatchObject({state:'waiting',waitingReason:'input'});expect(f.tasks.getRun(owner,f.run.id).state).toBe('succeeded');expect(f.tasks.listReceipts(owner,f.task.id)).toEqual([]);
 peerReply(f);expect(f.tasks.findInquiryWait(owner,f.run.id,f.source.id)).toEqual({runId:f.run.id,taskId:f.task.id});const prepared=f.tasks.prepareInquiryResume(owner,f.run.id,'Peer reply data','reply-1'),next=f.store.transaction(()=>prepared.commit());
 expect(next).toMatchObject({taskId:f.task.id,executionId:f.run.executionId,state:'queued',routing:f.run.routing,continuation:f.run.continuation});expect(next.id).not.toBe(f.run.id);expect(f.tasks.getContextSnapshot(owner,next.id)?.input).toContain('Fixed original goal');expect(f.tasks.getContextSnapshot(owner,next.id)?.input).toContain('Peer reply data');
 f.messages.finish('input-2','succeeded','Final checked answer');f.tasks.bindRunIdentity({runId:next.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2'});f.tasks.applyRunEvent({runId:next.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2',eventKey:'final',outcome:'succeeded',summary:'Final checked answer',artifactVersions:[]});
 expect(f.tasks.getTask(owner,f.task.id)).toMatchObject({state:'completed',completion:{completedBy:'agent',completedByAgentId:'a',sourceRunId:next.id}});expect(f.tasks.listReceipts(owner,f.task.id)).toMatchObject([{sourceRunId:next.id,executionId:f.run.executionId,destinationConversationId:f.upstream.id,summary:'Final checked answer',deliveryState:'pending'}]);
});
test.each(['stop','edit','complete'] as const)('waiting inquiry continuation cannot resume after %s',change=>{
 const f=setup();yieldForReply(f);const current=f.tasks.getTask(owner,f.task.id);
 if(change==='stop')f.tasks.stopTask(owner,f.task.id,current.revision);else if(change==='edit')f.tasks.updateTask(owner,f.task.id,current.revision,{goal:'Revised goal'},'edit');else f.tasks.moveTask(owner,f.task.id,current.revision,'completed',null,'complete');
 peerReply(f);expect(()=>f.tasks.prepareInquiryResume(owner,f.run.id,'Old reply','stale')).toThrow(expect.objectContaining({code:'inquiry_resume_unavailable'}));expect(f.tasks.listRuns(owner,f.task.id)).toHaveLength(1);
});
test('origin continuation epoch invalidation parks final delivery while unchanged execution can process its peer reply',()=>{
 const f=setup();yieldForReply(f);peerReply(f);const prepared=f.tasks.prepareInquiryResume(owner,f.run.id,'Peer reply','resume'),next=f.store.transaction(()=>prepared.commit());f.messages.finish('input-2','succeeded','Final');
 f.store.database.prepare('UPDATE work_tasks SET continuation_epoch=continuation_epoch+1 WHERE id=?').run(f.task.id);
 f.tasks.bindRunIdentity({runId:next.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2'});f.tasks.applyRunEvent({runId:next.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2',eventKey:'after-epoch-change',outcome:'succeeded',summary:'Final',artifactVersions:[]});expect(f.tasks.listReceipts(owner,f.task.id)).toMatchObject([{executionId:next.executionId,deliveryState:'parked'}]);
});
test('ordinary successful executor turn still requires acceptance when no explicit intent exists',()=>{
 const f=setup();yieldForReply(f,false);peerReply(f);const prepared=f.tasks.prepareInquiryResume(owner,f.run.id,'Peer reply','no-intent'),next=f.store.transaction(()=>prepared.commit());f.messages.finish('input-2','succeeded','Final');f.tasks.bindRunIdentity({runId:next.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2'});f.tasks.applyRunEvent({runId:next.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2',eventKey:'no-intent-final',outcome:'succeeded',summary:'Final',artifactVersions:[]});expect(f.tasks.getTask(owner,f.task.id)).toMatchObject({state:'review',completion:null});
});
test('stopping a settled inquiry wait reports interruption once without inventing a new Run',()=>{
 const f=setup();yieldForReply(f);const current=f.tasks.getTask(owner,f.task.id),result=f.tasks.stopTask(owner,f.task.id,current.revision);expect(result).toMatchObject({status:'stopped',run:null});expect(f.tasks.getTask(owner,f.task.id)).toMatchObject({state:'waiting',waitingReason:'interrupted'});expect(f.tasks.listReceipts(owner,f.task.id)).toMatchObject([{sourceRunId:f.run.id,summary:'Execution stopped while waiting for an Agent reply'}]);expect(f.tasks.listRuns(owner,f.task.id)).toHaveLength(1);expect(f.tasks.getRun(owner,f.run.id).state).toBe('succeeded');f.tasks.stopTask(owner,f.task.id,f.tasks.getTask(owner,f.task.id).revision);expect(f.tasks.listReceipts(owner,f.task.id)).toHaveLength(1);
});
test('persisted inquiry wait resumes after service reconstruction without ephemeral resolver state',()=>{
 const f=setup();yieldForReply(f);peerReply(f);const recovered=createTasks(f.store,{resolve:()=>{throw Error('No ephemeral task preparation after restart');}});expect(recovered.findInquiryWait(owner,f.run.id,f.source.id)).toEqual({runId:f.run.id,taskId:f.task.id});const prepared=recovered.prepareInquiryResume(owner,f.run.id,'Reply after restart','restart-resume'),next=f.store.transaction(()=>prepared.commit());expect(next).toMatchObject({taskId:f.task.id,routing:f.run.routing,continuation:f.run.continuation});expect(recovered.getContextSnapshot(owner,next.id)?.input).toContain('Reply after restart');
});
test('fanout replies follow only their own persisted Run chain and produce one final upstream receipt',()=>{
 const f=setup(),original=f.store.listEvents(f.source.id,0).find(e=>e.kind==='user')!;f.messages.create(f.source.id,f.peer.id,{targetAgentId:'b',targetConversationId:f.peer.id,text:'Second detail'},{eventId:original.id,invocationId:f.run.id},'question-2');yieldForReply(f);
 f.messages.finish('input-1','succeeded','First detail');f.messages.queueReplies(f.source.id);const p2=f.tasks.prepareInquiryResume(owner,f.run.id,'First reply','reply-first'),second=f.store.transaction(()=>p2.commit());f.messages.finish('input-3','succeeded','Still waiting for second detail');f.tasks.bindRunIdentity({runId:second.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2'});f.tasks.applyRunEvent({runId:second.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t2',eventKey:'second-yield',outcome:'succeeded',summary:'Still checking',artifactVersions:[]});expect(f.tasks.listReceipts(owner,f.task.id)).toEqual([]);
 expect(f.tasks.findInquiryWait(owner,f.run.id,f.source.id)).toEqual({runId:second.id,taskId:f.task.id});const retry=f.tasks.prepareInquiryResume(owner,f.run.id,'First reply','reply-first');expect(retry.commit().id).toBe(second.id);
 f.messages.finish('input-2','succeeded','Second detail');f.messages.queueReplies(f.source.id);const p3=f.tasks.prepareInquiryResume(owner,second.id,'Second reply','reply-second'),third=f.store.transaction(()=>p3.commit());f.messages.finish('input-4','succeeded','Both details checked');f.tasks.bindRunIdentity({runId:third.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t3'});f.tasks.applyRunEvent({runId:third.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t3',eventKey:'final',outcome:'succeeded',summary:'Both details checked',artifactVersions:[]});expect(f.tasks.getTask(owner,f.task.id)).toMatchObject({state:'completed',completion:{sourceRunId:third.id,completedBy:'agent'}});expect(f.tasks.listReceipts(owner,f.task.id)).toMatchObject([{sourceRunId:third.id,summary:'Both details checked'}]);expect(f.tasks.listRuns(owner,f.task.id).map(run=>run.nativeTurnId)).toEqual(['t1','t2','t3']);
});

test.each(['direct','review-accept','cancel'] as const)('explicit %s decision resolves a suspended executor upstream once without claiming a native final answer',decision=>{
 const f=setup();yieldForReply(f);let task=f.tasks.getTask(owner,f.task.id);const actor={...owner,agentId:'parent'};
 if(decision==='cancel')f.tasks.stopTask(owner,task.id,task.revision,true);else if(decision==='direct')f.tasks.moveTask(actor,task.id,task.revision,'completed',null,'explicit-decision');else {task=f.tasks.userCommand(actor,task.id,task.revision,'complete',null,undefined,'review');f.tasks.userCommand(actor,task.id,task.revision,'accept',null,undefined,'accept');}
 const receipts=f.tasks.listReceipts(owner,f.task.id);expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({sourceRunId:f.run.id,executionId:f.run.executionId,deliveryState:'parked'});expect(receipts[0].summary).toBe(decision==='cancel'?'Task cancelled while waiting for an Agent reply':'Task marked completed by Agent parent while waiting for an Agent reply');expect(f.tasks.getRun(owner,f.run.id).state).toBe('succeeded');expect(f.tasks.listRuns(owner,f.task.id)).toHaveLength(1);
 peerReply(f);expect(()=>f.tasks.prepareInquiryResume(owner,f.run.id,'Late peer answer','late')).toThrow(expect.objectContaining({code:'inquiry_resume_unavailable'}));expect(f.tasks.listReceipts(owner,f.task.id)).toHaveLength(1);
});
test('manual suspended-task completion revokes its captured origin epoch and parks the receipt',()=>{
 const f=setup();yieldForReply(f);const current=f.tasks.getTask(owner,f.task.id);f.tasks.moveTask(owner,current.id,current.revision,'completed',null,'finish');expect(f.tasks.listReceipts(owner,f.task.id)).toMatchObject([{deliveryState:'parked',summary:'Task marked completed by user while waiting for an Agent reply'}]);peerReply(f);expect(()=>f.tasks.prepareInquiryResume(owner,f.run.id,'Late answer','after-completion')).toThrow(expect.objectContaining({code:'inquiry_resume_unavailable'}));
});
