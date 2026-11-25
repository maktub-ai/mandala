import Button from './ui/Button';
import { isHumanInput, type QueuedInput } from '../shared/tasks';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
export default function QueuedMessages({inputs,recordedInputIds,onCancel,onCopy,onReuse,onSend,busy=false,disabled=false}:{inputs:QueuedInput[];recordedInputIds?:ReadonlySet<string>;onSend?:(input:QueuedInput)=>void;busy?:boolean;disabled?:boolean;onCopy:(input:QueuedInput)=>void;onReuse:(input:QueuedInput)=>void;onCancel:(id:string)=>void}) {
 const {text: localize, t}=useLanguage();
 const groups = new Map<string,QueuedInput[]>();
 for (const input of inputs) {
   const phase=input.prestartFailure?'not_sent':input.state==='queued'&&!input.unrecorded&&['waiting','starting','connecting','remote_unavailable'].includes(input.admission??'')?input.admission!:'saved';
   const group=groups.get(phase)??[];
   group.push(input);
   groups.set(phase,group);
 }
 const labels = {
   waiting:t('等待发送'),
   starting:localize('正在启动请求','Starting your request'),
   connecting:localize('正在连接远程电脑','Connecting to the remote computer'),
   remote_unavailable:localize('远程电脑暂不可用','Remote computer unavailable'),
   saved:t('已保存的请求'),
   not_sent:localize('未发送','Not sent'),
 };
 return <>{Array.from(groups,([phase,rows])=>{
  const label=labels[phase as keyof typeof labels];
  const preparing=phase==='starting'||phase==='connecting';
  const cancelLabel=phase==='not_sent'?localize('移除未发送提示','Dismiss unsent notice'):phase==='waiting'||recordedInputIds&&phase==='saved'?t('取消排队'):localize('取消已保存的请求','Cancel saved request');
  return <section key={phase} className="queued-messages" aria-label={label}>
  <div className="queue-heading"><Icon name="clock" size={14}/>{label}<small>{rows.length}</small></div>
  <ol>{rows.map(input=><li className="queued-input" key={input.id}>
   <div className="queued-content"><span title={input.agentMessage?undefined:input.text}>{recordedInputIds?.has(input.id)&&isHumanInput(input)?localize('消息已在对话中','Message shown in chat'):input.source?.kind==='telegram'?'Telegram · '+(input.text||t('附件消息')):input.source?(localize('自动后台输入', 'Automatic background input')):input.agentMessage?.direction==='reply'?t('Agent 回复'):input.text||t('附件消息')}</span><small>{phase==='not_sent'&&input.prestartFailure?.code==='native_thread_busy'?localize('发送这条消息时，原会话被占用。可从对话记录恢复草稿，或移除这条提示。','The thread was busy when you tried to send this message. Restore the draft from the chat or dismiss this notice.'):phase==='not_sent'?localize('原请求已保存，但未发送到 Codex。','The request was saved but not sent to Codex.'):phase==='starting'?localize('请求已保存，正在启动执行端','Saved; starting the runtime'):phase==='connecting'?localize('请求已保存，正在检查连接','Saved; checking the connection'):phase==='remote_unavailable'?localize('请求已保存。检查远程电脑后，继续发送这条请求。','Saved. Check the remote computer, then resume this request.'):input.waitingReason==='context-window'?localize('切换到上下文更大的模型后重试，或取消排队并缩短消息。','Choose a model with a larger context and retry, or cancel and shorten the message.'):phase==='saved'&&!input.unrecorded?localize('请求已保存，尚不清楚是否开始执行','Saved; execution status is not yet known'):input.waitingReason==='background'?localize('等待后台命令退出，随后自动发送','Will send automatically when background commands finish'):t(input.agentMessage?input.agentMessage.direction==='reply'?'Agent 回复，等待接续':'Agent 询问，等待执行':input.unrecorded ? '尚未交给执行端，可复制或用于新对话' : busy?'当前回复结束后自动发送':'等待继续发送')}{input.waitingReason==='directory'&&' · '+t('等待工作目录可用')}{!!input.attachments?.length&&' · '+t('{count} 个附件',{count:input.attachments.length})}</small></div>
   {!input.prestartFailure&&!preparing&&!input.unrecorded&&isHumanInput(input)&&(!input.source||recordedInputIds)&&onSend&&<Button type="button" className="queued-send" disabled={disabled||input.waitingReason==='background'} aria-label={t(busy?'打断并发送':'继续发送')} onClick={()=>onSend(input)}><Icon name={busy?'stop':'play'} size={14}/><span>{t(busy?'打断并发送':'继续发送')}</span></Button>}
   {input.unrecorded && !input.prestartFailure ? <><Button type="button" aria-label={t('复制消息')} title={t('复制消息')} onClick={()=>onCopy(input)}><Icon name="copy" size={14}/></Button><Button type="button" aria-label={t('在新对话中使用此请求')} title={t('在新对话中使用此请求')} onClick={()=>onReuse(input)}><Icon name="message" size={14}/></Button></> : <Button type="button" disabled={disabled} aria-label={cancelLabel} title={cancelLabel} onClick={()=>onCancel(input.id)}><Icon name="close" size={14}/></Button>}
  </li>)}</ol>
 </section>;
 })}</>;
}
