import {useState, type ReactNode} from 'react';
import type {ChatMessage} from '../shared/chat-turns';
import type {Config} from '../shared/types';
import {api} from './api';
import Button from './ui/Button';
import OperationCard,{OperationLink,OperationProgress} from './OperationCard';
import IdentityAvatar from './IdentityAvatar';
import StatusLabel from './ui/StatusLabel';
import Disclosure from './ui/Disclosure';
import MarkdownMessage from './MarkdownMessage';
import {useLanguage} from './i18n';
import Icon from './ui/Icon';
import {collabFocusEvent} from './mandala-collab';

type BubbleActions = { renderCopy?: (key: string, text: string) => ReactNode };
type Message = NonNullable<ChatMessage['agentMessage']>;
type Tone = 'neutral'|'active'|'success'|'warning'|'danger';
/** Turn key of Mandala's summary that continued a reply, when one exists. */
export type SummaryLookup = (messageId:string)=>number|undefined;

export const summaryTurnSelector=(key:number)=>`.chat-turn[data-turn-key="${key}"]`;
function scrollToSummary(key:number){
 const node=document.querySelector<HTMLElement>(summaryTurnSelector(key));
 if(!node)return;
 node.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 node.focus({preventScroll:true});
}

/** Whether the two-line preview may hide part of a reply. */
const isLong=(text:string)=>text.length>110||/\n\s*\S/.test(text.trim())||/[#`|>]/.test(text);

/** A one-line plain-text glimpse of Markdown, for summaries that must stay on one line. */
export function plainGlimpse(text:string){
 return text.replace(/```[\s\S]*?```/g,' ').replace(/[#>*_`~|-]+/g,' ').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\s+/g,' ').trim();
}

function RetryInquiry({id,attemptId}:{id:string;attemptId:string}){
 const {text:t}=useLanguage();
 const [pending,setPending]=useState(false),[error,setError]=useState(false);
 async function retry(){
  setPending(true);setError(false);
  try{await api('/agent-messages/'+encodeURIComponent(id)+'/retry','POST',{attemptId});}
  catch{setError(true);}
  finally{setPending(false);}
 }
 return <>
  <Button size="sm" variant="secondary" busy={pending} onClick={()=>void retry()}>{t('重试分派','Retry delegation')}</Button>
  {error&&<span role="alert" className="operation-card-error">{t('无法重试分派，请刷新后查看状态。','Could not retry delegation. Refresh to check its status.')}</span>}
 </>;
}

function useRowState(){
 const {text:t}=useLanguage();
 return (m:Message):{label:string;tone:Tone;icon:'check'|'error'|'clock'}=>{
  const notSubmitted=m.state==='failed'&&m.submissionState==='not_submitted';
  if(m.state==='queued')return {label:m.submissionState==='unknown'?t('提交待确认','Submission unconfirmed'):t('排队中','Queued'),tone:'warning',icon:'clock'};
  if(m.state==='running')return {label:t('执行中','Running'),tone:'active',icon:'clock'};
  if(m.state==='succeeded')return {label:t('已回复','Replied'),tone:'success',icon:'check'};
  if(m.state==='failed')return {label:notSubmitted?t('未提交','Not submitted'):t('执行未完成','Execution incomplete'),tone:'danger',icon:'error'};
  return {label:t('状态待确认','Status unconfirmed'),tone:'warning',icon:'clock'};
 };
}

/** The receiving agent's full words, folded. Mandala's summary above is what the user reads first. */
function ReplyBody({message,renderCopy}:BubbleActions&{message:Message}){
 return <>
  <MarkdownMessage text={message.reply??''}/>
  {renderCopy&&message.reply&&<div className="reply-source-actions">{renderCopy(message.id+':reply',message.reply)}</div>}
 </>;
}

export function ReplySource({message,config,onOpen,renderCopy}:BubbleActions&{message:Message;config:Config;onOpen:(path:string)=>void}){
 const {text:t}=useLanguage(),owner=config.agents.find(agent=>agent.id===message.targetAgentId);
 const name=owner?.name??t('智能体','Agent'),reply=message.reply??'';
 const failed=message.state==='failed'||message.state==='unknown';
 const label=t(`${name} 的原始回复`,`${name}'s original reply`);
 return <Disclosure className="reply-source" data-message-id={message.id} summaryLabel={label} title={<>
   {owner?<IdentityAvatar identity={owner} kind="agent" size={20}/>:<Icon name="agent" size={16}/>}
   <span className="reply-source-title">{label}</span>
   <span className="reply-source-meta">{plainGlimpse(reply).slice(0,80)}{t(` · 约 ${reply.length.toLocaleString()} 字`,` · ${reply.length.toLocaleString()} chars`)}</span>
   {failed&&<StatusLabel filled icon="error" tone="danger">{t('执行未完成','Execution incomplete')}</StatusLabel>}
  </>}>
  <ReplyBody message={message} renderCopy={renderCopy}/>
  {message.targetConversationId&&<div className="reply-source-actions"><OperationLink path={'/?conversation='+encodeURIComponent(message.targetConversationId)} onOpen={onOpen} iconOnly={false} className="operation-text-button">{t('查看接收对话','View receiving chat')}</OperationLink></div>}
 </Disclosure>;
}

/** A reply Mandala has not summarized (continuation off, failed or still waiting) keeps a short preview with the full text folded. */
function AgentReply({message,config,onOpen,renderCopy}:BubbleActions & {message:Message;config:Config;onOpen:(path:string)=>void}){
 const {text:t}=useLanguage(),owner=config.agents.find(agent=>agent.id===message.targetAgentId);
 const name=owner?.name??t('智能体','Agent');
 const notSubmitted=message.state==='failed'&&message.submissionState==='not_submitted';
 const status=notSubmitted?{label:t('未提交','Not submitted'),tone:'danger' as const,icon:'error' as const}
  :message.state==='failed'?{label:t('执行未完成','Execution incomplete'),tone:'danger' as const,icon:'error' as const}
  :message.state==='unknown'?{label:message.submissionState==='submitted'?t('已提交，结果待确认','Submitted, outcome unconfirmed'):t('状态待确认','Status unconfirmed'),tone:'warning' as const,icon:'clock' as const}
  :message.replyState==='parked'?{label:t('回复待处理','Reply awaiting you'),tone:'warning' as const,icon:'clock' as const}
  :message.replyState==='queued'?{label:t('等待总结','Awaiting summary'),tone:'active' as const,icon:'clock' as const}
  :{label:t('已回复','Replied'),tone:'success' as const,icon:'check' as const};
 return <OperationCard as="article" headless icon="message" title={t('智能体回复','Agent reply')} label={name+' · '+t('智能体回复','Agent reply')} tone={status.tone} attention={notSubmitted||message.replyState==='parked'}>
  <div className="operation-rows"><div className="operation-row agent-message-reply" title={message.text||undefined}>
   {owner?<IdentityAvatar identity={owner} kind="agent" size={22}/>:<Icon name="agent" size={20}/>}
   <div className="operation-row-main">
    <div className="operation-row-line"><span className="operation-row-name">{name}</span><span className="operation-row-object">{t('回复','Reply')}{message.text?' · '+plainGlimpse(message.text):''}</span></div>
    {notSubmitted?<p className="operation-row-note" data-tone="danger">{t('无法启动接收智能体。','Could not start the receiving Agent.')}</p>
     :message.reply&&<><p className="operation-row-preview">{plainGlimpse(message.reply)}</p>
      {(isLong(message.reply)||message.replyState==='parked'||renderCopy)&&<div className="operation-message-actions">{isLong(message.reply)?<Disclosure title={t('展开全文','Show full reply')}><ReplyBody message={message} renderCopy={renderCopy}/></Disclosure>:renderCopy?.(message.id+':reply',message.reply)}
       {message.replyState==='parked'&&<span className="operation-row-note">{t('未自动接续，可引用后让 Mandala 继续','Not continued automatically; quote it to continue')}</span>}</div>}</>}
   </div>
   <div className="operation-row-side">
    <StatusLabel filled icon={status.icon} tone={status.tone}>{status.label}</StatusLabel>
    {notSubmitted&&message.retryAttemptId&&<RetryInquiry key={message.retryAttemptId} id={message.id} attemptId={message.retryAttemptId}/>}
    {message.targetConversationId&&<OperationLink path={'/?conversation='+encodeURIComponent(message.targetConversationId)} onOpen={onOpen}>{t('查看接收对话','View receiving chat')}</OperationLink>}
   </div>
  </div></div>
 </OperationCard>;
}

const priority=(m:Message)=>m.state==='failed'||m.state==='unknown'?0:m.state==='running'?1:m.state==='queued'?2:3;

export default function AgentMessageCards({messages,config,onOpen,renderCopy,summaryOf,showReplies=true}:BubbleActions & {messages:ChatMessage[];config:Config;onOpen:(path:string)=>void;summaryOf?:SummaryLookup;showReplies?:boolean}){
 const {text:t}=useLanguage(),rowState=useRowState();
 const groups=new Map<string,Message[]>();
 for(const item of messages){const m=item.agentMessage;if(item.kind!=='agent_message'||!m||m.direction==='reply')continue;const key=m.direction==='request'?'incoming:'+m.id:m.sourceRequestEventId?'request:'+m.sourceRequestEventId:'message:'+m.id;groups.set(key,[...groups.get(key)??[],m]);}
 return <>{[...groups.entries()].map(([key,items])=>{
  const incoming=items[0].direction==='request',replies=items.filter(m=>m.state==='succeeded').length;
  const failed=items.some(m=>m.state==='failed'||m.state==='unknown');
  const ordered=[...items].sort((a,b)=>priority(a)-priority(b));
  const progress=items.map(m=>m.state==='succeeded'?'done' as const:m.state==='failed'||m.state==='unknown'?'failed' as const:m.state==='running'?'active' as const:'waiting' as const);
  const title=incoming?t('收到智能体询问','Agent inquiry received'):t('消息委派','Message delegation');
  return <OperationCard key={key} headless={items.length===1} icon="message" title={title} attention={failed} tone={failed?'danger':'neutral'}
   label={t('消息委派与回报','Message delegation and replies')}
   summary={items.length>1?<><OperationProgress states={progress} label={t(`已收到 ${replies}/${items.length} 个回复`,`${replies}/${items.length} replies`)}/><span>{t(`已收到 ${replies}/${items.length} 个回复`,`${replies}/${items.length} replies`)}</span></>:undefined}>
   <div className="operation-rows">{ordered.map(m=>{
    const related=incoming?m.sourceConversationId:m.targetConversationId,id=incoming?m.sourceAgentId:m.targetAgentId;
    const owner=config.agents.find(a=>a.id===id);
    const name=owner?.name??t(incoming?'来源智能体':'接收智能体',incoming?'Source Agent':'Receiving Agent');
    const state=rowState(m),notSubmitted=m.state==='failed'&&m.submissionState==='not_submitted';
    const summaryKey=summaryOf?.(m.id);
    const request=plainGlimpse(m.text??'');
    const line=notSubmitted?<p className="operation-row-note" data-tone="danger">{t('无法启动接收智能体。','Could not start the receiving Agent.')}</p>
     :summaryKey!==undefined?<div className="operation-message-actions"><span className="operation-row-note">{t('Mandala 已按你的请求总结','Mandala summarized it for your request')}</span><button type="button" className="operation-text-button" onClick={()=>scrollToSummary(summaryKey)}>{t('看总结','See summary')}<Icon name="arrowDown" size={13}/></button></div>
     :m.reply&&m.replyState==='queued'?<p className="operation-row-note">{t('回复已收到，Mandala 正在总结','Reply received; Mandala is summarizing')}</p>
     :m.reply&&m.replyState==='consumed'?<p className="operation-row-note">{t('Mandala 已接续处理','Mandala has processed the reply')}</p>
     :m.reply&&!incoming?<><p className="operation-row-preview">{plainGlimpse(m.reply)}</p>{isLong(m.reply)&&<div className="operation-message-actions"><Disclosure title={t('展开全文','Show full reply')}><MarkdownMessage text={m.reply}/></Disclosure></div>}</>
     :request?<p className="operation-row-note">{incoming?t('问你：','Asks you: '):''}“{request}”</p>:null;
    return <div className="operation-row" key={m.id} title={m.text||undefined}>
     {owner?<IdentityAvatar identity={owner} kind="agent" size={22}/>:<Icon name="agent" size={20}/>}
     <div className="operation-row-main">
      <div className="operation-row-line"><OperationLink path={'/agents?agent='+encodeURIComponent(id??'')} onOpen={onOpen} iconOnly={false} className="operation-row-name">{name}</OperationLink>{items.length===1&&<span className="operation-row-object">{title}</span>}</div>
      {line}
     </div>
     <div className="operation-row-side">
      <StatusLabel filled icon={state.icon} tone={state.tone}>{state.label}</StatusLabel>
      {notSubmitted&&m.retryAttemptId&&<RetryInquiry key={m.retryAttemptId} id={m.id} attemptId={m.retryAttemptId}/>}
      {related&&!incoming&&<button type="button" className="operation-icon-link" aria-label={t('在协作中查看','Show in Collaboration')} title={t('在协作中查看','Show in Collaboration')} onClick={()=>dispatchEvent(new CustomEvent(collabFocusEvent,{detail:{conversationId:related}}))}><Icon name="panel" size={15}/></button>}
      {related&&<OperationLink path={'/?conversation='+encodeURIComponent(related)} onOpen={onOpen}>{t(incoming?'查看来源对话':'查看接收对话',incoming?'View source chat':'View receiving chat')}</OperationLink>}
     </div>
    </div>;
   })}</div>
  </OperationCard>;
 })}{showReplies&&messages.filter(item=>item.kind==='agent_message'&&item.agentMessage?.direction==='reply'&&item.agentMessage.reply?.trim()&&summaryOf?.(item.agentMessage.id)===undefined).map(item=><AgentReply renderCopy={renderCopy} key={item.key} message={item.agentMessage!} config={config} onOpen={onOpen}/>)}</>;
}
