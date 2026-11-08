import type {MouseEvent,ReactNode} from 'react';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import ExecutionChats,{ExecutionMarks} from './ExecutionChats';
import {attentionChats,executionChatsFor} from './task-relations';
import IdentityAvatar from './IdentityAvatar';
import StatusMark from './ui/StatusMark';
import Icon from './ui/Icon';
import Disclosure from './ui/Disclosure';
import {followAssetPage,navigateAssetPage} from './AssetLibrary';
import {useLanguage} from './i18n';
import './task-work-cards.css';

export function taskTone(state:string){return state==='completed'?'success':['running','queued'].includes(state)?'active':['review','waiting','attention'].includes(state)?'warning':state==='failed'?'danger':'neutral';}
export default function TaskWorkCard({task,tasks,config,href,board=false,selectionOnly=false,controls,children,reference,progressRows=[],excludeConversationId,expanded,onOpen=navigateAssetPage}:{task:Task;tasks:readonly Task[];config:Config;href:string;board?:boolean;selectionOnly?:boolean;controls?:ReactNode;children?:ReactNode;reference?:ReactNode;progressRows?:readonly ConversationProgress[];excludeConversationId?:string;expanded?:boolean;onOpen?:(path:string)=>void}){
 const {text:t}=useLanguage(),project=config.projects.find(project=>project.id===task.projectId);
 const ids=[...new Set([task.assigneeAgentId,...(task.executions??[]).map(execution=>execution.agentId)].filter(Boolean))],agents=config.agents.filter(agent=>ids.includes(agent.id));
 const executionTasks=[task,...tasks.filter(item=>item.id!==task.id)],chats=executionChatsFor(task.id,executionTasks,progressRows,excludeConversationId),executionChats=<ExecutionChats rows={chats} tasks={executionTasks} config={config} onOpen={onOpen}/>;
 const follow=(path:string)=>(event:MouseEvent<HTMLAnchorElement>)=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(path);},open=follow(href);
 const selected=location.pathname==='/tasks/'+task.id,title=task.goal.split('\n')[0];
 const problems=attentionChats(task,executionTasks,progressRows).filter(item=>item.row.id!==excludeConversationId),first=problems[0];
 const reason=first&&(()=>{const who=config.agents.find(agent=>agent.id===first.row.agentId)?.name??t('执行者','The executor'),chat='/?conversation='+encodeURIComponent(first.row.id);
  return first.state==='approval'?{text:t(`${who} 在等你审批`,`${who} is waiting for your approval`),action:t('去审批','Review approval'),path:chat}
   :first.state==='attention'?{text:t(`${who} 需要你处理`,`${who} needs you`),action:t('去处理','Open chat'),path:chat}
   :task.state==='review'?{text:t(`结果已回报，但 ${who} 的执行失败了`,`Results are in, but ${who} failed`),action:t('去验收','Review'),path:href}
   :{text:t(`${who} 的执行失败了`,`${who} failed`),action:t('查看原因','See why'),path:chat};})();
 const reasonLine=reason&&<p className="task-work-reason"><StatusMark tone="warning" shape="alert"/><span>{reason.text}{problems.length>1&&t(`（共 ${problems.length} 个对话）`,` (${problems.length} chats)`)}</span><a href={reason.path} onClick={follow(reason.path)}>{reason.action}<Icon name="arrowRight" size={13}/></a></p>;
 const marks=<ExecutionMarks rows={chats} tasks={executionTasks}/>;
 if(selectionOnly)return <article className={'task-work-card'+(selected?' is-selected':'')} data-board={false} data-selection-only>
  <div className="task-work-heading"><Icon name="plan" size={16}/><a href={href} aria-label={title} aria-current={selected?'page':undefined} aria-describedby={'task-meta-'+task.id} title={title} draggable={false} onClick={open}><span className="task-work-title">{title}</span><span className="task-work-meta" id={'task-meta-'+task.id}><span className="operation-avatar-stack">{agents.slice(0,4).map(agent=><span key={agent.id} title={agent.name}><IdentityAvatar identity={agent} kind="agent" size={20}/><span className="task-selection-agent-name">{agent.name}</span></span>)}</span>{project&&<span className="task-work-project"><IdentityAvatar identity={project} kind="project" size={14}/><span>{project.name}</span></span>}</span></a></div>
  {reasonLine}
  {chats.length>0&&<Disclosure className="task-work-related" open={expanded} title={marks} summaryLabel={t(`执行对话 ${chats.length}`,`Execution chats ${chats.length}`)}>{executionChats}</Disclosure>}
 </article>;
 return <article className={'task-work-card'+(selected?' is-selected':'')} data-board={board}>
  <div className="task-work-heading"><Icon name="plan" size={16}/><a href={href} title={title} draggable={false} onClick={open}>{title}</a>{reference}</div>
  <div className="task-work-meta"><span className="operation-avatar-stack">{agents.slice(0,4).map(agent=><a key={agent.id} href={'/agents?agent='+agent.id} onClick={followAssetPage} aria-label={agent.name} title={agent.name}><IdentityAvatar identity={agent} kind="agent" size={22}/></a>)}</span>{project&&<a className="task-work-project" href={'/projects/'+encodeURIComponent(project.id)+'/overview'} onClick={followAssetPage}><IdentityAvatar identity={project} kind="project" size={14}/><span>{project.name}</span></a>}</div>
  {reasonLine}
  {['review','completed'].includes(task.state)&&<a className="task-delivery-link" href={href} onClick={open}>{t('任务详情','Task details')}<Icon name="arrowRight" size={13}/></a>}

  <Disclosure className="task-work-related" open={expanded} title={marks} summaryLabel={t('展开任务详情与状态操作：','Expand task details and state actions: ')+title}>
   {executionChats}{children}{controls}
  </Disclosure>
 </article>;
}
