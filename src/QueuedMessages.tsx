import Button from './ui/Button';
import type { QueuedInput } from '../shared/tasks';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
export default function QueuedMessages({inputs,onCancel,onCopy,onReuse,onSend,busy=false,disabled=false}:{inputs:QueuedInput[];onSend?:(input:QueuedInput)=>void;busy?:boolean;disabled?:boolean;onCopy:(input:QueuedInput)=>void;onReuse:(input:QueuedInput)=>void;onCancel:(id:string)=>void}) {
 const {text: localize, t}=useLanguage();
 if(!inputs.length)return null;
 return <section className="queued-messages" aria-label={t(inputs.some(input => input.unrecorded) ? '已保存的请求' : '等待发送')}>
  <div className="queue-heading"><Icon name="clock" size={14}/>{t(inputs.some(input => input.unrecorded) ? '已保存的请求' : '等待发送')}<small>{inputs.length}</small></div>
  <ol>{inputs.map(input=><li className="queued-input" key={input.id}>
   <div className="queued-content"><span title={input.agentMessage?undefined:input.text}>{input.source?.kind==='telegram'?'Telegram · '+(input.text||t('附件消息')):input.source?(localize('自动后台输入', 'Automatic background input')):input.agentMessage?.direction==='reply'?t('Agent 回复'):input.text||t('附件消息')}</span><small>{input.waitingReason==='background'?localize('等待后台命令退出，随后自动发送','Will send automatically when background commands finish'):t(input.agentMessage?input.agentMessage.direction==='reply'?'Agent 回复，等待接续':'Agent 询问，等待执行':input.unrecorded ? '尚未交给执行端，可复制或用于新对话' : busy?'当前回复结束后自动发送':'等待继续发送')}{input.waitingReason==='directory'&&' · '+t('等待工作目录可用')}{!!input.attachments?.length&&' · '+t('{count} 个附件',{count:input.attachments.length})}</small></div>
   {!input.unrecorded&&!input.agentMessage&&!input.source&&onSend&&<Button type="button" className="queued-send" disabled={disabled||input.waitingReason==='background'} aria-label={t(busy?'打断并发送':'继续发送')} onClick={()=>onSend(input)}><Icon name={busy?'stop':'play'} size={14}/><span>{t(busy?'打断并发送':'继续发送')}</span></Button>}
   {input.unrecorded ? <><Button type="button" aria-label={t('复制消息')} title={t('复制消息')} onClick={()=>onCopy(input)}><Icon name="copy" size={14}/></Button><Button type="button" aria-label={t('在新对话中使用此请求')} title={t('在新对话中使用此请求')} onClick={()=>onReuse(input)}><Icon name="message" size={14}/></Button></> : <Button type="button" disabled={disabled} aria-label={t('取消排队')} title={t('取消排队')} onClick={()=>onCancel(input.id)}><Icon name="close" size={14}/></Button>}
  </li>)}</ol>
 </section>;
}
