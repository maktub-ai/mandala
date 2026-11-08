import type { Attachment } from '../shared/chat-input';
import { submitChatInput, type SubmissionRecovery } from './chat-send';
import type { PendingComposerSubmission } from './composer-drafts';
export type ComposerSubmission = {conversationId:string;commandKey:string;draftFingerprint?:string;text:string;attachments:Attachment[];references:{id:string}[];action:'queue'|'continue'|'interrupt';recovery:SubmissionRecovery};
export const pendingSubmission = (request:ComposerSubmission):PendingComposerSubmission => ({conversationId:request.conversationId,commandKey:request.commandKey,...request.draftFingerprint?{draftFingerprint:request.draftFingerprint}:{},action:request.action,body:{text:request.text,attachments:request.attachments.map(item=>item.id),references:request.references.map(item=>item.id)},recovery:{attempted:!!request.recovery.attempted,stopAttempted:!!request.recovery.stopAttempted,stopConfirmed:!!request.recovery.stopConfirmed,...request.recovery.expectedExecutionId?{expectedExecutionId:request.recovery.expectedExecutionId}:{},...request.recovery.rejection?{rejectionMessage:request.recovery.rejection.message}:{}}});
export const restoreSubmission = (pending:PendingComposerSubmission):ComposerSubmission => ({conversationId:pending.conversationId,commandKey:pending.commandKey,...pending.draftFingerprint?{draftFingerprint:pending.draftFingerprint}:{},text:pending.body.text,attachments:pending.body.attachments.map(id=>({id,name:'',size:0,mimeType:''})),references:pending.body.references.map(id=>({id})),action:pending.action,recovery:{attempted:pending.recovery.attempted,stopAttempted:pending.recovery.stopAttempted,stopConfirmed:pending.recovery.stopConfirmed,expectedExecutionId:pending.recovery.expectedExecutionId,...pending.recovery.rejectionMessage?{rejection:new Error(pending.recovery.rejectionMessage)}:{}}});
export async function uploadComposerFiles(fetcher:typeof fetch,conversationId:string,files:File[],uploaded:Attachment[]=[]) {
 for(const file of files.slice(uploaded.length)) {
  const response=await fetcher('/api/conversations/'+conversationId+'/attachments?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
  const attachment=await response.json();if(!response.ok)throw Object.assign(new Error(attachment.error??`HTTP ${response.status}`),{status:response.status});uploaded.push(attachment);
 }
 return uploaded;
}
/** Every mutation checkpoints its original identity first; retry only reconciles that identity. */
export async function submitComposerInput(call:(path:string,method:'POST'|'GET',body?:unknown)=>Promise<unknown>,request:ComposerSubmission,persist:(pending:PendingComposerSubmission|null)=>Promise<void>,onAccepted:()=>Promise<void>) {
 await persist(pendingSubmission(request));
 try {
  const result=await submitChatInput(async(path,method,body)=>{if(method==='POST')await persist(pendingSubmission(request));return call(path,method,body);},request.conversationId,{text:request.text,attachments:request.attachments.map(item=>item.id),references:request.references,commandKey:request.commandKey},request.action,request.recovery);
  await onAccepted();
  await persist(null);return result;
 }catch(reason){
  if(!request.recovery.attempted&&(!request.recovery.stopAttempted||request.recovery.stopConfirmed))await persist(null);
  else await persist(pendingSubmission(request));
  throw reason;
 }
}
export function submissionError(error:unknown,en:boolean) {
 const message=(error as Error).message;
 if(message.includes('停止状态待确认')||message.includes('停止尚未确认'))return en?'The stop result is unconfirmed. Inspect the Chat before sending again.':message;
 if(message.includes('提交状态待确认'))return en?'Send result is unconfirmed. Check the original submission; it will not be sent again.':message;
 if(message.includes('提交未执行'))return en?'The submission was cancelled. Your draft is retained.':message;
 if(message.includes('无法确认执行记录'))return en?'The execution record is unconfirmed. Inspect the Chat before preparing another request.':message;
 return message;
}
