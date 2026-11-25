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
import WorkspaceFirstUse from './ui/WorkspaceFirstUse';
import StatusMark from './ui/StatusMark';
import IdentityAvatar from './IdentityAvatar';
import ExecutionChats,{ExecutionMarks} from './ExecutionChats';
import {relativeTime,recentWindowMs} from './mandala-panel-time';
import type {Automation} from '../shared/automations';
import {scheduleText} from './MandalaSchedulesTab';

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

/** Enabled schedules first by next run, paused ones last. */
export function upcomingRules(rules:readonly Automation[],agentId?:string){
 return rules.filter(rule=>rule.enabled&&(!agentId||rule.agentId===agentId)).sort((a,b)=>(a.nextRunAt??'~').localeCompare(b.nextRunAt??'~')||a.name.localeCompare(b.name));
}
export default function MandalaTeamsTab({config,agents,groups,rows,tasks,rules=[],expandAll,onExpandAll,reference,drag,onOpen}:{config:Config;agents:Agent[];groups:Group[];rows:ConversationProgress[];tasks:Task[];rules?:Automation[];expandAll:boolean;onExpandAll:()=>void;reference:(kind:ComposerReferenceItem['kind'],id:string,name:string)=>ReactNode;drag:Drag;onOpen:(path:string)=>void}){
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
  {!shown.length&&(!query&&filter==='all'?<WorkspaceFirstUse size="panel" title={say('还没有团队','No team yet')} slot={{fields:[say('智能体','Agent'),say('负责的项目','Projects')]}}>{say('在聊天里说出要组建的智能体，或在“智能体”页添加；它们会按项目出现在这里。','Ask for an Agent in this chat or add one on the Agents page; they appear here by project.')}</WorkspaceFirstUse>:<EmptyState icon="agent">{query?say('没有匹配的智能体。','No matching Agents.'):filter==='working'?say('现在没有正在干活的 Agent。','No Agent is working right now.'):say('最近 24 小时没有活跃的 Agent。','No Agent was active in the last 24 hours.')}</EmptyState>)}
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
       {(()=>{const own=upcomingRules(rules,agent.id),next=own[0];if(!next)return null;
        return <button type="button" className="mandala-team-agent-schedule" title={next.name} onClick={()=>onOpen('/schedules?schedule='+next.id)}><Icon name="clock" size={13}/><span>{next.name} · {scheduleText(next.schedule,english)}{next.nextRunAt?' · '+say(`下次 ${relativeTime(next.nextRunAt,english,now)}`,`next ${relativeTime(next.nextRunAt,english,now)}`):''}{own.length>1?say(` 等 ${own.length} 个`,` +${own.length-1}`):''}</span></button>;})()}
       {state.chats.length>0&&<Disclosure className="task-work-related" open={expandAll} title={<ExecutionMarks rows={state.chats} tasks={tasks}/>} summaryLabel={say(`展开 ${agent.name} 的对话`,`Show ${agent.name}’s chats`)}><ExecutionChats rows={state.chats} tasks={tasks} config={config} onOpen={onOpen}/></Disclosure>}
      </div>;
     })}
    </Disclosure>
    {group.project&&<div className="mandala-team-heading">{reference('project',group.id,group.project.name)}</div>}
   </section>;
  })}
  {(()=>{const next=upcomingRules(rules),paused=rules.filter(rule=>!rule.enabled).length;if(!rules.length)return null;
   return <section className="mandala-team-schedules" aria-label={say('定时','Schedules')}>
    <h3 className="mandala-collab-heading"><span>{say('定时','Schedules')}</span><span className="mandala-scope-count">{next.length}</span><span className="mandala-collab-heading-note">{say('按下次执行','By next run')}</span></h3>
    {next.slice(0,3).map(rule=>{const owner=config.agents.find(agent=>agent.id===rule.agentId);return <button type="button" key={rule.id} className="mandala-team-schedule" title={rule.name} onClick={()=>onOpen('/schedules?schedule='+rule.id)}>
     <Icon name="clock" size={14}/><span className="mandala-team-schedule-name">{rule.name}</span><span className="mandala-team-schedule-meta">{[owner?.name,rule.nextRunAt?relativeTime(rule.nextRunAt,english,now):scheduleText(rule.schedule,english)].filter(Boolean).join(' · ')}</span>
    </button>;})}
    <a className="mandala-all-tasks" href="/schedules" onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen('/schedules');}}>{next.length>3||paused?say(`打开全部定时（${rules.length}）`,`Open all schedules (${rules.length})`):say('打开全部定时','Open all schedules')}<Icon name="arrowRight" size={14}/></a>
   </section>;})()}
 </>;
}
