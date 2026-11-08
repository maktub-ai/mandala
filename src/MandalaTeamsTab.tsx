import {useState,type ReactNode} from 'react';
import type {Config,Agent,Project} from '../shared/types';
import type {Task} from '../shared/tasks';
import {runningConversationCount,type ConversationProgress} from '../shared/conversation-progress';
import type {ComposerReferenceItem} from '../shared/composer-references';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Input from './ui/Input';
import Icon from './ui/Icon';
import Disclosure from './ui/Disclosure';
import EmptyState from './ui/EmptyState';
import StatusMark from './ui/StatusMark';
import IdentityAvatar from './IdentityAvatar';
import ExecutionChats,{ExecutionMarks} from './ExecutionChats';
import {relativeTime,recentWindowMs} from './mandala-panel-time';

export type AgentFilter='working'|'recent'|'all';
export type AgentActivity={running:number;approvals:number;failed:number;unknown:number;chats:ConversationProgress[];lastActiveAt:string|null;working:boolean;recent:boolean;rank:number};
type Group={id:string;project:Project|null;agents:Agent[]};
type Drag=(kind:ComposerReferenceItem['kind'],id:string)=>object;

/** What one Agent is doing right now, from its chats' raw execution status (never inferred from closed markers). */
export function agentActivity(agentId:string,rows:readonly ConversationProgress[],now=Date.now()):AgentActivity{
 const chats=rows.filter(row=>row.agentId===agentId),running=runningConversationCount(chats);
 const approvals=chats.filter(row=>row.executionStatus==='approval').length,failed=chats.filter(row=>row.executionStatus==='error').length,unknown=chats.filter(row=>row.executionStatus==null).length;
 const lastActiveAt=chats.map(row=>row.activityAt).filter(Boolean).sort().at(-1)??null,recentSince=now-recentWindowMs;
 const working=running>0||approvals>0,recent=working||(!!lastActiveAt&&Date.parse(lastActiveAt)>=recentSince);
 const visible=chats.filter(row=>row.executionStatus==='running'||row.executionStatus==='approval'||row.executionStatus==='error'||row.active||Date.parse(row.activityAt)>=recentSince).sort((a,b)=>b.activityAt.localeCompare(a.activityAt));
 return {running,approvals,failed,unknown,chats:visible,lastActiveAt,working,recent,rank:running?0:approvals?1:failed?2:recent?3:4};
}
export function matchesAgentFilter(activity:AgentActivity,filter:AgentFilter){return filter==='all'||(filter==='working'?activity.working:activity.recent);}

export default function MandalaTeamsTab({config,agents,groups,rows,tasks,expandAll,onExpandAll,reference,drag,onOpen}:{config:Config;agents:Agent[];groups:Group[];rows:ConversationProgress[];tasks:Task[];expandAll:boolean;onExpandAll:()=>void;reference:(kind:ComposerReferenceItem['kind'],id:string,name:string)=>ReactNode;drag:Drag;onOpen:(path:string)=>void}){
 const {text:say,language}=useLanguage(),english=language!=='zh-CN';
 const [filter,setFilter]=useState<AgentFilter>('all'),[search,setSearch]=useState('');
 const now=Date.now(),activity=new Map(agents.map(agent=>[agent.id,agentActivity(agent.id,rows,now)]));
 const counts={working:agents.filter(agent=>activity.get(agent.id)!.working).length,recent:agents.filter(agent=>activity.get(agent.id)!.recent).length,all:agents.length};
 const unknown=rows.filter(row=>row.executionStatus==null&&agents.some(agent=>agent.id===row.agentId)).length;
 const query=search.trim().toLocaleLowerCase();
 const shown=groups.map(group=>{
  const projectHit=!!query&&!!group.project?.name.toLocaleLowerCase().includes(query);
  const members=group.agents.filter(agent=>matchesAgentFilter(activity.get(agent.id)!,filter)&&(!query||projectHit||agent.name.toLocaleLowerCase().includes(query)))
   .sort((a,b)=>activity.get(a.id)!.rank-activity.get(b.id)!.rank||(activity.get(b.id)!.lastActiveAt??'').localeCompare(activity.get(a.id)!.lastActiveAt??''));
  return {...group,members,total:group.agents.length};
 }).filter(group=>group.members.length||(!query&&filter==='all'&&group.project));
 const labels:Record<AgentFilter,string>={working:say('运行中','Working'),recent:say('最近活跃','Recent'),all:say('全部','All')};
 const anyChats=shown.some(group=>group.members.some(agent=>activity.get(agent.id)!.chats.length));
 return <>
  <div className="mandala-task-scope" role="group" aria-label={say('智能体筛选','Agent filter')}>{(['all','working','recent'] as const).map(value=><Button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{labels[value]} <span className="mandala-scope-count">{counts[value]}</span></Button>)}</div>
  <div className="mandala-task-toolbar"><label className="progress-search"><Icon name="search" size={16}/><Input aria-label={say('搜索智能体','Search Agents')} placeholder={say('搜索智能体或项目','Search Agents or projects')} value={search} onChange={event=>setSearch(event.target.value)}/></label>{anyChats&&<Button variant="ghost" className="icon-button task-expand-all" aria-pressed={expandAll} aria-label={expandAll?say('全部收起','Collapse all'):say('全部展开','Expand all')} title={expandAll?say('全部收起','Collapse all'):say('全部展开，查看每位 Agent 的对话','Expand all to see each Agent’s chats')} onClick={onExpandAll}><Icon name={expandAll?'collapseAll':'expandAll'} size={16}/></Button>}</div>
  {unknown>0&&<p className="mandala-panel-summary" role="status">{say(`${unknown} 个对话执行状态未知`,`${unknown} chats with unknown execution status`)}</p>}
  {!shown.length&&<EmptyState icon="agent">{query?say('没有匹配的智能体。','No matching Agents.'):filter==='working'?say('现在没有正在干活的 Agent。','No Agent is working right now.'):filter==='recent'?say('最近 24 小时没有活跃的 Agent。','No Agent was active in the last 24 hours.'):say('还没有团队。','No team yet.')}</EmptyState>}
  {shown.map(group=>{
   const working=group.members.filter(agent=>activity.get(agent.id)!.working).length;
   return <section key={group.id} className="mandala-team" {...group.project?drag('project',group.id):{}}>
    <Disclosure open className="mandala-team-group" title={<>{group.project?<IdentityAvatar identity={group.project} kind="project" size={14}/>:<Icon name="project" size={14}/>}<span className="mandala-team-name">{group.project?.name??say('未关联项目','Unassociated')}</span><span className="mandala-team-count">{group.total}</span>{working>0&&<span className="mandala-team-working"><i aria-hidden="true"/>{say(`${working} 运行中`,`${working} working`)}</span>}</>}>
     {!group.members.length&&<p className="mandala-team-empty">{say('尚未关联 Agent','No Agents associated')}</p>}
     {group.members.map(agent=>{
      const state=activity.get(agent.id)!,tone=state.running?'active':state.approvals?'warning':state.failed?'danger':'neutral';
      const current=state.chats.find(row=>row.executionStatus==='running'),doing=current&&(current.latestProgress?.text??current.title??current.requestPreview)?.replace(/\s+/g,' ').trim();
      const parts=[state.running&&say(`${state.running} 个运行对话`,`${state.running} running chats`)+(doing?say(`：${doing}`,`: ${doing}`):''),state.approvals&&say(`${state.approvals} 个待审批`,`${state.approvals} awaiting approval`),state.failed&&say(`${state.failed} 个执行失败`,`${state.failed} failed`),state.unknown&&say(`${state.unknown} 个对话执行状态未知`,`${state.unknown} chats with unknown execution status`)].filter(Boolean) as string[];
      if(!parts.length)parts.push(say('空闲','Idle'));
      if(!state.working&&state.lastActiveAt)parts.push(say(`${relativeTime(state.lastActiveAt,english,now)}活跃`,`active ${relativeTime(state.lastActiveAt,english,now)}`));
      return <div className="mandala-team-agent" data-tone={tone} key={agent.id} {...drag('agent',agent.id)}>
       <IdentityAvatar identity={agent} kind="agent" size={24}/>
       <button type="button" className="mandala-team-agent-name" title={agent.name} onClick={()=>onOpen('/agents/'+agent.id)}>{agent.name}</button>
       {reference('agent',agent.id,agent.name)}
       <small className="mandala-team-agent-status">{(state.working||state.failed)?<StatusMark tone={tone} shape={state.running?'play':'alert'}/>:<i className="mandala-idle-dot" data-recent={state.recent||undefined} aria-hidden="true"/>}<span title={parts.join(' · ')}>{parts.join(' · ')}</span></small>
       {state.chats.length>0&&<Disclosure className="task-work-related" open={expandAll} title={<ExecutionMarks rows={state.chats} tasks={tasks}/>} summaryLabel={say(`展开 ${agent.name} 的对话`,`Show ${agent.name}’s chats`)}><ExecutionChats rows={state.chats} tasks={tasks} config={config} onOpen={onOpen}/></Disclosure>}
      </div>;
     })}
    </Disclosure>
    {group.project&&<div className="mandala-team-heading">{reference('project',group.id,group.project.name)}</div>}
   </section>;
  })}
 </>;
}
