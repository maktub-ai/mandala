import {liveInquiryWaitSql} from './task-progress-view';
import type {Store} from './store';
import type {SessionManager} from './sessions';
import type {ConversationProgress,ConversationProgressAction,LatestProgress} from '../shared/conversation-progress';
import {DomainError} from '../shared/workspace-contracts';
import {workspacePrincipal} from './workspace-identity';
import {hasBlockingApprovals} from '../shared/questions';
import {groupChatTurns} from '../shared/chat-turns';
import {presentTurnText} from '../shared/conversation-output';

// Shared with inquiry settlement; records a display decision without stopping execution.
export function markConversationProgress(store:Store,id:string,completed:boolean,now=new Date().toISOString()){
 const db=store.database;
 initializeProgress(store);
 const cursors=db.prepare(`SELECT COALESCE(MAX(id),0) AS cursor,
  COALESCE(MAX(CASE WHEN kind='user' AND json_extract(data,'$.agentMessage') IS NULL AND json_extract(data,'$.task') IS NULL THEN id ELSE 0 END),0) AS user_cursor
  FROM events WHERE conversationId=? AND superseded=0`).get(id)!;
 const input=db.prepare("SELECT COALESCE(MAX(rowid),0) AS cursor FROM task_user_inputs i WHERE conversation_id=? AND NOT EXISTS(SELECT 1 FROM agent_messages m WHERE m.request_input_id=i.id OR m.reply_input_id=i.id)").get(id)!;
 db.prepare('INSERT INTO conversation_progress(conversation_id,visited_at,completed_at,event_cursor,user_cursor,input_cursor,changed_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET visited_at=excluded.visited_at,completed_at=excluded.completed_at,event_cursor=excluded.event_cursor,user_cursor=excluded.user_cursor,input_cursor=excluded.input_cursor,changed_at=excluded.changed_at')
  .run(id,now,completed?now:null,Number(cursors.cursor),Number(cursors.user_cursor),Number(input.cursor),now);
}
function initializeProgress(store:Store){
 const db=store.database;
 db.exec(`CREATE TABLE IF NOT EXISTS conversation_progress (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), visited_at TEXT,
  completed_at TEXT, event_cursor INTEGER NOT NULL DEFAULT 0, user_cursor INTEGER NOT NULL DEFAULT 0, input_cursor INTEGER NOT NULL DEFAULT 0);`);
 if(!db.prepare('PRAGMA table_info(conversation_progress)').all().some(r=>r.name==='input_cursor'))db.exec('ALTER TABLE conversation_progress ADD COLUMN input_cursor INTEGER NOT NULL DEFAULT 0');
 if(!db.prepare('PRAGMA table_info(conversation_progress)').all().some(r=>r.name==='changed_at'))db.exec('ALTER TABLE conversation_progress ADD COLUMN changed_at TEXT');
 db.exec('CREATE INDEX IF NOT EXISTS progress_user_input_state ON task_user_inputs(conversation_id,state)');
}

// These markers only control the progress view, never execution or Task acceptance.
export function createConversationProgress(store:Store,manager:SessionManager){
 const db=store.database;
 initializeProgress(store);
 const userInputCursor=db.prepare("SELECT COALESCE(MAX(rowid),0) AS cursor FROM task_user_inputs i WHERE conversation_id=? AND NOT EXISTS(SELECT 1 FROM agent_messages m WHERE m.request_input_id=i.id OR m.reply_input_id=i.id)");
 const activity=db.prepare(`SELECT MAX(id) AS cursor,
  MAX(CASE WHEN kind='user' AND json_extract(data,'$.agentMessage') IS NULL AND json_extract(data,'$.task') IS NULL THEN id ELSE 0 END) AS user_cursor,
  MAX(CASE WHEN kind IN ('user','text','status','approval','error') THEN createdAt END) AS at,
  MAX(CASE WHEN kind IN ('user','text') OR kind='tool' AND json_extract(data,'$.method')='item/completed' AND json_extract(data,'$.params.item.type')='agentMessage'
   OR kind='metadata' AND json_extract(data,'$.agentMessage.direction')='reply' AND json_extract(data,'$.agentMessage.state') IN ('succeeded','failed') AND json_extract(data,'$.agentMessage.reply') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM events prior WHERE prior.conversationId=events.conversationId AND prior.superseded=0 AND prior.id<events.id AND prior.kind='metadata'
     AND json_extract(prior.data,'$.agentMessage.direction')='reply' AND json_extract(prior.data,'$.agentMessage.state') IN ('succeeded','failed') AND json_extract(prior.data,'$.agentMessage.id')=json_extract(events.data,'$.agentMessage.id')
     AND json_extract(prior.data,'$.agentMessage.reply')=json_extract(events.data,'$.agentMessage.reply')) THEN createdAt END) AS message_at,
  MAX(CASE WHEN kind='text' OR kind='tool' AND json_extract(data,'$.method')='item/completed' AND json_extract(data,'$.params.item.type')='agentMessage' OR kind='metadata' AND json_extract(data,'$.agentMessage.direction')='reply' THEN id ELSE 0 END) AS reply_cursor
  FROM events WHERE conversationId=? AND superseded=0`);
 const inputStates=db.prepare("SELECT MAX(state='unknown') AS unknown_input,MAX(state IN ('queued','running')) AS pending_input FROM task_user_inputs WHERE conversation_id=? AND state IN ('queued','running','unknown')");
 const preview=db.prepare("SELECT SUBSTR(json_extract(data,'$.text'),1,240) AS text FROM events WHERE conversationId=? AND superseded=0 AND kind='user' AND json_extract(data,'$.agentMessage') IS NULL AND json_extract(data,'$.task') IS NULL ORDER BY id DESC LIMIT 1");
 const explicitProgress=db.prepare("SELECT id,data,createdAt FROM events WHERE conversationId=? AND kind='progress' AND superseded=0 ORDER BY id DESC LIMIT 1");
 const turnHead=db.prepare("SELECT id,data FROM events WHERE conversationId=? AND superseded=0 AND (kind='user' OR kind='metadata' AND json_extract(data,'$.execution')='started') ORDER BY id DESC LIMIT 1");
 const latestOutputs=new Map<string,{cursor:number;status:string;value:LatestProgress|null}>();
 const read=(id:string)=>activity.get(id)!;
 return {
  list({now=new Date().toISOString(),windowMinutes=360}:{now?:string;windowMinutes?:number}={}):ConversationProgress[]{
   const tasks=manager.taskService.listTasks(workspacePrincipal(store)),rows:ConversationProgress[]=[];
   for(const chat of store.listConversations()){
    if(chat.archivedAt||chat.purpose==='mandala-main')continue;
    try{manager.authorizeConversationRead(chat.id);}catch{continue;}
    const events=read(chat.id),marker=db.prepare('SELECT * FROM conversation_progress WHERE conversation_id=?').get(chat.id);
    const inputs=inputStates.get(chat.id)!,approvals=manager.getApprovals(chat.id);
    const completed=!!marker?.completed_at&&Number(events.user_cursor)<=Number(marker.user_cursor)&&Number(userInputCursor.get(chat.id)!.cursor)<=Number(marker.input_cursor);
    const helper=db.prepare("SELECT MAX(state='unknown' OR reply_state='queued' AND EXISTS(SELECT 1 FROM task_user_inputs i WHERE i.id=agent_messages.reply_input_id AND i.state='unknown')) AS unknown_helper,MAX(state IN ('queued','running') OR reply_state='queued' AND auto_resume_allowed=1 AND EXISTS(SELECT 1 FROM task_user_inputs i WHERE i.id=agent_messages.reply_input_id AND i.state IN ('queued','running'))) AS live_helper FROM agent_messages WHERE source_conversation_id=? AND (state IN ('queued','running','unknown') AND reply_state<>'parked' OR reply_state='queued' AND auto_resume_allowed=1) HAVING COUNT(*)>0").get(chat.id);
    const delegated=db.prepare("SELECT MAX(state<>'unknown') AS live_run,MAX(state='unknown') AS unknown_run FROM task_runs WHERE json_extract(routing,'$.destinationConversationId')=? AND state IN ('queued','starting','running','approval','unknown') AND (continuation IS NULL OR EXISTS(SELECT 1 FROM work_tasks p WHERE p.id=json_extract(continuation,'$.taskId') AND p.continuation_epoch=json_extract(continuation,'$.epoch') AND p.state NOT IN ('completed','cancelled') AND (json_extract(continuation,'$.policy')<>'resume' OR p.future_auto_resume=1))) HAVING COUNT(*)>0").get(chat.id);
    const inquiry=db.prepare(liveInquiryWaitSql+" AND json_extract(r.routing,'$.destinationConversationId')=? AND (r.continuation IS NULL OR EXISTS(SELECT 1 FROM work_tasks p WHERE p.id=json_extract(r.continuation,'$.taskId') AND p.continuation_epoch=json_extract(r.continuation,'$.epoch') AND p.state NOT IN ('completed','cancelled') AND (json_extract(r.continuation,'$.policy')<>'resume' OR p.future_auto_resume=1))) LIMIT 1").get(chat.id);
    const receipt=db.prepare("SELECT r.id FROM task_receipts r JOIN work_tasks t ON t.id=r.task_id WHERE destination_conversation_id=? AND policy='resume' AND (r.delivery_state='pending' OR r.delivery_state='presented' AND EXISTS(SELECT 1 FROM task_runs c WHERE c.id=r.claimed_by_run_id AND c.state IN ('queued','starting','running','approval'))) AND t.future_auto_resume=1 AND r.captured_epoch=t.continuation_epoch AND t.state NOT IN ('completed','cancelled') LIMIT 1").get(chat.id);
    const live=chat.status==='running'||chat.status==='approval'||hasBlockingApprovals(approvals)||Boolean(inputs.pending_input)||Boolean(helper?.live_helper)||Boolean(delegated?.live_run)||Boolean(receipt)||Boolean(inquiry);
    const reopenState:ConversationProgress['reopenState']=hasBlockingApprovals(approvals)||chat.status==='approval'?'attention':chat.status==='running'?'running':
     Boolean(inputs.unknown_input)||['error','interrupted'].includes(chat.status)||Boolean(helper?.unknown_helper)||Boolean(delegated?.unknown_run)?'attention':
     Boolean(inputs.pending_input)?'queued':helper||delegated||receipt||inquiry?'waiting':'recent';
    const state:ConversationProgress['state']=reopenState==='attention'&&(hasBlockingApprovals(approvals)||chat.status==='approval')?'attention':completed?'completed':reopenState;
    // Viewing history never extends its recent window; explicit complete/reopen actions do.
    const at=events.message_at as string||chat.createdAt;
    const recentAt=[events.at as string,(marker?.changed_at??marker?.completed_at) as string,at].filter(Boolean).sort().at(-1)!;
    const withinWindow=Date.parse(now)-Date.parse(recentAt)<windowMinutes*60000;
    const executionTask=tasks.find(task=>task.conversationIds.includes(chat.id));
    const taskIds=executionTask?[executionTask.id]:[];
    const related=new Set<string>();
    for(const m of db.prepare('SELECT source_conversation_id,target_conversation_id FROM agent_messages WHERE source_conversation_id=? OR target_conversation_id=?').all(chat.id,chat.id))related.add((m.source_conversation_id===chat.id?m.target_conversation_id:m.source_conversation_id) as string);
    const relatedConversationIds=[...related].filter(id=>{try{manager.authorizeConversationRead(id);return true;}catch{return false;}});
    const cached=latestOutputs.get(chat.id),cursor=Number(events.cursor??0);
    let latestProgress=cached?.cursor===cursor&&cached.status===chat.status?cached.value:undefined;
    if(latestProgress===undefined){
     const report=explicitProgress.get(chat.id);
     const data=report?JSON.parse(report.data as string) as {text:string;source:'cli';runId:string;steps?:import('../shared/conversation-progress').ProgressStep[]}:undefined;
     const head=turnHead.get(chat.id),runId=head?(JSON.parse(head.data as string) as {runId?:string}).runId:undefined;
     const turnEvents=store.listEvents(chat.id,head?Number(head.id)-1:0).filter(event=>!runId||!(event.data as {runId?:string}).runId||(event.data as {runId?:string}).runId===runId);
     const turn=groupChatTurns(turnEvents).at(-1);
     latestProgress=turn?presentTurnText(turn,chat.status).latestProgress:null;
     if(report&&data&&(!runId||data.runId===runId)&&(!latestProgress||Number(report.id)>latestProgress.sourceEventId))latestProgress={text:data.text,updatedAt:report.createdAt as string,source:data.source,runId:data.runId,sourceEventId:Number(report.id),...(data.steps?{steps:data.steps}:{}),historical:false};
     if(latestProgress&&!latestProgress.runId)latestProgress.runId=runId??'';
     latestOutputs.set(chat.id,{cursor,status:chat.status,value:latestProgress});
    }
    if(latestProgress)latestProgress={...latestProgress};
    if(latestProgress)latestProgress.historical=!['running','approval'].includes(chat.status)||!manager.executionId(chat.id)||manager.executionId(chat.id)!==latestProgress.runId;
    rows.push({executionStatus:chat.status??null,latestProgress,id:chat.id,title:chat.title,agentId:chat.agentId,projectId:chat.projectId,cli:chat.cli,state,reopenState,
     live,active:state!=='completed'&&(live||withinWindow),withinWindow,activityAt:at,
     requestPreview:preview.get(chat.id)?.text as string??null,completedAt:completed?marker!.completed_at as string:null,hasNewActivity:completed&&Number(events.reply_cursor)>Number(marker!.event_cursor),taskIds,relatedConversationIds});
   }
   return rows.sort((a,b)=>b.activityAt.localeCompare(a.activityAt)||a.id.localeCompare(b.id));
  },
  update(id:string,input:ConversationProgressAction,now=new Date().toISOString()){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='action')||!['visit','complete','reopen'].includes(input.action))throw new DomainError('invalid_progress_action',422,'Invalid progress action');
   if(!store.getConversation(id))throw new DomainError('conversation_not_found',404,'Conversation not found');
   manager.authorizeConversationRead(id);
   store.transaction(()=>{
    if(input.action==='visit')db.prepare('INSERT INTO conversation_progress(conversation_id,visited_at) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET visited_at=excluded.visited_at').run(id,now);
    else markConversationProgress(store,id,input.action==='complete',now);
   });
  },
 };
}
