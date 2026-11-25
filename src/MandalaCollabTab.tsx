import {useEffect,useRef,useState,type MouseEvent,type ReactNode} from 'react';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {MandalaGoal} from '../shared/mandala-coordination';
import type {AutomationRun} from '../shared/automations';
import type {ConversationProgress} from '../shared/conversation-progress';
import type {ComposerReferenceItem} from '../shared/composer-references';
import {executionResultHref} from '../shared/conversation-results';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Input from './ui/Input';
import Icon from './ui/Icon';
import EmptyState from './ui/EmptyState';
import WorkspaceFirstUse from './ui/WorkspaceFirstUse';
import StatusMark,{statusShape} from './ui/StatusMark';
import IdentityAvatar from './IdentityAvatar';
import {taskTone} from './TaskWorkCard';
import {followAssetPage} from './AssetLibrary';
import {relativeTime} from './mandala-panel-time';
import {collabChatLabels,collabChatShape,collabChatTone,collabSections,type CollabChat,type CollabItem} from './mandala-collab';

type Drag=(kind:ComposerReferenceItem['kind'],id:string)=>object;
type Reference=(kind:ComposerReferenceItem['kind'],id:string,name:string)=>ReactNode;
const taskWords:Record<Task['state'],[string,string]>={todo:['待开始','To do'],running:['进行中','In progress'],waiting:['等待中','Waiting'],review:['待验收','Awaiting review'],completed:['已完成','Completed'],cancelled:['已取消','Cancelled']};

export default function MandalaCollabTab({conversationId,config,goals,tasks,rows,runs,focus,reference,drag,onOpen}:{
 conversationId:string;config:Config;goals:MandalaGoal[];tasks:Task[];rows:ConversationProgress[];runs:AutomationRun[];focus?:{conversationId:string;at:number}|null;reference:Reference;drag:Drag;onOpen:(path:string)=>void;
}){
 const {text:t,language}=useLanguage(),english=language!=='zh-CN',now=Date.now();
 const [search,setSearch]=useState(''),[showDone,setShowDone]=useState(false);
 const [openChat,setOpenChat]=useState<string|null>(null),[taskOpen,setTaskOpen]=useState<Record<string,boolean>>({});
 // null keeps each Task's own default; the toolbar forces all open or all closed until a single Task is toggled.
 const [expandAll,setExpandAll]=useState<boolean|null>(null);
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{setSearch('');setOpenChat(null);setTaskOpen({});setExpandAll(null);},[conversationId]);
 // The delegation card in the chat asks to show its receiving chat here.
 useEffect(()=>{
  const id=focus?.conversationId;if(!id)return;
  setOpenChat(id);setShowDone(true);const task=tasks.find(task=>task.conversationIds.includes(id));if(task)setTaskOpen(value=>({...value,[task.id]:true}));
  requestAnimationFrame(()=>root.current?.querySelector(`[data-chat-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'}));
 },[focus?.at]);
 const agents=new Map(config.agents.map(agent=>[agent.id,agent])),projects=new Map(config.projects.map(project=>[project.id,project.name]));
 const names=({agentIds,projectIds}:{agentIds:string[];projectIds:string[]})=>[...agentIds.map(id=>agents.get(id)?.name),...projectIds.map(id=>projects.get(id))];
 const base={conversationId,goals,tasks,rows,runs,names};
 // The panel answers for this chat only; every Task lives on the Tasks page.
 const sections=collabSections({...base,scope:'conversation',query:search});
 const follow=(path:string)=>(event:MouseEvent<HTMLAnchorElement>)=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(path);};
 const labels=collabChatLabels(t);
 const isTaskOpen=(item:Extract<CollabItem,{kind:'task'}>)=>expandAll??taskOpen[item.id]??item.defaultOpen;
 const allTasks=[...sections.needs,...sections.active,...sections.done].filter((item):item is Extract<CollabItem,{kind:'task'}>=>item.kind==='task');
 const toggleTask=(id:string,next:boolean)=>{
  if(expandAll!==null){setTaskOpen(Object.fromEntries([...allTasks.map(item=>[item.id,expandAll] as const),[id,next] as const]));setExpandAll(null);}
  else setTaskOpen(value=>({...value,[id]:next}));
 };
 const anyTasks=[...sections.needs,...sections.active,...sections.done].some(item=>item.kind==='task'&&item.chats.length>0);

 const chatRow=({row,status}:CollabChat,nested=false)=>{
  const agent=agents.get(row.agentId),title=row.title??row.requestPreview?.split('\n')[0]??t('新对话','New chat'),path='/?conversation='+encodeURIComponent(row.id),open=openChat===row.id;
  const progress=row.latestProgress?.text?.replace(/\s+/g,' ').trim(),fallback=row.requestPreview?.replace(/\s+/g,' ').trim();
  const speaker=progress?agent?.name??t('智能体','Agent'):fallback?t('你','You'):null,preview=progress||fallback;
  return <article key={row.id} className="mandala-chat-row" data-chat-id={row.id} data-open={open||undefined} data-nested={nested||undefined} {...drag('chat',row.id)}>
   <span className="mandala-chat-avatar">{agent?<IdentityAvatar identity={agent} kind="agent" size={nested?24:28}/>:<Icon name="agent" size={18}/>}</span>
   <div className="mandala-chat-main">
    <div className="mandala-chat-heading">
     <button type="button" className="mandala-chat-title" aria-expanded={open} title={title} onClick={()=>setOpenChat(open?null:row.id)}>{title}</button>
     {row.hasNewActivity&&<i className="mandala-new-dot" role="img" aria-label={t('有新回复','New reply')}/>}
     <time dateTime={row.activityAt}>{relativeTime(row.activityAt,english,now)}</time>
     {reference('chat',row.id,title)}
    </div>
    <p className="mandala-chat-status" data-tone={collabChatTone[status]}><StatusMark tone={collabChatTone[status]} shape={collabChatShape[status]}/><span>{labels[status]}</span>{agent&&<><span aria-hidden="true">·</span><span>{agent.name}</span></>}</p>
    {preview&&<p className="mandala-chat-preview" data-open={open||undefined}>{speaker&&<strong>{speaker}{t('：',': ')}</strong>}{preview}</p>}
    {open&&<div className="mandala-chat-actions">
     <a className="mandala-chat-action" data-primary href={path} onClick={follow(path)}><Icon name="send" size={13}/>{t('打开对话继续追问','Open chat to follow up')}</a>
    </div>}
   </div>
  </article>;
 };

 // The Task keeps one project tag (with its blueprint lane) so the project and its module stay one click away.
 const projectLink=(task:Task)=>{
  const id=task.projectIds?.[0];if(!id)return null;
  const project=config.projects.find(item=>item.id===id);if(!project)return null;
  const lane=(project.blueprintEnabled??config.blueprintDefaultEnabled)&&task.moduleRef?.projectId===id?task.moduleRef.lane:null;
  // A module tag opens that module in the blueprint tab; a plain project tag opens the overview.
  const path='/projects/'+encodeURIComponent(id)+(lane?'/blueprint?'+new URLSearchParams({lane}):'/overview');
  const label=lane?project.name+' · '+lane:project.name,more=(task.projectIds?.length??1)-1;
  return <a className="mandala-collab-task-project" href={path} title={label+(more?t(` 等 ${more+1} 个项目`,` and ${more} more`):'')} aria-label={label} onClick={follow(path)}><IdentityAvatar identity={project} kind="project" size={12}/><span>{label}</span>{more>0&&<small>+{more}</small>}</a>;
 };
 const taskRow=(item:Extract<CollabItem,{kind:'task'}>)=>{
  const {task,chats,goal}=item,open=isTaskOpen(item),title=task.goal.split('\n')[0],href='/tasks/'+task.id,tone=taskTone(task.state);
  return <section key={task.id} className="mandala-collab-task" data-open={open||undefined} {...drag('task',task.id)}>
   <div className="mandala-collab-task-head">
    <button type="button" className="mandala-collab-task-toggle" aria-expanded={open} disabled={!chats.length} aria-label={(open?t('收起 ','Collapse '):t('展开 ','Expand '))+title} onClick={()=>toggleTask(task.id,!open)}><Icon name={open?'chevronDown':'chevronRight'} size={14}/></button>
    <Icon name="plan" size={14}/>
    <a className="mandala-collab-task-title" href={href} title={title} onClick={follow(href)}>{title}</a>
    {reference('task',task.id,title)}
   </div>
   {/* The second line carries everything about the Task, so its title keeps the whole first line. Review happens in the Task itself. */}
   <div className="mandala-collab-task-meta">
    <span className="mandala-collab-task-state" data-tone={tone}><StatusMark tone={tone} shape={statusShape(task.state)}/>{t(...taskWords[task.state])}</span>
    {projectLink(task)}
    <span className="mandala-collab-task-count">{t(`${chats.length} 个对话`,`${chats.length} chats`)}</span>
   </div>
   {goal?.blockedReason&&<p className="operation-card-error mandala-collab-task-blocked">{goal.blockedReason}</p>}
   {open&&chats.length>0&&<div className="mandala-collab-task-chats">{chats.map(chat=>chatRow(chat,true))}</div>}
  </section>;
 };

 const runRow=(run:AutomationRun)=>{
  const path=run.conversationId?executionResultHref(run.conversationId,run.runId):run.taskId?'/tasks/'+run.taskId:'/schedules?schedule='+run.automationId;
  return <a key={run.id} className="mandala-collab-run" href={path} onClick={follow(path)}>
   <Icon name="schedule" size={14}/><span className="mandala-collab-run-title" title={run.name}>{run.name}</span>
   <span className="mandala-collab-task-state" data-tone="warning"><StatusMark tone="warning" shape="clock"/>{t('定时结果待确认','Scheduled result to review')}</span>
  </a>;
 };
 const render=(item:CollabItem)=>item.kind==='task'?taskRow(item):item.kind==='chat'?chatRow(item.chat):runRow(item.run);
 const heading=(label:string,count:number,extra?:ReactNode)=><h3 className="mandala-collab-heading"><span>{label}</span><span className="mandala-scope-count">{count}</span>{extra}</h3>;
 const total=sections.needs.length+sections.active.length+sections.done.length;

 return <div ref={root} className="mandala-collab">
  <div className="mandala-task-toolbar mandala-collab-toolbar">
   <label className="progress-search"><Icon name="search" size={14}/><Input aria-label={t('搜索协作','Search collaborations')} placeholder={t('搜索对话、任务或 Agent','Search chats, Tasks or Agents')} value={search} onChange={event=>setSearch(event.target.value)}/></label>
   {anyTasks&&<Button variant="ghost" className="icon-button task-expand-all" aria-pressed={!!expandAll} aria-label={expandAll?t('全部收起','Collapse all'):t('全部展开','Expand all')} title={expandAll?t('收起全部任务','Collapse every task'):t('展开全部任务，查看每个任务下的对话','Expand every task to see its chats')} onClick={()=>{setExpandAll(!expandAll);setTaskOpen({});}}><Icon name={expandAll?'collapseAll':'expandAll'} size={16}/></Button>}
  </div>
  {!total&&(search.trim()?<EmptyState icon="search">{t('没有匹配的协作。','No matching collaborations.')}</EmptyState>:<WorkspaceFirstUse size="panel" title={t('还没有协作','No collaborations yet')}
   slot={{shape:'task',fields:[t('标题','Title'),t('智能体 · 状态','Agent · status')]}}>{t('在聊天里请智能体帮忙，协作对话和任务会出现在这里。','Ask an Agent for help in this chat; collaboration chats and tasks appear here.')}</WorkspaceFirstUse>)}
  {sections.needs.length>0&&<section className="mandala-collab-section" data-section="needs" aria-label={t('需要你','Needs you')}>{heading(t('需要你','Needs you'),sections.needs.length)}{sections.needs.map(render)}</section>}
  {sections.active.length>0&&<section className="mandala-collab-section" data-section="active" aria-label={t('动态','Activity')}>{heading(t('动态','Activity'),sections.active.length,<span className="mandala-collab-heading-note">{t('按最近变化','By latest change')}</span>)}{sections.active.map(render)}</section>}
  {sections.done.length>0&&<section className="mandala-collab-section" data-section="done" aria-label={t('已收尾','Wrapped up')}>
   <button type="button" className="mandala-collab-heading mandala-collab-done-toggle" aria-expanded={showDone} onClick={()=>setShowDone(value=>!value)}><Icon name={showDone?'chevronDown':'chevronRight'} size={14}/><span>{t('已收尾','Wrapped up')}</span><span className="mandala-scope-count">{sections.done.length}</span></button>
   {showDone&&sections.done.map(render)}
  </section>}
  <a className="mandala-all-tasks" href="/tasks?scope=all" onClick={followAssetPage}>{t('打开全部任务','Open all tasks')}<Icon name="arrowRight" size={14}/></a>
 </div>;
}
