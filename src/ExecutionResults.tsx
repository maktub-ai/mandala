import {useEffect,useState} from 'react';
import {api} from './api';
import {useLanguage} from './i18n';
import {executionResultHref,type ConversationResult} from '../shared/conversation-results';
import Icon,{type IconName} from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import MarkdownMessage from './MarkdownMessage';
import IdentityAvatar from './IdentityAvatar';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import './execution-results.css';

export function useExecutionResults(conversationId:string){
 const [value,setValue]=useState<{id:string;items:ConversationResult[];error:string}>({id:'',items:[],error:''});
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  if(!conversationId)return;
  const controller=new AbortController();
  let active=true,inFlight=false;
  const load=async()=>{
   if(inFlight||document.hidden)return;inFlight=true;
   try{const items=await api<ConversationResult[]>('/conversations/'+conversationId+'/results','GET',undefined,controller.signal);if(active)setValue({id:conversationId,items,error:''});}
   catch(error){if(active)setValue({id:conversationId,items:[],error:(error as Error).message});}
   finally{inFlight=false;}
  };
  void load();const timer=setInterval(load,3000);document.addEventListener('visibilitychange',load);
  return()=>{active=false;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
 },[conversationId,revision]);
 return {...(value.id===conversationId?value:{items:[],error:''}),retry:()=>setRevision(v=>v+1)};
}

export default function ExecutionResults({items,config,onOpen,tasks=[]}:{items:ConversationResult[];config:Config;onOpen:(path:string)=>void;tasks?:readonly Task[]}){
 return <>{items.map(item=><ExecutionResult key={item.id} item={item} config={config} onOpen={onOpen} tasks={tasks}/>)}</>;
}

function ExecutionResult({item,config,onOpen,tasks}:{item:ConversationResult;config:Config;onOpen:(path:string)=>void;tasks:readonly Task[]}){
 const {text: localize, language}=useLanguage(),en=language !== 'zh-CN';
 const sender=config.agents.find(agent=>agent.id===item.agentId);
 const labels:Record<ConversationResult['state'],string>=en
  ?{queued:'Queued',starting:'Starting',running:'Running',approval:'Approval needed',succeeded:'Run finished',failed:'Run failed',interrupted:'Interrupted',unknown:'Status unconfirmed',legacy_unverified:'Status unconfirmed'}
  :{queued:'排队中',starting:'启动中',running:'执行中',approval:'待批准',succeeded:'执行结束',failed:'执行失败',interrupted:'已中断',unknown:'状态待确认',legacy_unverified:'状态待确认'};
 const icon:IconName=item.state==='failed'?'error':item.state==='succeeded'?'check':item.state==='interrupted'?'stop':'clock';
 const date=new Date(item.createdAt),today=new Date(),sameDay=date.toDateString()===today.toDateString();
 const time=date.toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',hour12:false});
 const stamp=(sameDay?(localize('今天', 'Today')):date.toLocaleDateString(language,{...(date.getFullYear()!==today.getFullYear()?{year:'numeric' as const}:{}),month:'short',day:'numeric'}))+' '+time;
 const summary=item.summary.trim(),root=tasks.find(task=>task.id===item.taskId),rootPath='/tasks/'+encodeURIComponent(root?.id??item.taskId),rootTitle=root?.goal.split('\n')[0];
 const link=(href:string,label:string,icon:IconName)=><a href={href} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(href);}}><Icon name={icon} size={14}/>{label}</a>;
 return <article className="execution-result agent-reply" aria-label={item.title+(localize(' · 执行结果', ' · Execution result'))}>
  <div className="chat-reply-bubble"><a className="execution-result-task" href={rootPath} title={rootTitle} aria-label={localize('所属任务：','Task: ')+(rootTitle??item.title)} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(rootPath);}}><Icon name="undo-2" size={13}/>{localize('任务','Task')}{rootTitle&&<> · <span>{rootTitle}</span></>}</a><header className="agent-reply-header"><div className="message-avatar">{sender?<IdentityAvatar identity={sender} kind="agent" size={24}/>:<Icon name="agent" size={18}/>}</div><span className="message-name execution-result-sender">{sender?.name??localize('智能体','Agent')}</span><span className="chat-reply-source">{localize('任务回报','Task reply')}</span></header>
  <div className="execution-result-heading"><Icon name="message" size={14}/><strong title={item.title}>{item.title}</strong></div>
  {summary&&<div className="execution-result-body"><MarkdownMessage text={summary}/></div>}
  </div>
  <div className="execution-result-footer">
   <div className="execution-result-meta"><StatusLabel icon={icon} tone={item.state==='failed'?'danger':'neutral'}>{labels[item.state]}</StatusLabel>{item.awaitingReview&&<StatusLabel icon="approval" tone="warning">{localize('待验收', 'Awaiting review')}</StatusLabel>}{item.taskState==='completed'&&item.completion&&<StatusLabel icon="check" tone="success">{item.completion.completedBy==='user'?localize('用户已验收','Accepted by user'):item.completion.completedBy==='checks'?localize('检查通过，任务完成','Checks passed; task completed'):item.completion.completedBy==='agent'?localize('智能体确认完成','Marked completed by Agent'):localize('已交付，任务完成','Delivered; task completed')}</StatusLabel>}{item.taskState==='cancelled'&&<StatusLabel icon="stop">{localize('任务已取消','Task cancelled')}</StatusLabel>}<time dateTime={item.createdAt} title={date.toLocaleString(language)}>{stamp}</time></div>
   <div className="execution-result-actions">{link(executionResultHref(item.conversationId,item.runId),localize('查看执行详情', 'View execution details'),'arrowRight')}{item.artifactCount>0&&link('/tasks/'+encodeURIComponent(item.taskId),localize(`查看产物（${item.artifactCount}）`, `Deliverables (${item.artifactCount})`),'files')}</div>
  </div>
 </article>;
}
