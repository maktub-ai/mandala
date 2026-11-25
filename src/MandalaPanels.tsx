import MandalaTeamsTab from './MandalaTeamsTab';
import MandalaCollabTab from './MandalaCollabTab';
import {collabFocusEvent} from './mandala-collab';
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
import LoadingState from './ui/LoadingState';
import Icon from './ui/Icon';
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
 const [tab,setTab]=useState('collab'),[goals,setGoals]=useState<MandalaGoal[]>([]),[tasks,setTasks]=useState<Task[]>([]),[rows,setRows]=useState<ConversationProgress[]>([]),[schedules,setSchedules]=useState<AutomationState>({version:1,automations:[],runs:[]});
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const [teamsExpanded,setTeamsExpanded]=useState(false);
 // The delegation card in the chat can ask for its receiving chat; show the collaboration tab first.
 const [focus,setFocus]=useState<{conversationId:string;at:number}|null>(null);
 useEffect(()=>{const show=(event:Event)=>{const id=(event as CustomEvent<{conversationId?:string}>).detail?.conversationId;if(!id)return;setTab('collab');setFocus({conversationId:id,at:Date.now()});};addEventListener(collabFocusEvent,show);return()=>removeEventListener(collabFocusEvent,show);},[]);
 const generation=useRef(0);
 const goalIdentity=goals.map(goal=>goal.taskId).join(',');
 const previousGoals=useRef<string|null>(null);
 useEffect(()=>{if(loading)return;if(previousGoals.current!==null&&previousGoals.current!==goalIdentity)onCatalogRefresh();previousGoals.current=goalIdentity;},[goalIdentity,loading,onCatalogRefresh]);
 useEffect(()=>{
  if(!visible)return;const version=++generation.current,controller=new AbortController();let pending=false;
  const reload=async()=>{if(pending||document.hidden)return;pending=true;try{
   const [g,t,p,s]=await Promise.all([api<MandalaGoal[]>('/mandala/goals','GET',undefined,controller.signal),api<Task[]>('/v2/tasks','GET',undefined,controller.signal),api<ConversationProgress[]>('/conversation-progress','GET',undefined,controller.signal),api<AutomationState>('/automations','GET',undefined,controller.signal)]);
   if(generation.current===version){setGoals(g);setTasks(t);setRows(p);setSchedules(s);setError('');}
  }catch(reason){if(generation.current===version){setGoals([]);setTasks([]);setRows([]);setSchedules({version:1,automations:[],runs:[]});setError((reason as Error).message);}}
  finally{pending=false;if(generation.current===version)setLoading(false);}};
  void reload();const interval=setInterval(()=>void reload(),3000),changed=()=>void reload();document.addEventListener('visibilitychange',changed);
  return()=>{generation.current++;controller.abort();clearInterval(interval);document.removeEventListener('visibilitychange',changed);};
 },[visible,retry,config]);
 const {agents,groups}=maintainedTeams(config);
 const maintainedRows=rows.filter(row=>agents.some(agent=>agent.id===row.agentId));
 // Every schedule belongs to the Agent that runs it; the Agents tab shows them in that place.
 const rules=schedules.automations;
 const itemFor=(kind:ComposerReferenceItem['kind'],id:string)=>references.find(item=>item.kind===kind&&item.objectId===id);
 const drag=(kind:ComposerReferenceItem['kind'],id:string)=>({draggable:!!itemFor(kind,id),onDragStart:(event:React.DragEvent)=>{const item=itemFor(kind,id);if(item){event.stopPropagation();event.dataTransfer.setData(referenceDragType,item.id);event.dataTransfer.effectAllowed='copy';}}});
 const reference=(kind:ComposerReferenceItem['kind'],id:string,name:string)=>{const item=itemFor(kind,id);return <Button className="mandala-reference" disabled={!item} aria-label={say('引用 ','Reference ')+name} onClick={()=>item&&onReference(item)}><Icon name="link" size={15}/><span>{say('引用','Reference')}</span></Button>;};
 const mandalaName=config.agents.find(agent=>agent.id===config.mandala?.agentId)?.name||'Mandala';
 return <div className="mandala-panels"><MandalaPetCard name={mandalaName} onOpen={onOpen} active={visible}/><Tabs id="mandala-panel" label={say('Mandala 工作','Mandala work')} value={tab} onChange={setTab} options={[{value:'collab',label:say('协作','Collaboration')},{value:'teams',label:say('智能体','Agents')}]}/>
  <TabPanel id="mandala-panel" value={tab} className="mandala-panel-body">
   {loading?<LoadingState label={say('正在读取…','Loading…')}/>:error?<div role="alert"><p>{error}</p><Button onClick={()=>{setLoading(true);setRetry(value=>value+1);}}>{say('重试','Retry')}</Button></div>:<>
   {tab==='collab'&&<MandalaCollabTab conversationId={conversationId} config={config} goals={goals} tasks={tasks} rows={rows} runs={schedules.runs} focus={focus} reference={reference} drag={drag} onOpen={onOpen}/>}
   {tab==='teams'&&<MandalaTeamsTab config={config} agents={agents} groups={groups} rows={maintainedRows} tasks={tasks} rules={rules} expandAll={teamsExpanded} onExpandAll={()=>setTeamsExpanded(value=>!value)} reference={reference} drag={drag} onOpen={onOpen}/>}
   </>}
  </TabPanel><p className="mandala-panel-hint">{say('点击或拖动对话、任务、项目、Agent 可加入引用。','Click or drag a chat, Task, Project or Agent to reference it.')}</p>
 </div>;
}
