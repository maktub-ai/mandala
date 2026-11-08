import TaskWorkCard from './TaskWorkCard';
import {taskLaneState} from './task-relations';
import {taskMatchesAgent} from './object-scope';
import Button from './ui/Button';
import Input from './ui/Input';
import Disclosure from './ui/Disclosure';
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {Automation} from '../shared/automations';
import type {ConversationProgress as Progress,ConversationProgressState} from '../shared/conversation-progress';
import {api} from './api';
import {followAssetPage,navigateAssetPage} from './AssetLibrary';
import {useLanguage} from './i18n';
import Icon from './ui/Icon';
import Select from './ui/Select';
import LoadingState from './ui/LoadingState';
import TaskBoard from './TaskBoard';
import ProgressItem from './ProgressItem';
import ExplicitProgressView from './ExplicitProgressView';
import {buildTaskProgressIndex,taskInProgressWindow} from './progress-presentation';
import './conversation-progress.css';

const taskWords:Record<Task['state'],[string,string]>={todo:['待办','To do'],running:['进行中','In progress'],waiting:['待处理','Needs attention'],review:['待验收','Awaiting review'],completed:['已完成','Completed'],cancelled:['已取消','Cancelled']};
const stateWords:Record<ConversationProgressState,[string,string]>={running:['执行中','Running'],queued:['排队中','Queued'],waiting:['等待协作','Waiting for a reply'],attention:['需要处理','Needs attention'],recent:['最近使用','Recent'],completed:['对话已结束','Chat closed']};
export default function ConversationProgress({config,tasks,tasksLoading,tasksError,board,rules,onTasksChanged,onProgressChanged,hideView=false}:{config:Config;tasks:Task[];tasksLoading:boolean;tasksError:string;board:boolean;hideView?:boolean;rules:Automation[];onTasksChanged:()=>Promise<void>;onProgressChanged?:(rows:Progress[])=>void}){
 const query=new URLSearchParams(location.search),kind=query.get('type')==='conversations'||query.get('tab')==='conversations'?'conversations':'tasks';
 const queryScope=['active','completed','all'].includes(query.get('scope')??'')?query.get('scope')!:'active',queryWindow=['60','240','360','1440'].includes(query.get('window')??'')?query.get('window')!:'360';
 const creationSource=['user','non-user','unknown'].includes(query.get('createdBy')??'')?query.get('createdBy')!:'all';
 const includeTasks=kind==='tasks',includeConversations=kind==='conversations';
 useEffect(()=>{setProject(query.get('project')??'');setAgent(query.get('agent')??'');setTaskState(query.get('state')??'active');setOrder(query.get('sort')??'newest');setSearch(query.get('q')??'');setScope(queryScope);setWindowMinutes(queryWindow);},[location.search]);
 useEffect(()=>{try{const params=new URLSearchParams(location.search);params.delete('action');sessionStorage.setItem('mana-progress-route','/tasks'+(params.size?'?'+params:''));}catch{/* Keep URL state when session storage is unavailable. */}},[location.search]);
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [rows,setRows]=useState<Progress[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const [search,setSearch]=useState(query.get('q')??''),[expandAll,setExpandAll]=useState(false),[project,setProject]=useState(new URLSearchParams(location.search).get('project')??''),[agent,setAgent]=useState(query.get('agent')??''),[scope,setScope]=useState(queryScope),[windowMinutes,setWindowMinutes]=useState(queryWindow),[taskState,setTaskState]=useState(query.get('state')??'active'),[order,setOrder]=useState(query.get('sort')??'newest'),[filtersOpen,setFiltersOpen]=useState(query.get('filters')==='1');
 useEffect(()=>{onProgressChanged?.(rows);},[rows,onProgressChanged]);
 const dragged=useRef<string|null>(null),mutating=useRef(false),latestRequest=useRef(0),currentWindow=useRef(windowMinutes);
 currentWindow.current=windowMinutes;
 const reload=async()=>{
  const request=++latestRequest.current;
  try{const value=await api<Progress[]>('/conversation-progress?windowMinutes='+currentWindow.current);if(request===latestRequest.current){setRows(value);setError('');}}
  catch(e){if(request===latestRequest.current)setError((e as Error).message);}
  finally{if(request===latestRequest.current)setLoading(false);}
 };
 useEffect(()=>{
  let active=true,inFlight=false;
  const poll=async()=>{if(!active||document.hidden||inFlight||mutating.current)return;inFlight=true;await reload();inFlight=false;};
  void poll();const timer=setInterval(()=>void poll(),3000),visible=()=>{if(!document.hidden)void poll();};document.addEventListener('visibilitychange',visible);
  return()=>{active=false;latestRequest.current++;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[windowMinutes]);
 const move=async(id:string,complete:boolean)=>{
  if(mutating.current)return;mutating.current=true;setSaving(true);dragged.current=null;latestRequest.current++;
  try{await api('/conversation-progress/'+id,'POST',{action:complete?'complete':'reopen'});await reload();}
  catch(e){setError((e as Error).message);}finally{mutating.current=false;setSaving(false);}
 };
 const filters=rows.filter(row=>includeConversations&&(!project||row.projectId===project)&&(!agent||row.agentId===agent)&&
  (scope==='all'||scope==='completed'?scope==='all'||!!row.completedAt:row.active||row.state==='completed'&&row.withinWindow)&&
  (!search.trim()||[row.title,row.requestPreview,config.agents.find(a=>a.id===row.agentId)?.name,config.projects.find(p=>p.id===row.projectId)?.name].some(value=>value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))));
 const taskHref=(id:string)=>'/tasks/'+id+(location.search||'');
 const changeFilter=(name:string,value:string,replace=false)=>{const next=new URLSearchParams(location.search);if(!replace){next.delete('tab');if(kind==='conversations')next.set('type',kind);else next.delete('type');}if(value)next.set(name,value);else next.delete(name);const path=(/^\/tasks\/[^/]+$/.test(location.pathname)?location.pathname:'/tasks')+(next.size?'?'+next:'');if(replace)history.replaceState(null,'',path);else navigateAssetPage(path);};
 const changeView=(view:string)=>changeFilter('view',view);
 const taskActivity=useMemo(()=>buildTaskProgressIndex(tasks,rows),[tasks,rows]),now=Date.now();
 const matchingTasks=tasks.filter(task=>includeTasks&&(scope!=='active'||taskInProgressWindow(taskActivity.get(task.id)!,Number(windowMinutes),now))&&(creationSource==='all'||creationSource==='non-user'?creationSource==='all'||['agent','system'].includes(task.creationSource??'unknown'):creationSource===(task.creationSource??'unknown'))&&(!project||task.projectId===project)&&(!agent||taskMatchesAgent(task,agent))&&(scope!=='completed'||task.state==='completed')&&(taskState==='all'||taskState==='active'?taskState==='all'||task.state!=='cancelled':task.state===taskState)&&(!search.trim()||[task.goal,config.agents.find(a=>a.id===task.assigneeAgentId)?.name,config.projects.find(p=>p.id===task.projectId)?.name].some(value=>value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))).sort((a,b)=>(order==='oldest'?taskActivity.get(a.id)!.activityAt.localeCompare(taskActivity.get(b.id)!.activityAt):taskActivity.get(b.id)!.activityAt.localeCompare(taskActivity.get(a.id)!.activityAt))||a.id.localeCompare(b.id));
 const taskLane=(task:Task)=>{const state=taskLaneState(task,tasks,rows);return state==='cancelled'?'completed':state;};
 const standalone=filters.filter(row=>!includeTasks||!matchingTasks.some(task=>row.taskIds.includes(task.id))).sort((a,b)=>(order==='oldest'?a.activityAt.localeCompare(b.activityAt):b.activityAt.localeCompare(a.activityAt))||a.id.localeCompare(b.id));
 const card=(row:Progress)=>{
  const owner=config.agents.find(a=>a.id===row.agentId),p=config.projects.find(p=>p.id===row.projectId),relatedTasks=tasks.filter(t=>row.taskIds.includes(t.id));
  const relatedChats=row.relatedConversationIds.flatMap(id=>{const c=rows.find(r=>r.id===id);return c?[c]:[];});
  return <ProgressItem key={row.id} kind="chat" id={row.id} title={row.title??say('未命名对话','Untitled conversation')} preview={row.requestPreview} state={row.state} status={row.completedAt&&row.state==='attention'?say('对话已结束 · 需要处理','Chat closed · Needs attention'):say(...stateWords[row.state])} owner={owner} project={p} at={row.activityAt} href={'/?conversation='+row.id} summary={row.latestProgress?<ExplicitProgressView progress={row.latestProgress} compact/>:undefined} newActivity={row.hasNewActivity} draggable={board&&!saving}
   onDragStart={event=>{dragged.current=row.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',row.id);}} onDragEnd={()=>{dragged.current=null;}}>
   {row.requestPreview&&<p className="progress-detail-copy"><small>{say('最近请求摘录','Latest request excerpt')}</small>{row.requestPreview}</p>}
   {(relatedTasks.length>0||relatedChats.length>0)&&<div className="progress-relations"><small>{say(relatedTasks.length?'所属任务':'协作对话',relatedTasks.length?'Task':'Collaborating chats')}</small>
    {relatedTasks.map(task=><a key={task.id} href={taskHref(task.id)} onClick={followAssetPage}><Icon name="plan" size={14}/><span>{task.goal.split('\n')[0]}</span><Icon name="arrowRight" size={13}/></a>)}
    {relatedChats.map(chat=><a key={chat.id} href={'/?conversation='+chat.id} onClick={followAssetPage}><Icon name="message" size={14}/><span>{chat.title??say('相关对话','Related conversation')}</span><Icon name="arrowRight" size={13}/></a>)}
   </div>}
   <div className="progress-item-actions"><Button type="button" disabled={saving} onClick={()=>void move(row.id,!row.completedAt)}><Icon name={row.completedAt?'rotate':'check'} size={14}/>{row.completedAt?say('重新打开','Reopen'):say('标记完成','Mark completed')}</Button><a href={'/?conversation='+row.id} onClick={followAssetPage}>{say('打开对话','Open chat')}<Icon name="arrowRight" size={13}/></a></div>
  </ProgressItem>;
 };
 const taskCard=(task:Task,controls?:ReactNode)=>{const rule=rules.find(item=>item.taskId===task.id);return <TaskWorkCard task={task} tasks={matchingTasks} config={config} board={board} selectionOnly={!board} progressRows={rows} expanded={expandAll} controls={controls} href={taskHref(task.id)}>{rule&&<p className="progress-schedule">{!rule.enabled?say('执行规则未启用','Schedule disabled'):rule.nextRunAt?say('下次执行：','Next run: ')+new Date(rule.nextRunAt).toLocaleString():say('执行计划已结束','Schedule ended')}</p>}</TaskWorkCard>;};
 const loadingProgress=loading||includeTasks&&tasksLoading;
 const filterCount=[project,agent,includeTasks&&creationSource!=='all',scope!=='active',scope==='active'&&windowMinutes!=='360',taskState!=='active',order!=='newest'].filter(Boolean).length;
 const filteredEmpty=!!search.trim()||filterCount>0;
 const clearFilters=()=>{setSearch('');setScope('active');setWindowMinutes('360');navigateAssetPage('/tasks?'+(includeConversations?'type=conversations&':'')+'view='+(board?'board':'list'));};
 const hasHistory=includeTasks?tasks.length>0:rows.length>0;
 const showHistory=()=>{const next=new URLSearchParams(location.search);next.set('scope','all');if(taskState==='active')next.set('state','all');navigateAssetPage('/tasks?'+next);};
 return <section className="conversation-progress">
  <div className="progress-toolbar"><label className="progress-search"><Icon name="search" size={16}/><Input type="search" aria-label={includeTasks?say('搜索任务','Search tasks'):say('搜索对话','Search chats')} placeholder={includeTasks?say('搜索任务、智能体或项目','Search tasks, Agents or projects'):say('搜索对话、智能体或项目','Search chats, Agents or projects')} value={search} onChange={e=>{setSearch(e.target.value);changeFilter('q',e.target.value,true);}}/></label>
   <div hidden={hideView} className="progress-view" role="group" aria-label={say('任务显示方式','Task display')}><Button aria-pressed={!board} onClick={()=>changeView('list')}><Icon name="list-check" size={15}/>{say('列表','List')}</Button><Button aria-pressed={board} onClick={()=>changeView('board')}><Icon name="grid" size={15}/>{say('看板','Board')}</Button></div>
   {includeTasks&&<Button className="progress-filter-toggle progress-expand-all" type="button" aria-pressed={expandAll} title={say('展开每个任务的执行对话与最新进展','Show each task’s chats and latest progress')} onClick={()=>setExpandAll(value=>!value)}><Icon name={expandAll?'collapseAll':'expandAll'} size={15}/>{expandAll?say('全部收起','Collapse all'):say('全部展开','Expand all')}</Button>}
   <Button className="progress-filter-toggle" type="button" aria-label={say('筛选','Filters')} aria-expanded={filtersOpen} aria-controls="progress-filters" onClick={()=>{const next=!filtersOpen;setFiltersOpen(next);changeFilter('filters',next?'1':'');}}><Icon name="filter" size={15}/>{say('筛选','Filters')}</Button>
  </div>
  {filteredEmpty&&<div className="progress-active-filters" role="region" aria-label={say('当前筛选','Active filters')}>
   {([[project,project&&(config.projects.find(item=>item.id===project)?.name??project),()=>{setProject('');changeFilter('project','');}],[agent,agent&&(config.agents.find(item=>item.id===agent)?.name??agent),()=>{setAgent('');changeFilter('agent','');}],[scope!=='active',scope==='completed'?say('仅已完成','Completed only'):say('包含历史事项','Include past work'),()=>{setScope('active');changeFilter('scope','');}],[scope==='active'&&windowMinutes!=='360',say(`最近 ${Number(windowMinutes)/60} 小时`,`Last ${Number(windowMinutes)/60} hours`),()=>{setWindowMinutes('360');changeFilter('window','');}],[includeTasks&&creationSource!=='all',say(...(creationSource==='user'?['用户创建','User created']:creationSource==='non-user'?['非用户创建','Non-user created']:['来源未记录','Origin not recorded']) as [string,string]),()=>changeFilter('createdBy','')],[includeTasks&&taskState!=='active',taskState==='all'?say('全部状态','All states'):say(...(taskWords[taskState as Task['state']]??[taskState,taskState])),()=>{setTaskState('active');changeFilter('state','');}],[order==='oldest',say('最早优先','Oldest first'),()=>{setOrder('newest');changeFilter('sort','');}],[search.trim(),say(`搜索：${search.trim()}`,`Search: ${search.trim()}`),()=>{setSearch('');changeFilter('q','',true);}]] as [unknown,string,()=>void][]).filter(([on])=>on).map(([,label,remove])=><span className="progress-filter-chip" key={label}>{label}<button type="button" aria-label={say('移除筛选：','Remove filter: ')+label} onClick={remove}><Icon name="close" size={12}/></button></span>)}
   <Button variant="ghost" type="button" onClick={clearFilters}>{say('清除筛选','Clear filters')}</Button>
  </div>}
  <div className="progress-filters" id="progress-filters" hidden={!filtersOpen}>
   <Select icon="filter" ariaLabel={say('可见范围','Visibility')} value={scope} onChange={value=>{setScope(value);changeFilter('scope',value==='active'?'':value);}} options={[{value:'active',label:say('活跃与已完成','Active & completed')},{value:'completed',label:say('仅已完成','Completed only')},{value:'all',label:say('包含历史事项','Include past work')}]}/>
   <Select icon="project" ariaLabel={say('进度项目','Progress project')} value={project} onChange={value=>{setProject(value);changeFilter('project',value);}} options={[{value:'',label:say('全部项目','All projects')},...config.projects.map(p=>({value:p.id,label:p.name}))]}/>
   <Select icon="agent" ariaLabel={say('进度负责人','Progress owner')} value={agent} onChange={value=>{setAgent(value);changeFilter('agent',value);}} options={[{value:'',label:say('全部智能体','All Agents')},...config.agents.map(a=>({value:a.id,label:a.name}))]}/>
   {<Select icon="clock" disabled={scope!=='active'} ariaLabel={say('最近使用窗口','Recent activity window')} value={windowMinutes} onChange={value=>{setWindowMinutes(value);changeFilter('window',value==='360'?'':value);}} options={[{value:'60',label:say('最近 1 小时','Last hour')},{value:'240',label:say('最近 4 小时','Last 4 hours')},{value:'360',label:say('最近 6 小时','Last 6 hours')},{value:'1440',label:say('最近 24 小时','Last 24 hours')}]}/>}
   {includeTasks&&<Select icon="agent" ariaLabel={say('任务创建来源','Task created by')} value={creationSource} onChange={value=>changeFilter('createdBy',value==='all'?'':value)} options={[{value:'all',label:say('全部任务创建来源','All Task creators')},{value:'user',label:say('用户创建','User created')},{value:'non-user',label:say('非用户创建','Non-user created')},{value:'unknown',label:say('来源未记录','Origin not recorded')}]}/>}
   {includeTasks&&<><Select ariaLabel={say('任务状态','Task status')} value={taskState} onChange={value=>{setTaskState(value);changeFilter('state',value==='active'?'':value);}} options={[{value:'active',label:say('任务：未取消','Tasks: not cancelled')},{value:'all',label:say('任务：全部状态','Tasks: all states')},...(['todo','running','waiting','review','completed','cancelled'] as const).map(value=>({value,label:say(...taskWords[value])}))]}/><Select ariaLabel={say('任务排序','Task order')} value={order} onChange={value=>{setOrder(value);changeFilter('sort',value==='newest'?'':value);}} options={[{value:'newest',label:say('最近优先','Newest first')},{value:'oldest',label:say('最早优先','Oldest first')}]}/></>}
  </div>
  {error&&<div className="progress-error" role="alert"><span>{say('无法刷新进度。','Could not refresh progress.')} {error}</span><Button onClick={()=>void reload()}>{say('重试','Retry')}</Button></div>}
  {loadingProgress?<LoadingState label={say('正在读取进度','Loading progress')}/>:(!error||rows.length>0||matchingTasks.length>0)&&(standalone.length>0||matchingTasks.length>0)?<TaskBoard tasks={matchingTasks} renderCard={taskCard} board={board} taskLane={taskLane} onChanged={onTasksChanged} conversations={{items:standalone,includeTasks,includeConversations,renderCard:card,draggedId:()=>dragged.current,onMove:(id,complete)=>void move(id,complete)}}/>:null}

  {!loadingProgress&&!error&&!(includeTasks&&tasksError)&&!standalone.length&&!matchingTasks.length&&<div className="progress-empty" data-filtered={filteredEmpty||undefined}><h2>{filteredEmpty?(includeTasks?say('当前筛选下没有任务','No tasks match these filters'):say('当前筛选下没有对话','No chats match these filters')):hasHistory?say('最近没有活动','No recent activity'):includeTasks?say('从一个任务开始','Start with a task'):say('从一次对话开始','Start with a chat')}</h2><p>{filteredEmpty?say('换个关键词，或去掉一些筛选条件。','Try another search, or remove some filters.'):hasHistory?say('超出最近使用窗口的事项已收起，仍可查看历史并继续处理。','Older work is outside the recent activity window. Open history to find it and continue.'):say('在聊天中交代想完成的事情，或记录一个待办。','Describe a deliverable in chat, or capture a to-do.')}</p><div className="progress-empty-actions">{filteredEmpty&&<Button type="button" onClick={clearFilters}>{say('清除筛选','Clear filters')}</Button>}{!filteredEmpty&&hasHistory&&scope==='active'&&<Button type="button" onClick={showHistory}>{say('查看历史事项','Show history')}</Button>}</div></div>}
 </section>;
}
