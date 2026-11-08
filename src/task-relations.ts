import type {Task} from '../shared/tasks';
import type {OperationResult} from '../shared/operation-results';
import type {ConversationProgress} from '../shared/conversation-progress';

/** Chats that need the user, current executions only: approval, a question or a failure. */
export function attentionChats(task:Task,tasks:readonly Task[],rows:readonly ConversationProgress[]):{row:ConversationProgress;state:ChatState}[]{
 const currentChats=new Set((task.executions??[]).filter(execution=>!execution.supersededByExecutionId).map(execution=>execution.conversationId));
 return executionChatsFor(task.id,tasks,rows).filter(row=>currentChats.has(row.id)).map(row=>{const state=executionChatState(row,tasks);return {row,state:row.active&&row.state==='attention'&&state!=='approval'&&state!=='failed'?'attention' as const:state};}).filter(item=>item.state==='approval'||item.state==='attention'||item.state==='failed');
}
export function taskHasAttention(task:Task,tasks:readonly Task[],rows:readonly ConversationProgress[]):boolean{return attentionChats(task,tasks,rows).length>0;}
export function taskLaneState(task:Task,tasks:readonly Task[],rows:readonly ConversationProgress[]):Task['state']{
 return task.state==='completed'||task.state==='cancelled'?task.state:taskHasAttention(task,tasks,rows)?'waiting':task.state;
}
export function operationTaskId(result:OperationResult){const match=result.path?.match(/^\/tasks\/([^/?]+)$/);return match?decodeURIComponent(match[1]):null;}
export type ChatState='running'|'queued'|'approval'|'attention'|'replied'|'failed'|'cancelled'|'todo'|'idle';

/** Current runtime status takes precedence; task acceptance never stands in for an execution result. */
export function executionChatState(row:ConversationProgress,tasks:readonly Task[]):ChatState{
 if(row.executionStatus==='approval')return 'approval';
 if(row.executionStatus==='running')return 'running';
 if(row.executionStatus==='error')return 'failed';
 const execution=tasks.flatMap(task=>task.executions??[]).find(item=>item.conversationId===row.id),run=execution?.latestRun;
 if(run){
  if(run.state==='succeeded')return 'replied';
  if(run.state==='failed')return 'failed';
  if(run.state==='interrupted')return 'cancelled';
  if(run.state==='approval')return 'approval';
  if(run.state==='running'||run.state==='starting')return 'running';
  if(run.state==='queued')return 'queued';
  return 'attention';
 }
 if(execution)return 'todo';
 return row.state==='running'?'running':row.state==='queued'?'queued':row.state==='attention'||row.state==='waiting'?'attention':'idle';
}

/** The execution registry is authoritative, including chats not yet present in the progress feed. */
export function executionChatsFor(taskId:string,tasks:readonly Task[],rows:readonly ConversationProgress[],excludeConversationId?:string):ConversationProgress[]{
 const task=tasks.find(task=>task.id===taskId);
 return (task?.executions??[]).filter(execution=>execution.conversationId!==excludeConversationId).map(execution=>{
  const progress=rows.find(row=>row.id===execution.conversationId);
  if(progress)return {...progress,taskIds:[taskId]};
  const run=execution.latestRun,state=run?.state==='running'||run?.state==='starting'?'running':run?.state==='queued'?'queued':run&&['approval','failed','unknown','legacy_unverified'].includes(run.state)?'attention':'recent';
  return {id:execution.conversationId,title:execution.title,agentId:execution.agentId,projectId:execution.projectId??'',cli:'codex',state,reopenState:state,active:state!=='recent',withinWindow:true,activityAt:run?.createdAt??execution.createdAt,completedAt:null,requestPreview:execution.request,hasNewActivity:false,taskIds:[taskId],relatedConversationIds:[],executionStatus:null};
 });
}
