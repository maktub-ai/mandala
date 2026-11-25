import type {ReactNode} from 'react';
import type {Agent} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import {useLanguage} from './i18n';
import {ObjectGroup} from './ObjectExperience';
import {DirectoryLink} from './SettingsObjectBrowser';
import {projectParticipantIds} from './project-participants';
import IdentityAvatar from './IdentityAvatar';
import Disclosure from './ui/Disclosure';
import Icon from './ui/Icon';

type ProjectTask=Pick<Task,'id'|'goal'|'activityAt'|'createdAt'|'assigneeAgentId'|'participantAgentIds'|'executions'>;

export default function ProjectActivity({id,agents,tasks,chats,tasksError,chatsError,disabled,onNavigate}:{
 id:string;agents:Agent[];tasks:ProjectTask[]|null;chats:ConversationProgress[]|undefined;
 tasksError:boolean;chatsError:boolean;disabled:boolean;onNavigate:(path:string)=>void;
}) {
 const {text,language}=useLanguage(),nav={disabled,onNavigate};
 const agentById=new Map(agents.map(agent=>[agent.id,agent]));
 const participants=tasks&&chats?[...projectParticipantIds(id,tasks,chats)]:null;
 const sortedTasks=tasks?.slice().sort((a,b)=>(b.activityAt??b.createdAt).localeCompare(a.activityAt??a.createdAt)||a.id.localeCompare(b.id));
 const moreTasks=sortedTasks?.slice(5)??[];
 const recentChats=chats?.slice().sort((a,b)=>b.activityAt.localeCompare(a.activityAt)||a.id.localeCompare(b.id)).slice(0,5);
 const from='/projects/'+encodeURIComponent(id)+'/overview',query=new URLSearchParams({project:id});
 const empty=(error:boolean,loading:boolean,message:string)=><p className="object-empty">{error?text('暂不可用','Unavailable'):loading?text('读取中…','Loading…'):message}</p>;
 const row=(key:string,href:string,icon:ReactNode,title:string,updatedAt:string)=><DirectoryLink key={key} {...nav} className="project-activity-row" href={href} aria-label={title}>
  {icon}<span title={title}>{title}</span><time dateTime={updatedAt}>{new Date(updatedAt).toLocaleDateString(language,{month:'short',day:'numeric'})}</time><Icon name="chevronRight" size={14}/>
 </DirectoryLink>;
 const taskRow=(task:ProjectTask)=>row(task.id,'/tasks/'+encodeURIComponent(task.id)+'?'+query,<Icon name="plan" size={16}/>,task.goal.split('\n')[0],task.activityAt??task.createdAt);
 return <>
  <ObjectGroup title={text('项目任务','Project tasks')} actions={<DirectoryLink {...nav} href={'/tasks?'+query+'&type=tasks&scope=all&state=all'}>{text('全部任务','All tasks')}<Icon name="arrowRight" size={14}/></DirectoryLink>}>
   {sortedTasks?.length?<>{sortedTasks.slice(0,5).map(taskRow)}{moreTasks.length>0&&<Disclosure className="project-activity-more" title={text(`另有 ${moreTasks.length} 项任务`,`More tasks (${moreTasks.length})`)}>{moreTasks.map(taskRow)}</Disclosure>}</>:empty(tasksError,!tasks,text('暂无项目任务','No project tasks'))}
  </ObjectGroup>
  <ObjectGroup title={text('参与智能体','Participating Agents')}>
   {participants?.length?<div className="project-participants">{participants.map(agentId=>{
    const agent=agentById.get(agentId);
    return agent?<DirectoryLink key={agentId} {...nav} href={'/agents/'+encodeURIComponent(agentId)+'?'+new URLSearchParams({from})}><IdentityAvatar identity={agent} kind="agent" size={22}/>{agent.name}</DirectoryLink>:<span key={agentId}>{agentId}</span>;
   })}</div>:empty(tasksError||chatsError,!participants,text('暂无参与智能体','No participating Agents'))}
  </ObjectGroup>
  <ObjectGroup title={text('最近会话','Recent chats')} actions={<DirectoryLink {...nav} href={'/tasks?'+query+'&type=conversations&scope=all'}>{text('全部对话','All chats')}<Icon name="arrowRight" size={14}/></DirectoryLink>}>
   {recentChats?.length?recentChats.map(chat=>row(chat.id,'/?'+new URLSearchParams({conversation:chat.id}),<Icon name="message" size={16}/>,chat.title??text('未命名对话','Untitled chat'),chat.activityAt)):empty(chatsError,!chats,text('暂无项目会话','No project chats'))}
  </ObjectGroup>
 </>;
}
