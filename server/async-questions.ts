import { createHash } from 'node:crypto';
import type { Approval } from '../shared/types';
import { nativeQuestions, questionResponse } from '../shared/questions';
import type { Store } from './store';

export function initializeAsyncQuestions(store:Store) {
  store.database.exec(`CREATE TABLE IF NOT EXISTS async_question_migration(singleton INTEGER PRIMARY KEY CHECK(singleton=1),event_id INTEGER NOT NULL);
    INSERT OR IGNORE INTO async_question_migration SELECT 1,COALESCE(MAX(id),0) FROM events;`);
}

// Async questions are messages, not live RPC requests. Read their durable events
// so finishing a turn or restarting the service does not discard unanswered forms.
export function asyncQuestions(store:Store,conversationId:string):Approval[] {
  const chat=store.getConversation(conversationId);
  if(!chat||chat.cli!=='codex'||chat.archivedAt)return [];
  const db=store.database;
  // Legacy versions rendered forms as plain text and did not record answers.
  // Suppress only legacy forms preceding the last ordinary human request at
  // upgrade. This fixed watermark never expires newer independent forms.
  const cutoff=db.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM events WHERE conversationId=? AND kind='user'
    AND id<=(SELECT event_id FROM async_question_migration WHERE singleton=1)
    AND COALESCE(json_extract(data,'$.source.kind'),'telegram')='telegram'
    AND json_extract(data,'$.agentMessage') IS NULL AND json_extract(data,'$.task') IS NULL
    AND COALESCE(json_extract(data,'$.text'),'') NOT LIKE '<send_user_message_question_reply>%'`).get(conversationId)!.id;
  const rows=db.prepare(`SELECT data FROM events WHERE conversationId=? AND id>? AND kind='tool' AND superseded=0
    AND json_extract(data,'$.method')='item/completed'
    AND json_extract(data,'$.params.item.type')='agentMessage' ORDER BY id`).all(conversationId,cutoff);
  const pending=new Map<string,Approval>();
  for(const row of rows){
    const event=JSON.parse(row.data as string),p=event.params,item=p.item;
    if(p.threadId!==chat.nativeId||typeof p.turnId!=='string'||typeof item.id!=='string')continue;
    const id='async:'+createHash('sha256').update(JSON.stringify([p.threadId,p.turnId,item.id])).digest('hex');
    pending.delete(id);
    if(item.delivery!=='async'||typeof event.runId!=='string'||!Array.isArray(item.questions)||!item.questions.length||item.questions.length>10||
      item.questions.some((q:any)=>!q||typeof q.title!=='string'||q.options!=null&&(!Array.isArray(q.options)||q.options.some((o:unknown)=>typeof o!=='string'))))continue;
    if(db.prepare("SELECT 1 FROM events WHERE conversationId=? AND kind='metadata' AND json_extract(data,'$.answeredQuestionId')=? LIMIT 1").get(conversationId,id))continue;
    const terminal=db.prepare("SELECT data FROM events WHERE conversationId=? AND kind='status' AND json_extract(data,'$.runId')=? ORDER BY id DESC LIMIT 1").get(conversationId,event.runId);
    if(terminal&&['interrupted','error'].includes(JSON.parse(terminal.data as string).status))continue;
    const questions=item.questions.map((q:any,index:number)=>({id:String(index),header:`${index+1}`,question:q.title,
      ...(q.isSecret===true?{isSecret:true}:{}),options:q.options?.map((label:unknown)=>({label,description:''}))}));
    const approval:Approval={id,conversationId,nativeRequestId:item.id,method:'item/tool/requestUserInput',
      params:{questions,isBlocking:false,async:true,threadId:p.threadId,turnId:p.turnId,runId:event.runId}};
    if(nativeQuestions(approval).length)pending.set(id,approval);
  }
  return [...pending.values()];
}

export function asyncQuestionReply(approval:Approval,answers:unknown):string {
  const response=questionResponse(approval,answers);
  const replies=nativeQuestions(approval).map((q,index)=>({
    questionItemId:JSON.stringify(['request_user_input_async',approval.nativeRequestId,index]),
    question:q.question,answer:response.answers[q.id].answers[0],
  }));
  return '<send_user_message_question_reply>\n'+JSON.stringify(replies)+'\n</send_user_message_question_reply>';
}
