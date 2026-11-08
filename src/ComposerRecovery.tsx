import { useState } from 'react';
import type { useComposerDraft } from './composer-drafts';
import { useLanguage } from './i18n';
import Button from './ui/Button';
import Input from './ui/Input';
import Disclosure from './ui/Disclosure';
import Notice from './ui/Notice';
import Dialog from './Dialog';
import Icon from './ui/Icon';
export default function ComposerRecovery({draft,onResolved,onInspect}:{draft:ReturnType<typeof useComposerDraft>;onResolved:()=>void;onInspect?:(id:string)=>void}) {
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [confirm,setConfirm]=useState(false),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=draft.pending;if(!pending)return null;
 const inspect=()=>{const id=pending.conversationId;void draft.flush().catch(()=>{}).finally(()=>{if(onInspect)onInspect(id);else{history.pushState(null,'','/?conversation='+encodeURIComponent(id));dispatchEvent(new PopStateEvent('popstate'));}});};
 const rejected=!!pending.recovery.rejectionMessage;
 return <Notice className="composer-recovery-notice"><span>{rejected?say('原请求已被拒绝或记录无法确认。草稿保留，请查看历史后处理。','The original request was rejected or its execution record cannot be verified. Inspect history before preparing another request.'):say('上次发送结果待确认。核对只读取原记录，不会重新发送。','The previous send is unconfirmed. Checking reads its original record without sending again.')}</span>
  <Disclosure title={say('查看原请求','View original request')}><p>{pending.body.text}</p><small>{pending.body.attachments.length} {say('个已上传附件','uploaded attachments')}</small><code>{pending.commandKey}</code></Disclosure>
  <Button onClick={inspect}><Icon name="message" size={13}/>{say('查看对话历史','Inspect Chat history')}</Button>
  <Button onClick={()=>{setChecked(false);setConfirm(true);}}>{say('结束本次恢复','Resolve this recovery')}</Button>
  {confirm&&<Dialog label={say('结束本次恢复','Resolve this recovery')} locked={busy} onClose={()=>setConfirm(false)}><h2>{say('保留草稿，结束恢复','Keep the draft and resolve recovery')}</h2><p>{say('此操作只清除原提交的恢复记录。不会重新发送，也不会改变任务状态。请核对对话历史后，再明确准备新的请求。','This clears only the recovery record. It sends nothing and does not change the Task. Check Chat history before explicitly preparing another request.')}</p><label><Input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/>{say('我已检查对话历史','I have checked Chat history')}</label><div className="task-actions"><Button disabled={busy||!checked} onClick={()=>{setBusy(true);void draft.savePending(null).then(()=>{onResolved();setConfirm(false);}).catch(reason=>setError(reason.message)).finally(()=>setBusy(false));}}>{say('保留草稿并结束','Keep draft and resolve')}</Button><Button disabled={busy} onClick={()=>setConfirm(false)}>{say('取消','Cancel')}</Button></div>{error&&<p role="alert">{error}</p>}</Dialog>}
 </Notice>;
}
