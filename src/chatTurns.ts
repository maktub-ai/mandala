export * from '../shared/chat-turns';

import type { ChatTurn } from '../shared/chat-turns';

// Agent replies can be separate visible turns without submitting a new native request.
export function recoverableWriterConflictDraft(turns:readonly ChatTurn[],status?: string):number|undefined {
 if(status!=='error')return;
 const turn=[...turns].reverse().find(candidate=>!candidate.events.length||!candidate.events.every(event=>{
  if(event.kind!=='metadata')return false;
  const data=event.data as {agentMessage?:{direction?:string;replyState?:string};runId?:unknown;execution?:unknown}|null;
  return data?.agentMessage?.direction==='reply'&&data.agentMessage.replyState==='parked'&&data.runId===undefined&&data.execution===undefined;
 }));
 const failure=turn?.events.slice().reverse().find(event=>event.kind==='error');
 const data=failure?.data as {code?:string;nativeTurnSubmitted?:boolean;runId?:string}|undefined;
 if(!turn||!failure||data?.code!=='native_thread_busy'||data.nativeTurnSubmitted!==false||!data.runId)return;
 const users=turn.events.filter(event=>event.kind==='user');
 const user=users.length===1?users[0]:undefined;
 if(!user||user.id>=failure.id||user.conversationId!==failure.conversationId||(user.data as {runId?:string})?.runId!==data.runId)return;
 const message=turn.messages.find(message=>message.key===user.id&&message.kind==='user');
 return message&&!message.source&&!message.task&&!message.agentMessage?message.key:undefined;
}
