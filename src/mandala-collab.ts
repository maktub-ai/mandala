import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import type {MandalaGoal} from '../shared/mandala-coordination';
import type {AutomationRun} from '../shared/automations';
import type {StatusShape} from './ui/StatusMark';
import {executionChatState,executionChatsFor} from './task-relations';

/** Asks the Mandala side panel to show a receiving chat (detail: {conversationId}). */
export const collabFocusEvent='mandala:focus-collab';

/** A Chat is the smallest unit the user works with; a Task is only its parent. */
export type CollabChatStatus='queued'|'running'|'approval'|'attention'|'failed'|'replied'|'summarized'|'idle';
export type CollabChat={row:ConversationProgress;status:CollabChatStatus};
export type CollabItem=
 |{kind:'chat';id:string;at:string;chat:CollabChat}
 |{kind:'task';id:string;at:string;task:Task;goal:MandalaGoal|undefined;chats:CollabChat[];needsYou:boolean;defaultOpen:boolean}
 |{kind:'run';id:string;at:string;run:AutomationRun};
export type CollabSections={needs:CollabItem[];active:CollabItem[];done:CollabItem[]};
export type CollabScope='conversation'|'all';

export const collabChatNeedsYou=(status:CollabChatStatus)=>status==='approval'||status==='attention'||status==='failed';
export const collabChatTone:Record<CollabChatStatus,'neutral'|'active'|'success'|'warning'|'danger'>={queued:'active',running:'active',approval:'warning',attention:'warning',failed:'danger',replied:'success',summarized:'success',idle:'neutral'};
export const collabChatShape:Record<CollabChatStatus,StatusShape>={queued:'clock',running:'play',approval:'alert',attention:'alert',failed:'cross',replied:'reply',summarized:'check',idle:'minus'};
export const collabChatLabels=(t:(zh:string,en:string)=>string):Record<CollabChatStatus,string>=>({queued:t('排队中','Queued'),running:t('处理中','Working'),approval:t('等你审批','Needs approval'),attention:t('需要你处理','Needs you'),failed:t('执行失败','Failed'),replied:t('已回复','Replied'),summarized:t('已汇总','Summarized'),idle:t('空闲','Idle')});

/**
 * A Mandala handoff keeps its own reply state ("replied" until Mandala has followed up, then "summarized")
 * until the user writes in the chat directly; after that the chat's own execution decides.
 */
export function collabChatStatus(row:ConversationProgress,tasks:readonly Task[]):CollabChatStatus{
 if(row.executionStatus==='approval')return 'approval';
 if(row.executionStatus==='running')return 'running';
 if(row.executionStatus==='error')return 'failed';
 const handoff=row.handoff,direct=!!row.directUserAt&&(!handoff||row.directUserAt>handoff.createdAt);
 if(handoff&&!direct){
  if(handoff.state==='queued')return 'queued';
  if(handoff.state==='running')return 'running';
  if(handoff.state==='failed')return 'failed';
  if(handoff.state==='unknown')return 'attention';
  return handoff.replyState==='consumed'?'summarized':'replied';
 }
 if(direct){
  if(row.state==='queued')return 'queued';
  if(row.state==='attention')return 'attention';
  return row.activityAt>row.directUserAt!?'replied':'idle';
 }
 const state=executionChatState(row,tasks);
 return state==='todo'||state==='cancelled'?'idle':state;
}

const latest=(...values:(string|null|undefined)[])=>values.filter(Boolean).sort().at(-1)??'';
const taskOpenStates=new Set<CollabChatStatus>(['queued','running','approval','attention','failed']);
export function taskNeedsYou(task:Task,chats:readonly CollabChat[]){
 return task.state==='review'||task.state==='waiting'&&(task.waitingReason==='input'||task.waitingReason==='approval')||chats.some(chat=>collabChatNeedsYou(chat.status));
}

/**
 * Needs you first, then live work by its latest change, then finished work.
 * Standalone chats come from a Mandala handoff; Task chats stay under their Task.
 */
export function collabSections({conversationId,scope,goals,tasks,rows,runs=[],query='',names=()=>[]}:{
 conversationId:string;scope:CollabScope;goals:readonly MandalaGoal[];tasks:readonly Task[];rows:readonly ConversationProgress[];runs?:readonly AutomationRun[];query?:string;
 names?:(ids:{agentIds:string[];projectIds:string[]})=>(string|undefined)[];
}):CollabSections{
 const goalByTask=new Map(goals.map(goal=>[goal.taskId,goal]));
 const owned=tasks.filter(task=>goalByTask.has(task.id)&&(scope==='all'||goalByTask.get(task.id)!.conversationId===conversationId));
 const q=query.trim().toLocaleLowerCase(),hit=(texts:(string|null|undefined)[])=>!q||texts.some(text=>text?.toLocaleLowerCase().includes(q));
 const chatTexts=(row:ConversationProgress)=>[row.title,row.requestPreview,...names({agentIds:[row.agentId],projectIds:[row.attributedProjectId??row.projectId]})];
 const items:CollabItem[]=[];
 for(const task of owned){
  const chats=executionChatsFor(task.id,tasks,rows,conversationId).map(row=>({row,status:collabChatStatus(row,tasks)}));
  const taskTexts=[task.goal,...names({agentIds:[task.assigneeAgentId??''],projectIds:task.projectIds??[]})];
  if(!hit(taskTexts)&&!chats.some(chat=>hit(chatTexts(chat.row))))continue;
  const needsYou=taskNeedsYou(task,chats);
  items.push({kind:'task',id:task.id,at:latest(task.activityAt,task.createdAt,...chats.map(chat=>chat.row.activityAt)),task,goal:goalByTask.get(task.id),chats,needsYou,
   defaultOpen:chats.length>0&&(needsYou&&chats.some(chat=>collabChatNeedsYou(chat.status))||chats.some(chat=>taskOpenStates.has(chat.status)||chat.row.hasNewActivity))});
 }
 for(const row of rows){
  if(row.taskIds.length||!row.handoff||row.id===conversationId)continue;
  if(scope==='conversation'&&row.handoff.sourceConversationId!==conversationId)continue;
  if(!hit(chatTexts(row)))continue;
  items.push({kind:'chat',id:row.id,at:row.activityAt,chat:{row,status:collabChatStatus(row,tasks)}});
 }
 const ownedIds=new Set(owned.map(task=>task.id));
 for(const run of runs){
  if(run.taskState!=='review'||run.taskId&&ownedIds.has(run.taskId))continue;
  if(scope==='conversation'&&run.reportConversationId!==conversationId)continue;
  if(!hit([run.name]))continue;
  items.push({kind:'run',id:run.id,at:latest(run.finishedAt,run.startedAt,run.createdAt),run});
 }
 const sections:CollabSections={needs:[],active:[],done:[]};
 for(const item of items){
  if(item.kind==='run'){sections.needs.push(item);continue;}
  if(item.kind==='task'){
   if(item.task.state==='completed'||item.task.state==='cancelled')sections.done.push(item);
   else (item.needsYou?sections.needs:sections.active).push(item);
   continue;
  }
  const {row,status}=item.chat;
  if(collabChatNeedsYou(status))sections.needs.push(item);
  else if(row.state==='completed'||!row.active&&status!=='running'&&status!=='queued')sections.done.push(item);
  else sections.active.push(item);
 }
 const byLatest=(a:CollabItem,b:CollabItem)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id);
 sections.needs.sort(byLatest);sections.active.sort(byLatest);sections.done.sort(byLatest);
 return sections;
}
export const collabCount=(sections:CollabSections)=>sections.needs.length+sections.active.length+sections.done.length;
