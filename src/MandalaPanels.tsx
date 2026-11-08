import TelegramTaskNotification from './TelegramTaskNotification';
import TaskWorkCard from './TaskWorkCard';
import TaskBoard from './TaskBoard';
import Input from './ui/Input';
import MandalaTeamsTab from './MandalaTeamsTab';
import MandalaSchedulesTab from './MandalaSchedulesTab';
import {useEffect,useRef,useState} from 'react';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {MandalaGoal} from '../shared/mandala-coordination';
import type {AutomationState} from '../shared/automations';
import {type ConversationProgress} from '../shared/conversation-progress';
import type {ComposerReferenceItem} from '../shared/composer-references';
import {api} from './api';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Tabs,{TabPanel} from './ui/Tabs';
import EmptyState from './ui/EmptyState';
import LoadingState from './ui/LoadingState';
import Icon from './ui/Icon';
import {followAssetPage} from './AssetLibrary';
import {taskLaneState} from './task-relations';
import {MandalaPetCard} from './MandalaPet';
import './mandala-panels.css';

export const referenceDragType='application/x-mandala-reference';
export function goalTaskIds(goalId:string):Set<string>{return new Set([goalId]);}
export function maintainedTeams(config:Config){
 const agents=config.agents.filter(agent=>!agent.systemRole&&!agent.temporary&&!agent.archivedAt);
 const projects=config.projects.filter(project=>!project.archivedAt);
 return {agents,groups:[...projects.map(project=>({id:project.id,project,agents:agents.filter(agent=>project.agentIds.includes(agent.id))})),{id:'unassociated',project:null,agents:agents.filter(agent=>!projects.some(project=>project.agentIds.includes(agent.id)))}]};
}
export default function MandalaPanels({conversationId,config,references,onReference,onOpen,visible,onCatalogRefresh}:{conversationId:string;config:Config;onCatalogRefresh:()=>void;references:ComposerReferenceItem[];onReference:(item:ComposerReferenceItem)=>void;onOpen:(path:string)=>void;visible:boolean}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [tab,setTab]=useState('tasks'),[goals,setGoals]=useState<MandalaGoal[]>([]),[tasks,setTasks]=useState<Task[]>([]),[rows,setRows]=useState<ConversationProgress[]>([]),[schedules,setSchedules]=useState<AutomationState>({version:1,automations:[],runs:[]});
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const [taskScope,setTaskScope]=useState<'conversation'|'all'>('conversation'),[search,setSearch]=useState(''),[expandAll,setExpandAll]=useState(false),[teamsExpanded,setTeamsExpanded]=useState(false);
 useEffect(()=>{setTaskScope('conversation');setSearch('');},[conversationId]);
 const generation=useRef(0);
 const goalIdentity=goals.map(goal=>goal.taskId).join(',');
 useEffect(()=>{if(goalIdentity)onCatalogRefresh();},[goalIdentity,onCatalogRefresh]);
 useEffect(()=>{
  if(!visible)return;const version=++generation.current;let pending=false;
  const reload=async()=>{if(pending||document.hidden)return;pending=true;try{
   const [g,t,p,s]=await Promise.all([api<MandalaGoal[]>('/mandala/goals'),api<Task[]>('/v2/tasks'),api<ConversationProgress[]>('/conversation-progress'),api<AutomationState>('/automations')]);
   if(generation.current===version){setGoals(g);setTasks(t);setRows(p);setSchedules(s);setError('');}
  }catch(reason){if(generation.current===version){setGoals([]);setTasks([]);setRows([]);setSchedules({version:1,automations:[],runs:[]});setError((reason as Error).message);}}
  finally{pending=false;if(generation.current===version)setLoading(false);}};
  void reload();const interval=setInterval(()=>void reload(),3000),changed=()=>void reload();document.addEventListener('visibilitychange',changed);
  return()=>{generation.current++;clearInterval(interval);document.removeEventListener('visibilitychange',changed);};
 },[visible,retry,config]);
 const {agents,groups}=maintainedTeams(config),owned=new Set(goals.flatMap(goal=>[...goalTaskIds(goal.taskId)]));
 const maintainedRows=rows.filter(row=>agents.some(agent=>agent.id===row.agentId));
 const rules=schedules.automations.filter(rule=>rule.reportConversationId?rule.reportConversationId===conversationId:rule.agentId===config.mandala?.agentId||!!(rule.goalId??rule.taskId)&&owned.has((rule.goalId??rule.taskId)!));
 const itemFor=(kind:ComposerReferenceItem['kind'],id:string)=>references.find(item=>item.kind===kind&&item.objectId===id);
 const drag=(kind:ComposerReferenceItem['kind'],id:string)=>({draggable:!!itemFor(kind,id),onDragStart:(event:React.DragEvent)=>{const item=itemFor(kind,id);if(item){event.stopPropagation();event.dataTransfer.setData(referenceDragType,item.id);event.dataTransfer.effectAllowed='copy';}}});
 const reference=(kind:ComposerReferenceItem['kind'],id:string,name:string)=>{const item=itemFor(kind,id);return <Button className="mandala-reference" disabled={!item} aria-label={say('引用 ','Reference ')+name} onClick={()=>item&&onReference(item)}><Icon name="link" size={15}/><span>{say('引用','Reference')}</span></Button>;};
 const conversationGoals=goals.filter(goal=>goal.conversationId===conversationId),scopedGoals=taskScope==='all'?goals:conversationGoals;
 const matchingGoals=scopedGoals.filter(goal=>{const ids=goalTaskIds(goal.taskId);return !search.trim()||[goal.task,...tasks.filter(task=>ids.has(task.id))].some(task=>[task.goal,config.agents.find(agent=>agent.id===task.assigneeAgentId)?.name,config.projects.find(project=>project.id===task.projectId)?.name].some(value=>value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));});
 const visibleIds=new Set(matchingGoals.flatMap(goal=>[...goalTaskIds(goal.taskId)]));
 const panelTasks=[...new Map([...matchingGoals.map(goal=>goal.task),...tasks.filter(task=>visibleIds.has(task.id))].map(task=>[task.id,task])).values()];
 const mandalaName=config.agents.find(agent=>agent.id===config.mandala?.agentId)?.name||'Mandala';
 return <div className="mandala-panels"><MandalaPetCard name={mandalaName} onOpen={onOpen} active={visible}/><Tabs id="mandala-panel" label={say('Mandala 工作','Mandala work')} value={tab} onChange={setTab} options={[{value:'tasks',label:say('任务','Tasks')},{value:'teams',label:say('智能体','Agents')},{value:'scheduled',label:say('定时','Scheduled')}]}/>
  <TabPanel id="mandala-panel" value={tab} className="mandala-panel-body">
   {loading?<LoadingState label={say('正在读取…','Loading…')}/>:error?<div role="alert"><p>{error}</p><Button onClick={()=>{setLoading(true);setRetry(value=>value+1);}}>{say('重试','Retry')}</Button></div>:<>
   {tab==='tasks'&&<><div className="mandala-task-scope" role="group" aria-label={say('任务范围','Task scope')}>{(['conversation','all'] as const).map(value=><Button key={value} aria-pressed={taskScope===value} onClick={()=>setTaskScope(value)}>{value==='conversation'?say(`本对话 ${conversationGoals.length}`,`This chat ${conversationGoals.length}`):say(`全部任务 ${goals.length}`,`All tasks ${goals.length}`)}</Button>)}</div><div className="mandala-task-toolbar"><label className="progress-search"><Icon name="search" size={16}/><Input aria-label={say('搜索跟进目标','Search owned goals')} placeholder={say('搜索任务、智能体或项目','Search tasks, Agents or projects')} value={search} onChange={event=>setSearch(event.target.value)}/></label>{matchingGoals.length>0&&<Button variant="ghost" className="icon-button task-expand-all" aria-pressed={expandAll} aria-label={expandAll?say('全部收起','Collapse all'):say('全部展开','Expand all')} title={expandAll?say('全部收起','Collapse all'):say('全部展开，查看每个任务的执行对话与最新进展','Expand all to see each task’s chats and latest progress')} onClick={()=>setExpandAll(value=>!value)}><Icon name={expandAll?'collapseAll':'expandAll'} size={16}/></Button>}</div>{!matchingGoals.length&&<EmptyState icon="plan">{search.trim()?say('没有匹配的任务。','No matching tasks.'):taskScope==='conversation'?say('本对话还没有任务。在聊天中交代想完成的事情。','No tasks in this chat yet. Describe what you want to accomplish.'):say('还没有负责的任务。在聊天中交代想完成的事情。','No owned tasks yet. Describe what you want to accomplish in chat.')}</EmptyState>}
    <TaskBoard tasks={panelTasks} taskLane={task=>taskLaneState(task,tasks,rows)} board={false} onChanged={async()=>setRetry(value=>value+1)} renderCard={(task,controls)=><div draggable onDragStart={event=>{const item=itemFor('task',task.id);if(item)event.dataTransfer.setData(referenceDragType,item.id);event.stopPropagation();event.dataTransfer.effectAllowed='copy';}}><TaskWorkCard task={task} tasks={tasks.filter(task=>owned.has(task.id))} config={config} href={'/tasks/'+task.id} board={false} expanded={expandAll} progressRows={rows} excludeConversationId={conversationId} onOpen={onOpen} controls={<>{controls}<TelegramTaskNotification taskId={task.id}/></>} reference={reference('task',task.id,task.goal.split('\n')[0])}>{goals.find(goal=>goal.taskId===task.id)?.blockedReason&&<p className="operation-card-error">{goals.find(goal=>goal.taskId===task.id)?.blockedReason}</p>}</TaskWorkCard></div>}/>
    <a className="mandala-all-tasks" href="/tasks?scope=all" onClick={followAssetPage}>{say('打开全部任务','Open all tasks')}<Icon name="arrowRight" size={14}/></a>
   </>}
   {tab==='teams'&&<MandalaTeamsTab config={config} agents={agents} groups={groups} rows={maintainedRows} tasks={tasks} expandAll={teamsExpanded} onExpandAll={()=>setTeamsExpanded(value=>!value)} reference={reference} drag={drag} onOpen={onOpen}/>}
   {tab==='scheduled'&&<MandalaSchedulesTab rules={rules} runs={schedules.runs} onOpen={onOpen}/>}
   </>}
  </TabPanel><p className="mandala-panel-hint">{say('点击或拖动目标、项目、Agent 可加入引用。','Click or drag a goal, Project or Agent to reference it.')}</p>
 </div>;
}
