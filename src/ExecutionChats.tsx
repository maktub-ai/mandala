import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import IdentityAvatar from './IdentityAvatar';
import Icon from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import StatusMark,{statusShape} from './ui/StatusMark';
import {useLanguage} from './i18n';
import {executionChatState,type ChatState} from './task-relations';
import './task-object.css';
import './explicit-progress.css';

const tones:Record<ChatState,'neutral'|'active'|'success'|'warning'|'danger'>={running:'active',queued:'active',approval:'warning',attention:'warning',replied:'success',failed:'danger',cancelled:'neutral',todo:'neutral',idle:'neutral'};

export const chatLabels=(t:(zh:string,en:string)=>string):Record<ChatState,string>=>({running:t('执行中','Running'),queued:t('排队中','Queued'),approval:t('等待审批','Approval needed'),attention:t('需要处理','Needs attention'),replied:t('已回报','Replied'),failed:t('执行失败','Failed'),cancelled:t('已取消','Cancelled'),todo:t('待开始','Not started'),idle:t('空闲','Idle')});

/** One mark per execution chat plus the count; the full list lives in the disclosure below. */
export function ExecutionMarks({rows,tasks}:{rows:readonly ConversationProgress[];tasks:readonly Task[]}){
 const {text:t}=useLanguage(),labels=chatLabels(t),states=rows.map(row=>executionChatState(row,tasks));
 if(!rows.length)return <span className="execution-marks">{t('执行对话 0','Execution chats 0')}</span>;
 return <span className="execution-marks" aria-label={t('执行对话：','Execution chats: ')+states.map(state=>labels[state]).join('、')}><span aria-hidden="true">{states.slice(0,6).map((state,i)=><span key={i} data-tone={tones[state]}><StatusMark shape={statusShape(state)}/></span>)}</span><span aria-hidden="true">{rows.length}</span></span>;
}

export default function ExecutionChats({rows,tasks,config,onOpen}:{rows:readonly ConversationProgress[];tasks:readonly Task[];config:Config;onOpen:(path:string)=>void}){
 const {text:t}=useLanguage();
 const labels=chatLabels(t);
 if(!rows.length)return null;
 return <ul className="execution-chats" aria-label={t('执行对话','Execution chats')}>{rows.map(row=>{
  const agent=config.agents.find(agent=>agent.id===row.agentId),state=executionChatState(row,tasks),title=row.title??row.requestPreview?.split('\n')[0]??t('新执行对话','New execution chat'),path='/?conversation='+encodeURIComponent(row.id);
  return <li key={row.id}><a className="execution-chat-link" href={path} aria-label={t('打开执行对话：','Open execution chat: ')+title+' · '+(agent?.name??t('执行者未知','Unknown executor'))} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(path);}}>
   {agent?<IdentityAvatar identity={agent} kind="agent" size={20}/>:<Icon name="agent" size={18}/>}
   <span className="execution-chat-agent">{agent?.name??t('执行者未知','Unknown executor')}</span>
   <span className="execution-chat-title"><Icon name="message" size={13}/><span title={title}>{title}</span></span>
   <StatusLabel filled icon="clock" tone={tones[state]} shape={statusShape(state)}>{labels[state]}</StatusLabel>
   <Icon name="chevronRight" size={15}/>
   {row.latestProgress?.text&&<span className="execution-chat-progress" title={row.latestProgress.text}><span className="progress-dot" data-live={state==='running'||undefined} aria-hidden="true"/><span>{row.latestProgress.text.replace(/\s+/g,' ')}</span><time dateTime={row.latestProgress.updatedAt}>{new Date(row.latestProgress.updatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></span>}
  </a></li>;
 })}</ul>;
}
