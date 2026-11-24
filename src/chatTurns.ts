export * from '../shared/chat-turns';

import { unsubmittedCodexMailboxCode } from '../shared/codex-mailbox-errors';
import type { ChatTurn } from '../shared/chat-turns';

// Presentation can regroup late events under an earlier turn. Look at event IDs,
// not the order of the rendered turns, before exposing a saved request.
export function recoverableUnsubmittedDraft(turns:readonly ChatTurn[],status?: string):number|undefined {
 if(status!=='error')return;
 let latest:{turn:ChatTurn;failure:ChatTurn['events'][number]}|undefined;
 for(const turn of turns)for(const event of turn.events)
  if(event.kind==='error'&&(!latest||event.id>latest.failure.id))latest={turn,failure:event};
 if(!latest)return;
 const {turn,failure}=latest;
 const data=failure.data as {code?:string;nativeTurnSubmitted?:boolean;runId?:string;queuedInputId?:unknown}|null;
 const mailbox=unsubmittedCodexMailboxCode(data);
 if(!data?.runId||data.nativeTurnSubmitted!==false||(!mailbox&&data.code!=='native_thread_busy'))return;
 let terminalErrorSeen=false;
 for(const candidate of turns)for(const event of candidate.events){
  if(event.id<=failure.id)continue;
  if(event.conversationId!==failure.conversationId)return;
  const subsequent=event.data as {agentMessage?:{direction?:string;replyState?:string};runId?:unknown;execution?:unknown;status?:string}|null;
  if(event.kind==='metadata'&&subsequent?.agentMessage?.direction==='reply'&&subsequent.agentMessage.replyState==='parked'&&
     subsequent.runId===undefined&&subsequent.execution===undefined)continue;
  if(event.kind==='status'&&!terminalErrorSeen&&subsequent?.status==='error'&&
     (subsequent.runId===undefined||subsequent.runId===data.runId)){terminalErrorSeen=true;continue;}
  return;
 }
 const users=turn.events.filter(event=>event.kind==='user');
 const user=users.length===1?users[0]:undefined;
 if(!user||user.id>=failure.id||user.conversationId!==failure.conversationId||(user.data as {runId?:string})?.runId!==data.runId)return;
 // A queued request already belongs to the scheduler, not to the composer.
 if(mailbox&&(data.queuedInputId!==undefined||(user.data as {queuedInputId?:unknown}).queuedInputId!==undefined))return;
 const message=turn.messages.find(message=>message.key===user.id&&message.kind==='user');
 return message&&!message.source&&!message.task&&!message.agentMessage?message.key:undefined;
}
