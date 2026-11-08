import {useId,useRef,useState,type ReactNode} from 'react';
import type {Task,TaskState,RunControl} from '../shared/tasks';
import type {ConversationProgress} from '../shared/conversation-progress';
import type {IconName} from './ui/Icon';
import Select from './ui/Select';
import Button from './ui/Button';
import Icon from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import {taskTone} from './TaskWorkCard';
import {statusShape} from './ui/StatusMark';
import {useLanguage} from './i18n';
import {progressLanes,taskProgressLane,chatProgressLane} from './progress-presentation';

/** Ordered by what the user does next: act, accept, wait, start, done. */
const columns:[TaskState,string,string,IconName][]=[['waiting','需要你处理','Needs attention','info'],['review','待验收','Awaiting review','approval'],['running','进行中','In progress','play'],['todo','待办','To do','clock'],['completed','已完成','Completed','circleCheck'],['cancelled','已取消','Cancelled','close']];
async function request(path:string,method='GET',body?:unknown):Promise<any>{
 const response=await fetch('/api/v2/tasks'+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json();if(!response.ok)throw new Error(result.error??'Request failed');return result;
}
type ChatProgress={items:ConversationProgress[];includeTasks:boolean;includeConversations:boolean;renderCard:(chat:ConversationProgress)=>ReactNode;draggedId:()=>string|null;onMove:(id:string,complete:boolean)=>void};
export default function TaskBoard({tasks,renderCard,onChanged,conversations,taskLane,board=true}:{tasks:Task[];renderCard:(task:Task,controls?:ReactNode)=>ReactNode;onChanged:()=>Promise<void>;conversations?:ChatProgress;taskLane?:(task:Task)=>string;board?:boolean}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [dragging,setDragging]=useState<string|null>(null),[over,setOver]=useState<TaskState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [completedOpen,setCompletedOpen]=useState<boolean|undefined>(),listId=useId();
 const moving=useRef(false),draggedTask=useRef<string|null>(null);
 const apply=async(task:Task,state:TaskState)=>{
  if(moving.current)return;moving.current=true;setBusy(true);setError('');
  try{
   const control=await request('/'+task.id+'/control') as {revision:number;runs:RunControl[]};
   if(control.revision!==task.revision)throw new Error(say('任务已更新，请重试。','Task changed; please retry.'));
   if(control.runs.some(run=>['queued','starting','running','approval','unknown'].includes(run.state)))throw new Error(say('任务仍有活动执行，请先停止执行再调整状态。','Stop the active run before changing its state.'));
   await request('/'+task.id+'/move','POST',{expectedRevision:task.revision,state});
  }catch(failure){setError((failure as Error).message);}
  finally{await onChanged().catch(()=>setError(say('无法刷新任务，请重试。','Cannot refresh tasks; please retry.')));moving.current=false;setBusy(false);}
 };
 const move=(task:Task,state:TaskState)=>{
  draggedTask.current=null;setDragging(null);setOver(null);if(busy||task.state===state)return;
  void apply(task,state);
 };
 const visibleTasks=tasks;
 const moveControl=(task:Task)=><Select className="task-card-move" ariaLabel={say('移动任务：','Move task: ')+task.goal.split('\n')[0]} value={task.state} disabled={busy} onChange={value=>move(task,value as TaskState)} options={columns.map(([value,zh,en])=>({value,label:say(zh,en)}))}/>;
 const lanes=conversations&&!conversations.includeTasks?progressLanes:conversations&&!board&&conversations.includeConversations?[{id:'waiting',words:['需要关注','Needs attention']},{id:'running',words:conversations.includeConversations?['进行中与最近','In progress & recent']:['进行中','In progress']},{id:'todo',words:['待办','To do']},{id:'completed',words:['已完成','Completed']}]:columns.filter(([state])=>state!=='cancelled'||!conversations&&tasks.some(task=>task.state==='cancelled')).map(([id,zh,en])=>({id,words:[zh,en]}));
 const inLane=(task:Task,id:string)=>(taskLane?.(task)??(conversations?taskProgressLane(task.state):task.state))===id;
 const chats=(state:string)=>(conversations?.includeConversations===false?[]:conversations?.items??[]).filter(chat=>chatProgressLane(chat.state)===state);
 const inChatLane=(chat:ConversationProgress,state:string)=>chatProgressLane(chat.state)===state;
 const acceptsDrop=(state:string)=>{
  if(!board||busy)return false;
  const chat=conversations?.items.find(item=>item.id===conversations.draggedId());
  if(chat)return !inChatLane(chat,state)&&(chat.completedAt?state===chatProgressLane(chat.reopenState):state==='completed');
  const task=tasks.find(item=>item.id===draggedTask.current);return !!task&&!inLane(task,state)&&inLane({...task,state:state as TaskState},state);
 };
 return <>
  {!conversations&&board&&<p className="task-board-hint">{say('拖动卡片调整状态；开始执行请进入任务。','Drag cards to update status. Open a task to start execution.')}</p>}
  {error&&<p role="alert">{error}</p>}
  <div className={!board?'progress-groups':'task-board'+(conversations?' progress-overview-board':'')} role="region" aria-label={conversations?say(board?'进度看板':'进度列表',board?'Progress board':'Progress list'):say(board?'任务看板':'任务列表',board?'Task board':'Task list')} tabIndex={0} aria-busy={busy}>{lanes.filter(({id})=>board||visibleTasks.some(task=>inLane(task,id))||chats(id).length).map(({id,words})=>{const state=id as TaskState,label=state==='completed'&&tasks.some(task=>task.state==='cancelled')?say('已完成与取消','Completed & cancelled'):state==='running'&&conversations?.includeConversations?say('进行中与最近','In progress & recent'):say(words[0],words[1]),collapsible=!board&&!conversations?.includeConversations&&state==='completed',expanded=completedOpen??visibleTasks.some(task=>inLane(task,state)&&location.pathname==='/tasks/'+task.id);return <section key={state} role="region" aria-label={label} className={(board?'task-group':'progress-lane')+(over===state?' is-drop-target':'')} onDragOver={event=>{if(!acceptsDrop(state)){event.dataTransfer.dropEffect='none';setOver(null);return;}event.preventDefault();event.dataTransfer.dropEffect='move';setOver(state);}} onDrop={event=>{if(!acceptsDrop(state))return;event.preventDefault();setOver(null);const chatId=conversations?.draggedId();if(chatId){const chat=conversations?.items.find(item=>item.id===chatId);if(chat&&(!!chat.completedAt!==(state==='completed')))conversations?.onMove(chatId,state==='completed');return;}const task=tasks.find(item=>item.id===draggedTask.current);if(task&&(!conversations||!inLane(task,state)))move(task,state);}}>
   <h2>{collapsible?<Button variant="ghost" className="task-completed-toggle" aria-expanded={expanded} aria-controls={listId+'-'+state} aria-label={expanded?say('收起已完成任务','Collapse completed tasks'):say('展开已完成任务','Expand completed tasks')} onClick={()=>setCompletedOpen(!expanded)}><Icon name={expanded?'chevronDown':'chevronRight'} size={14}/><span>{label}</span><span>{visibleTasks.filter(task=>inLane(task,state)).length}</span></Button>:<><StatusLabel filled icon="clock" tone={taskTone(state)} shape={statusShape(state)}>{label}</StatusLabel><span>{visibleTasks.filter(task=>inLane(task,state)).length+chats(state).length}</span></>}</h2>
   <div id={listId+'-'+state} hidden={collapsible&&!expanded} className={board?'task-board-cards':'progress-list-cards'} role="list" aria-label={label+say(conversations?'事项':'任务',conversations?' items':' tasks')}>
   {visibleTasks.filter(task=>inLane(task,state)).map(task=>{const control=moveControl(task);return <div key={task.id} role="listitem" className={'task-board-card'+(dragging===task.id?' is-dragging':'')} data-task-id={task.id} draggable={board&&!busy} onDragStart={event=>{const id=task.id;draggedTask.current=id;setDragging(id);event.dataTransfer.effectAllowed=event.dataTransfer.types.includes('application/x-mandala-reference')?'copyMove':'move';event.dataTransfer.setData('text/plain',id);}} onDragEnd={()=>{draggedTask.current=null;setDragging(null);setOver(null);}}>
    {renderCard(task,control)}
   </div>;})}
   {chats(state).map(chat=><div key={chat.id} role="listitem">{conversations!.renderCard(chat)}</div>)}
   </div>
   {/* A list holds only items; the empty note sits beside it. */}
   {!(collapsible&&!expanded)&&!visibleTasks.some(task=>inLane(task,state))&&!chats(state).length&&<p className="progress-column-empty">{say('暂无事项','Nothing here')}</p>}
  </section>;})}</div>

 </>;
}
