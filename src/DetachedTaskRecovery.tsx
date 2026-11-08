import { useState } from 'react';
import type { DraftScope } from '../shared/drafts';
import type { QueuedInput } from '../shared/tasks';
import { api } from './api';
import { useComposerDraft,useComposerDraftIdentity } from './composer-drafts';
import ComposerRecovery from './ComposerRecovery';
import { useLanguage } from './i18n';
import Button from './ui/Button';
import Notice from './ui/Notice';
import Icon from './ui/Icon';
export default function DetachedTaskRecovery({scope,onResolved}:{scope:DraftScope;onResolved:()=>void}) {
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const draft=useComposerDraft(scope,useComposerDraftIdentity()),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const check=async()=>{
  if(!draft.pending||busy)return;setBusy(true);setMessage('');
  try{
   const entries=await api<QueuedInput[]>('/conversations/'+scope.conversationId+'/queue'),entry=entries.find(item=>item.commandKey===draft.pending!.commandKey);
   if(entry&&['queued','running','completed'].includes(entry.state)&&!entry.unrecorded){await draft.clearStoredIfMatch(draft.pending.draftFingerprint);await draft.savePending(null);onResolved();}
   else setMessage(say('尚未确认原提交。请查看对话历史，核对后可明确结束恢复。不会重新发送。','The original submission remains unconfirmed. Inspect Chat history and explicitly resolve recovery when ready. Nothing is resent.'));
  }catch(reason){setMessage((reason as Error).message);}finally{setBusy(false);}
 };
 return <section className="detached-task-recovery" aria-label={say('已解绑对话的待确认提交','Pending submission in an unlinked Chat')}><strong><Icon name="message" size={14}/>{say('已解绑对话仍有待确认提交','An unlinked Chat has a pending submission')}</strong><p className="field-hint">{say('这里只可核对原记录或结束恢复；不能向已解绑对话发送回复。','You can check the original record or resolve recovery here. Sending to this unlinked Chat is unavailable.')}</p>
  <ComposerRecovery draft={draft} onResolved={onResolved}/><Button disabled={!draft.loaded||!draft.pending||busy} onClick={()=>void check()}><Icon name="refresh" size={14}/>{say('只核对原提交','Check original submission only')}</Button>{message&&<Notice>{message}</Notice>}
 </section>;
}
