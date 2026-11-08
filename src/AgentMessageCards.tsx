import type {ChatMessage} from '../shared/chat-turns';
import type {Config} from '../shared/types';
import OperationCard,{OperationLink} from './OperationCard';
import IdentityAvatar from './IdentityAvatar';
import StatusLabel from './ui/StatusLabel';
import Disclosure from './ui/Disclosure';
import MarkdownMessage from './MarkdownMessage';
import {useLanguage} from './i18n';
import Icon from './ui/Icon';

function AgentReply({message,config,onOpen}:{message:NonNullable<ChatMessage['agentMessage']>;config:Config;onOpen:(path:string)=>void}){
 const {text:t}=useLanguage(),owner=config.agents.find(agent=>agent.id===message.targetAgentId);
 const name=owner?.name??t('智能体','Agent');
 return <article className="agent-reply agent-message-reply" aria-label={name+t(' · 智能体回复',' · Agent reply')}>
  <div className="chat-reply-bubble"><header className="agent-reply-header"><div className="message-avatar">{owner?<IdentityAvatar identity={owner} kind="agent" size={24}/>:<Icon name="agent" size={18}/>}</div><span className="message-name">{name}</span><span className="chat-reply-source">{t('智能体回复','Agent reply')}</span></header>
  {message.reply&&<div className="agent-message-body"><MarkdownMessage text={message.reply}/></div>}
  </div>
  <p className="chat-reply-source">{message.replyState==='consumed'?t('已接续处理','Followed up'):message.replyState==='parked'?t('回复已保存，未自动接续','Reply saved without automatic continuation'):t('回复等待处理','Reply awaiting processing')}</p>
  {message.state==='failed'&&<StatusLabel icon="error" tone="danger">{t('执行未完成','Execution incomplete')}</StatusLabel>}
  {message.state==='unknown'&&<StatusLabel icon="clock" tone="warning">{t('状态待确认','Status unconfirmed')}</StatusLabel>}
  {message.text&&<Disclosure title={t('查看原始请求','Review original request')}><MarkdownMessage text={message.text}/></Disclosure>}
  {message.targetConversationId&&<OperationLink path={'/?conversation='+encodeURIComponent(message.targetConversationId)} onOpen={onOpen} iconOnly={false}>{t('查看接收对话','View receiving chat')}</OperationLink>}
 </article>;
}

export default function AgentMessageCards({messages,config,onOpen}:{messages:ChatMessage[];config:Config;onOpen:(path:string)=>void}){
 const {text:t}=useLanguage();
 const groups=new Map<string,NonNullable<ChatMessage['agentMessage']>[]>();
 for(const item of messages){const m=item.agentMessage;if(item.kind!=='agent_message'||!m||m.direction==='reply')continue;const key=m.direction==='request'?'incoming:'+m.id:m.sourceRequestEventId?'request:'+m.sourceRequestEventId:'message:'+m.id;groups.set(key,[...groups.get(key)??[],m]);}
 return <>{[...groups.entries()].map(([key,items])=>{
  const replies=items.filter(m=>m.state==='succeeded').length,failed=items.some(m=>m.state==='failed'||m.state==='unknown'),incoming=items[0].direction==='request';
  const title=items.length>1?t(`消息委派 · 已收到 ${replies}/${items.length} 个回复`,`Delegation · ${replies}/${items.length} replies`):incoming?t('收到智能体询问','Agent inquiry received'):t('消息委派','Message delegation');
  return <OperationCard key={key} icon="message" title={title} summary={<span className="operation-avatar-stack">{items.slice(0,4).map(m=>{const a=config.agents.find(a=>a.id===(incoming?m.sourceAgentId:m.targetAgentId));return a?<IdentityAvatar key={m.id} identity={a} kind="agent" size={24}/>:null;})}<small>{replies}/{items.length}</small></span>} label={t('消息委派与回报','Message delegation and replies')} status={failed?t('需要关注','Needs attention'):replies===items.length?t('已回复','Replied'):t('等待回复','Awaiting reply')} tone={failed?'warning':replies===items.length?'success':items.some(m=>m.state==='running')?'active':'warning'} footer={incoming?t('回复将返回来源对话','Replies return to the source chat'):undefined}>
   <div className="operation-rows">{items.map(m=>{
    const related=incoming?m.sourceConversationId:m.targetConversationId,id=incoming?m.sourceAgentId:m.targetAgentId;
    const owner=config.agents.find(a=>a.id===id);
    const name=owner?.name??t(incoming?'来源智能体':'接收智能体',incoming?'Source Agent':'Receiving Agent');
    const label=m.state==='queued'?t('排队中','Queued'):m.state==='running'?t('执行中','Running'):m.state==='succeeded'?t('已回复','Replied'):m.state==='failed'?t('执行未完成','Execution incomplete'):t('状态待确认','Status unconfirmed');
    const processing=m.replyState==='consumed'?t('Mandala 已接续处理','Mandala has processed the reply'):m.replyState==='parked'?t(m.reply?'回复已保存，未自动接续':'已停止自动接续，等待回复',m.reply?'Reply saved without automatic continuation':'Automatic continuation stopped; awaiting reply'):m.replyState==='queued'?t('回复等待接续','Reply queued for continuation'):m.reply?t('回复等待处理','Reply awaiting processing'):t('尚未收到回复','No reply received yet');
    return <div className="operation-row" key={m.id}>{owner&&<IdentityAvatar identity={owner} kind="agent" size={28}/>}<div className="operation-row-main"><OperationLink path={'/agents?agent='+encodeURIComponent(id??'')} onOpen={onOpen} iconOnly={false}>{name}</OperationLink><p className="operation-row-note">{processing}</p><div className="operation-message-actions">{m.reply&&<Disclosure title={t('查看回复','Read reply')}><MarkdownMessage text={m.reply}/></Disclosure>}{related&&<OperationLink path={'/?conversation='+encodeURIComponent(related)} onOpen={onOpen}>{t(incoming?'查看来源对话':'查看接收对话',incoming?'View source chat':'View receiving chat')}</OperationLink>}</div></div><StatusLabel filled icon={m.state==='succeeded'?'check':m.state==='failed'?'error':'clock'} tone={m.state==='succeeded'?'success':m.state==='failed'?'danger':m.state==='running'?'active':'warning'}>{label}</StatusLabel></div>;
   })}</div>
   {items.some(m=>m.text)&&<Disclosure title={t('查看原始委派','Review original request')}>{items.filter(m=>m.text).map(m=><div key={m.id} className="operation-original-request"><strong>{config.agents.find(a=>a.id===(incoming?m.sourceAgentId:m.targetAgentId))?.name??t('智能体','Agent')}</strong><p>{m.text}</p></div>)}</Disclosure>}
  </OperationCard>;
 })}{messages.filter(item=>item.kind==='agent_message'&&item.agentMessage?.direction==='reply').map(item=><AgentReply key={item.key} message={item.agentMessage!} config={config} onOpen={onOpen}/>)}</>;
}
