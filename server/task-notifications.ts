import type {Store} from './store';
import type {createTasks} from './tasks';
import {DomainError,type Principal} from '../shared/workspace-contracts';
import type {TaskNotice,TaskNotices} from '../shared/task-notifications';
import type {Approval} from '../shared/types';
import {nativeQuestions} from '../shared/questions';

const preview=(value:unknown)=>typeof value==='string'?value.trim().replace(/\s+/g,' ').slice(0,200)||undefined:undefined;
const inaccessible=(error:unknown)=>error instanceof DomainError&&[403,404].includes(error.status);

const relevantEvents=new Set([
 'task.run_terminal','task.execution_attention','task.execution_resumed','task.recovery_unknown','task.input_requested',
 'task.complete','task.accept','task.request_changes','task.reopen','task.cancelled','task.stopped','task.run_queued','task.updated','task.progress_updated',
]);

function approvalNotice(store:Store,chatId:string,runId:string,approvalId:string|null){
 const event=store.database.prepare(`SELECT data FROM events WHERE conversationId=? AND kind='approval' AND superseded=0
  AND json_extract(data,'$.runId')=? AND (? IS NULL OR json_extract(data,'$.id')=?) ORDER BY id DESC LIMIT 1`).get(chatId,runId,approvalId,approvalId);
 if(!event)return;
 const approval=JSON.parse(String(event.data)) as Approval,question=nativeQuestions(approval)[0];
 const params=approval.params as {reason?:string;command?:string;message?:string;title?:string;toolCall?:{title?:string}}|null;
 return {id:approval.id,state:question?'input':'approval',detail:preview(question?.question??params?.reason??params?.message??params?.toolCall?.title??params?.title??params?.command)};
}

export function taskNotifications(store:Store,tasks:ReturnType<typeof createTasks>,principal:Principal,after?:number,authorizeConversation?:(id:string)=>void,shown:number[]=[]):TaskNotices {
 if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))throw new DomainError('invalid_cursor',422,'invalid_cursor');
 if(shown.length>50||shown.some(sequence=>!Number.isSafeInteger(sequence)||sequence<=0||sequence>(after??0)))throw new DomainError('invalid_cursor',422,'invalid_cursor');
 const db=store.database,head=Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS head FROM outbox').get()!.head);
 if(after===undefined||after>=head)return {cursor:head,items:[]};
 const columns='sequence,id,type,payload,aggregate_revision,created_at';
 const rows=db.prepare('SELECT '+columns+' FROM outbox WHERE sequence>? ORDER BY sequence LIMIT 100').all(after);
 const recheck=shown.length>0&&rows.some(row=>['asset.access_changed','asset.lifecycle_changed'].includes(String(row.type)));
 const visible=recheck?db.prepare('SELECT '+columns+' FROM outbox WHERE sequence IN (SELECT value FROM json_each(?)) ORDER BY sequence').all(JSON.stringify(shown)):[];
 const items=new Map<string,TaskNotice>(),retired=new Set<string>();
 const taskStates=new Map<string,{task:ReturnType<typeof tasks.getTask>;delivery:ReturnType<typeof tasks.getReviewDelivery>}>();
 const retire=(scope:string)=>{retired.add(scope);items.delete(scope);};
 for(const row of [...visible,...rows]){
  const type=String(row.type);
  if(!relevantEvents.has(type))continue;
  const payload=JSON.parse(row.payload as string);
  let runId=typeof payload.runId==='string'?payload.runId:null;
  if(typeof payload.taskId!=='string')continue;
  try {
   let snapshot=taskStates.get(payload.taskId);
   if(!snapshot){
    const task=tasks.getTask(principal,payload.taskId);
    snapshot={task,delivery:task.state==='review'?tasks.getReviewDelivery(principal,task.id):null};
    taskStates.set(task.id,snapshot);
   }
   const {task,delivery}=snapshot,reviewScope='review:'+task.id,waitingScope='waiting:'+task.id,approvalScope='approval:'+task.id+':'+runId;
   const leavesReview=['task.accept','task.request_changes','task.run_queued','task.cancelled'].includes(type);
   if(!delivery||leavesReview)retire(reviewScope);
   const leavesWaiting=leavesReview||['task.complete','task.stopped','task.reopen'].includes(type)||['task.updated','task.progress_updated','task.run_terminal'].includes(type)&&payload.state&&payload.state!=='waiting';
   if(task.state!=='waiting'||leavesWaiting)retire(waitingScope);
   if(runId&&['task.execution_resumed','task.run_terminal','task.cancelled','task.stopped','task.recovery_unknown'].includes(type))retire(approvalScope);
   const base={sequence:Number(row.sequence),taskId:task.id,goal:task.goal.split('\n')[0].slice(0,160),createdAt:row.created_at as string};
   if(type==='task.input_requested'){
    retire(waitingScope);
    if(task.state!=='waiting'||(!authorizeConversation&&principal.userId!==store.ownerUserId))continue;
    const superseded=db.prepare(`SELECT 1 FROM outbox WHERE aggregate_id=? AND sequence>? AND (
     type IN ('task.input_requested','task.run_queued','task.complete','task.accept','task.cancelled','task.stopped','task.reopen','task.request_changes') OR
     (type IN ('task.updated','task.progress_updated','task.run_terminal') AND json_extract(payload,'$.state')<>'waiting')) LIMIT 1`).get(task.id,row.sequence);
    if(superseded)continue;
    const chatId=payload.conversationId;
    authorizeConversation?.(chatId);
    const event=store.listEvents(chatId,payload.eventId-1,1)[0];
    const question=event?.data as {mandalaRequest?:{taskId:string;text:string}}|undefined;
    if(event?.id===payload.eventId&&event.kind==='metadata'&&question?.mandalaRequest?.taskId===task.id){
     items.set(waitingScope,{...base,runId:null,id:waitingScope+':'+event.id,decisionScope:waitingScope,state:'input',detail:preview(question.mandalaRequest.text),replyConversationId:chatId});
    }
    continue;
   }
   const review=type==='task.complete'||type==='task.progress_updated'&&payload.state==='review';
   if(!review&&!['task.run_terminal','task.execution_attention','task.recovery_unknown'].includes(type))continue;
   let state=review?'review':typeof payload.state==='string'?payload.state:'waiting';
   if(type==='task.run_terminal'&&state==='todo'&&runId){
    const run=tasks.getRunControl(principal,runId);
    if(run.taskId!==task.id)continue;
    state=run.state;
   }
   if(!['completed','review','waiting','approval','failed','succeeded','unknown','input'].includes(state))continue;
   if(state==='review'){
    if(!delivery)continue;
    runId=delivery.runId;
   }
   if(['waiting','input'].includes(state)&&task.state!=='waiting')continue;
   const decisionScope=state==='review'?reviewScope:['waiting','input'].includes(state)?waitingScope:state==='approval'&&runId?approvalScope:undefined;
   let id=decisionScope?decisionScope+':'+(runId??payload.occurrenceId??(state==='review'?'manual:'+row.aggregate_revision:row.id)):String(row.id);
   let executionConversationId:string|undefined,detail:string|undefined,title=base.goal.slice(0,80);
   if(runId){
    try{
     const run=tasks.getRunControl(principal,runId);
     if(run.taskId===task.id&&run.routing){
      if(state==='approval'&&run.state!=='approval'||type==='task.recovery_unknown'&&run.state!=='unknown')continue;
      if(state==='approval'&&payload.approvalId){
       const latest=db.prepare("SELECT json_extract(payload,'$.approvalId') AS id FROM outbox WHERE type='task.execution_attention' AND aggregate_id=? AND json_extract(payload,'$.runId')=? AND json_extract(payload,'$.state')='approval' ORDER BY sequence DESC LIMIT 1").get(task.id,runId);
       if(latest?.id!==payload.approvalId)continue;
      }
      const chatId=run.routing.executionConversationId;authorizeConversation?.(chatId);
      if(state==='approval')executionConversationId=chatId;
      if(principal.userId===store.ownerUserId||authorizeConversation){
       title=store.getConversation(chatId)?.title?.trim()||title;
       if(state==='approval'){
        const request=approvalNotice(store,chatId,runId,payload.approvalId??null);
        if(request){state=request.state;detail=request.detail;id=approvalScope+':'+request.id;}
       }else if(state==='review'||state==='waiting'||state==='failed')detail=preview(tasks.getRun(principal,runId).summary);
      }
     }
    }catch(error){if(!inaccessible(error))throw error;}
   }
   if(state==='waiting'&&task.waitingReason==='input'&&runId&&db.prepare('SELECT 1 FROM task_inquiry_waits WHERE run_id=?').get(runId))continue;
   const reason=state==='waiting'?task.waitingReason??undefined:undefined;
   items.set(decisionScope??id,{...base,runId,id,decisionScope,executionConversationId,title,state,detail,reason});
  }catch(error){if(!inaccessible(error))throw error;}
 }
 return {cursor:Number(rows.at(-1)?.sequence??head),items:[...items.values()],...(recheck?{rechecked:shown}:{}),...(retired.size?{retired:[...retired]}:{})};
}
