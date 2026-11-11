import type {Store} from './store';
import type {createTasks} from './tasks';
import {DomainError,type Principal} from '../shared/workspace-contracts';
import type {ConversationResult} from '../shared/conversation-results';

// A read projection of existing receipts, including results waiting for coordinator processing.
export function conversationResults(store:Store,tasks:ReturnType<typeof createTasks>,principal:Principal,id:string,authorizeConversation:(id:string)=>void):ConversationResult[]{
 if(principal.userId!==store.ownerUserId||principal.agentId!==undefined)throw new DomainError('forbidden',403,'Owner result view required');
 authorizeConversation(id);
 const main=store.getConversation(id)?.purpose==='mandala-main';
 return store.database.prepare('SELECT id,task_id,source_run_id,created_at,delivery_state,claim_error FROM task_receipts WHERE destination_conversation_id=? ORDER BY rowid').all(id).flatMap<ConversationResult>(row=>{
  const reportAccessBlocked=main&&row.delivery_state==='parked'&&row.claim_error==='forbidden';
  try{
   const receipt=tasks.authorizeReceipt(principal,row.id as string);
   if(!receipt.sourceRunId||!receipt.taskId)return [];
   const run=tasks.getRun(principal,receipt.sourceRunId),task=tasks.getTask(principal,receipt.taskId);
   if(!run.routing)return [];
   authorizeConversation(run.routing.executionConversationId);
   let title=task.goal.split('\n')[0];
   if(run.snapshot?.rule&&store.database.prepare("SELECT name FROM sqlite_master WHERE name='automation_occurrences'").get()){
    const occurrence=store.database.prepare("SELECT data FROM automation_occurrences WHERE json_extract(data,'$.runId')=?").get(run.id);
    if(occurrence)title=JSON.parse(occurrence.data as string).name;
   }
   const execution=store.getConversation(run.routing.executionConversationId);
   title=execution?.title?.trim()||title;
   return [{id:receipt.id,taskId:task.id,runId:run.id,conversationId:run.routing.executionConversationId,agentId:execution?.agentId||undefined,title,summary:receipt.summary,state:run.state,taskState:task.state,completion:task.completion?{completedBy:task.completion.completedBy,acceptedAt:task.completion.acceptedAt}:null,awaitingReview:task.state==='review'&&tasks.listRunControls(principal,task.id).at(-1)?.id===run.id,createdAt:receipt.createdAt,artifactCount:receipt.artifactVersions.length,
    ...(reportAccessBlocked?{reportAccessBlocked:true}:{})}];
  }catch(error){
   if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;
   if(error.status!==403||!reportAccessBlocked||!row.task_id||!row.source_run_id)return [];
   const task=tasks.getTask(principal,row.task_id as string),run=tasks.getRunControl(principal,row.source_run_id as string);
   if(task.originConversationId!==id||run.taskId!==task.id)return [];
   return [{id:row.id as string,taskId:task.id,runId:run.id,title:task.goal.split('\n')[0],summary:'',state:run.state,
    awaitingReview:task.state==='review',createdAt:row.created_at as string,artifactCount:0,reportAccessBlocked:true}];
  }
 });
}
