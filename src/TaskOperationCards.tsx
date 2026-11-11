import {useEffect,useState,type ReactNode} from 'react';
import type {DisplayEvent} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {OperationResult} from '../shared/operation-results';
import type {ConversationProgress} from '../shared/conversation-progress';
import {api} from './api';
import {executionChatsFor,operationTaskId} from './task-relations';
import StatusLabel from './ui/StatusLabel';
import {statusShape} from './ui/StatusMark';
import Icon from './ui/Icon';
import {ExecutionMarks} from './ExecutionChats';
import {taskTone} from './TaskWorkCard';
import {useLanguage} from './i18n';
import './task-object.css';

export type OperationTasks={tasks:Task[];rows:ConversationProgress[];stale:boolean;conversationId:string};
/** One authorized refresh for the active chat, shared by every task card in its history. */
export function useOperationTasks(events:DisplayEvent[],conversationId:string):OperationTasks{
 const [value,setValue]=useState<OperationTasks>({tasks:[],rows:[],stale:false,conversationId});
 const version=events.filter(event=>event.kind==='metadata'&&(event.data as {operationResult?:OperationResult}).operationResult?.kind==='task').map(event=>event.id).join(',');
 useEffect(()=>{
  if(!version)return;const controller=new AbortController();let active=true,pending=false;
  const load=async()=>{if(pending||document.hidden)return;pending=true;try{const [tasks,rows]=await Promise.all([api<Task[]>('/v2/tasks','GET',undefined,controller.signal),api<ConversationProgress[]>('/conversation-progress','GET',undefined,controller.signal)]);if(active)setValue({tasks,rows,stale:false,conversationId});}catch{if(active)setValue({tasks:[],rows:[],stale:true,conversationId});}finally{pending=false;}};
  void load();const timer=setInterval(()=>void load(),3000);document.addEventListener('visibilitychange',load);
  return()=>{active=false;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
 },[version,conversationId]);
 return value.conversationId===conversationId?value:{tasks:[],rows:[],stale:false,conversationId};
}
export function operationTask(result:OperationResult,tasks:readonly Task[]){return tasks.find(task=>task.id===operationTaskId(result));}

/** A task appears once per chat as one live row; later operations update this row in place instead of adding receipts. */
export function TaskChangeRow({task,verb,tasks,rows,conversationId,stale,onOpen}:{task:Task;verb:string;onOpen:(path:string)=>void}&Omit<OperationTasks,'conversationId'>&{conversationId?:string}){
 const {text:t}=useLanguage();
 const stateText:Record<string,string>={todo:t('待办','To do'),running:t('执行中','Running'),waiting:t('待处理','Needs attention'),review:t('待验收','Awaiting review'),completed:t('已完成','Completed'),cancelled:t('已取消','Cancelled')};
 const title=task.goal.split('\n')[0],chats=executionChatsFor(task.id,tasks,rows,conversationId);
 return <ChangeRow verb={verb} name={title} path={'/tasks/'+encodeURIComponent(task.id)} onOpen={onOpen} label={t('任务：','Task: ')+title} taskId={task.id}>
  {chats.length>0&&<ExecutionMarks rows={chats} tasks={tasks}/>}
  {stale?<StatusLabel filled icon="clock" tone="warning" shape="alert">{t('最新状态不可用','Latest state unavailable')}</StatusLabel>:<StatusLabel filled icon="clock" tone={taskTone(task.state)} shape={statusShape(task.state)}>{stateText[task.state]}</StatusLabel>}
 </ChangeRow>;
}

/** One line per change: what happened, to what, its current state, and where to open it. */
export function ChangeRow({verb,name,path,label,taskId,onOpen,children}:{verb:string;name:string;path?:string;label?:string;taskId?:string;onOpen:(path:string)=>void;children?:ReactNode}){
 const body=<><span className="turn-change-verb">{verb}</span><span className="turn-change-name" title={name}>{name}</span>{children}{path&&<Icon name="chevronRight" size={15} className="turn-change-go"/>}</>;
 return <li className="turn-change" data-task-id={taskId}>{path?<a href={path} aria-label={label??verb+' '+name} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(path);}}>{body}</a>:<div>{body}</div>}</li>;
}
