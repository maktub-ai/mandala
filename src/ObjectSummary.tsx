import {useEffect,useState} from 'react';
import type {Task} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import type {AutomationState} from '../shared/automations';
import type {MemoryCollection,MemoryRevision} from '../shared/memory';
import {requestJson} from './api';
import {useLanguage} from './i18n';
import {DirectoryLink} from './SettingsObjectBrowser';
import {ObjectGroup} from './ObjectExperience';
import {memoryGroup,memoryMatchesAgent,taskMatchesAgent} from './object-scope';
import Button from './ui/Button';
import Icon from './ui/Icon';

function useSummaryResource<T>(path:string,key:string,revision:number) {
 const [state,setState]=useState<{key:string;data:T|null;error:boolean}>({key,data:null,error:false});
 useEffect(()=>{
  const controller=new AbortController();let fetching=false;
  setState({key,data:null,error:false});
  const load=async()=>{if(fetching||document.hidden)return;fetching=true;try {const data=await requestJson<T>(path,{signal:controller.signal});if(!controller.signal.aborted)setState({key,data,error:false});}catch{if(!controller.signal.aborted)setState({key,data:null,error:true});}finally{fetching=false;}};
  void load();const timer=setInterval(()=>void load(),15000);const visible=()=>{if(!document.hidden)void load();};document.addEventListener('visibilitychange',visible);
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[path,key,revision]);
 return state.key===key?state:{key,data:null,error:false};
}

export default function ObjectSummary({kind,id,disabled,onNavigate}: {kind:'project'|'agent';id:string;disabled:boolean;onNavigate:(path:string)=>void}) {
 const {text: localize, language}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en),[revision,setRevision]=useState(0),key=kind+':'+id;
 const tasks=useSummaryResource<Task[]>('/api/v2/tasks',key,revision);
 const chats=useSummaryResource<ConversationProgress[]>('/api/conversation-progress?windowMinutes=360',key,revision);
 const extra=useSummaryResource<AutomationState|{records:MemoryRevision[];collections:MemoryCollection[]}>(kind==='project'?'/api/automations':'/api/v2/memory/records?status=active',key,revision);
 const matches=(item:{projectId?:string|null;agentId?:string|null})=>kind==='project'?item.projectId===id:item.agentId===id;
 const associatedTasks=tasks.data?Array.from(new Map(tasks.data.filter(task=>kind==='project'?task.projectId===id:taskMatchesAgent(task,id)).map(task=>[task.id,task])).values()):null;
 const attention=associatedTasks?.filter(task=>task.state==='waiting'||task.state==='review').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
 const associatedChats=chats.data?.filter(matches),latest=associatedChats?.reduce((value,chat)=>chat.activityAt>value?chat.activityAt:value,'');
 const schedules=extra.data&&'automations' in extra.data?extra.data.automations.filter(matches):null;
 const memories=extra.data&&'records' in extra.data?extra.data.records.filter(record=>record.status==='active'&&memoryGroup(record)!=='sessions'&&memoryMatchesAgent(record,extra.data&&'collections' in extra.data?extra.data.collections:[],id)):null;
 const scope=new URLSearchParams({[kind==='project'?'project':'agent']:id});
 const value=(count:number|undefined,error:boolean)=>error?say('暂不可用','Unavailable'):count===undefined?say('读取中…','Loading…'):String(count);
 const taskHref='/tasks?'+scope+'&type=tasks&scope=all&state=all',chatHref='/tasks?'+scope+'&type=conversations&scope=all';
 return <ObjectGroup title={kind==='project'?say('工作概况','Work overview'):say('工作与记忆概况','Work and memory')} actions={(tasks.error||chats.error||extra.error)&&<Button onClick={()=>setRevision(v=>v+1)}>{say('重试','Retry')}</Button>}>
  <div className="object-summary-grid">
   <DirectoryLink className="object-summary-item" href={taskHref} disabled={disabled} onNavigate={onNavigate}><span><Icon name="plan" size={16}/>{say('关联任务','Associated tasks')}<strong>{value(associatedTasks?.length,tasks.error)}</strong></span><small>{attention?say(`${attention.length} 项待处理` ,`${attention.length} need attention`):say('任务与参与记录','Assigned and participating work')}</small></DirectoryLink>
   <DirectoryLink className="object-summary-item" href={chatHref} disabled={disabled} onNavigate={onNavigate}><span><Icon name="message" size={16}/>{say('对话','Chats')}<strong>{value(associatedChats?.length,chats.error)}</strong></span><small>{latest?say('最近：','Latest: ')+new Date(latest).toLocaleDateString(language):say('查看对话记录','View chat history')}</small></DirectoryLink>
   <DirectoryLink className="object-summary-item" href={kind==='project'?'/schedules?'+scope:'/mana?tab=memory&'+scope} disabled={disabled} onNavigate={onNavigate}><span><Icon name={kind==='project'?'schedule':'memory'} size={16}/>{kind==='project'?say('定时任务','Schedules'):say('有效记忆','Active memories')}<strong>{value(schedules?.length??memories?.length,extra.error)}</strong></span><small>{schedules?say(`${schedules.filter(item=>item.enabled).length} 项已启用`,`${schedules.filter(item=>item.enabled).length} enabled`):kind==='project'?say('查看定时规则','View schedules'):say('查看记忆与来源','View memories and sources')}</small></DirectoryLink>
  </div>
  {!!attention?.length&&<div className="object-summary-attention">{attention.slice(0,3).map(task=><DirectoryLink className="object-summary-task" key={task.id} href={'/tasks/'+encodeURIComponent(task.id)+'?'+scope} disabled={disabled} onNavigate={onNavigate}><Icon name="plan" size={14}/><span>{task.goal.split('\n')[0]}</span><small>{task.state==='review'?say('待审阅','Review'):say('待处理','Needs attention')}</small><Icon name="chevronRight" size={14}/></DirectoryLink>)}</div>}
 </ObjectGroup>;
}
