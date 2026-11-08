import {createContext,useCallback,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {TaskNotice,TaskNotices} from '../shared/task-notifications';
import {api} from './api';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Icon from './ui/Icon';
import {Popover,PopoverContent,PopoverTrigger} from './components/ui/popover';
import './task-notifications.css';

type SaveFailure={id:string;message:string;goal:string;taskId?:string;retry:()=>Promise<unknown>};
type InboxNotice=TaskNotice&{read:boolean};
type InboxFailure=SaveFailure&{read:boolean};
type Inbox={items:InboxNotice[];failures:InboxFailure[];error:string;retrying:string;refresh:()=>void;markRead:()=>void;dismiss:(id:string)=>void;retry:(failure:SaveFailure)=>Promise<void>;onOpen:(href:string)=>void};
const NotificationContext=createContext<Inbox|null>(null);
export function reportTaskSaveFailure(failure:SaveFailure){window.dispatchEvent(new CustomEvent('mandala-task-save-failed',{detail:failure}));}

export default function TaskNotifications({onOpen,children}:{onOpen:(href:string)=>void;children:ReactNode}){
 const [items,setItems]=useState<InboxNotice[]>([]),[failures,setFailures]=useState<InboxFailure[]>([]),[error,setError]=useState(''),[retrying,setRetrying]=useState('');
 const refresh=useRef<()=>void>(()=>{});
 useEffect(()=>{
  const receive=(event:Event)=>{const failure=(event as CustomEvent<SaveFailure>).detail;setFailures(current=>[...current.filter(item=>item.id!==failure.id),{...failure,read:false}]);};
  addEventListener('mandala-task-save-failed',receive);return()=>removeEventListener('mandala-task-save-failed',receive);
 },[]);
 useEffect(()=>{
  let active=true,cursor:number|undefined,inFlight=false;
  const poll=async()=>{if(inFlight||document.hidden)return;inFlight=true;try{
   const data=await api<TaskNotices>('/v2/task-notifications'+(cursor===undefined?'':'?after='+cursor));
   if(active){cursor=data.cursor;setError('');if(data.items.length)setItems(old=>{let next=old;for(const item of data.items)next=[...next.filter(prior=>prior.id!==item.id&&(prior.taskId!==item.taskId||prior.runId!==item.runId)),{...item,read:false}];return next.slice(-50);});}
  }catch(reason){if(active)setError((reason as Error).message);}finally{inFlight=false;}};
  refresh.current=()=>void poll();void poll();const timer=setInterval(poll,3000);document.addEventListener('visibilitychange',refresh.current);
  return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh.current);};
 },[]);
 const markRead=useCallback(()=>{setItems(old=>old.every(item=>item.read)?old:old.map(item=>({...item,read:true})));setFailures(old=>old.every(item=>item.read)?old:old.map(item=>({...item,read:true})));},[]);
 const dismiss=(id:string)=>{setItems(old=>old.filter(item=>item.id!==id));setFailures(old=>old.filter(item=>item.id!==id));};
 const retry=async(failure:SaveFailure)=>{setRetrying(failure.id);try{if(await failure.retry())dismiss(failure.id);}catch(reason){setFailures(old=>old.map(item=>item.id===failure.id?{...item,message:(reason as Error).message}:item));}finally{setRetrying('');}};
 return <NotificationContext.Provider value={{items,failures,error,retrying,refresh:()=>refresh.current(),markRead,dismiss,retry,onOpen}}>{children}</NotificationContext.Provider>;
}

export function TaskNotificationInbox({disabled=false}:{disabled?:boolean}){
 const inbox=useContext(NotificationContext),{text:t,language}=useLanguage(),[open,setOpen]=useState(false),descriptionId=useId();
 useEffect(()=>{if(open)inbox?.markRead();},[open,inbox?.items,inbox?.failures,inbox?.markRead]);
 if(!inbox)return null;
 const {items,failures,error,retrying,dismiss,retry,onOpen}=inbox,unread=items.filter(item=>!item.read).length+failures.filter(item=>!item.read).length;
 const labels:Record<string,string>={completed:t('任务已完成','Task completed'),review:t('交付待审阅','Ready for review'),succeeded:t('本次执行已结束','Execution finished'),approval:t('需要审批','Approval required'),input:t('需要补充信息','Input required'),failed:t('执行失败','Execution failed'),unknown:t('状态待确认','Status unconfirmed'),waiting:t('任务需要处理','Task needs attention')};
 const openPath=(event:React.MouseEvent<HTMLAnchorElement>,href:string)=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();setOpen(false);onOpen(href);};
 const time=(at:string)=>new Date(at).toLocaleString(language,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
 return <Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild><Button variant="ghost" className="notification-inbox-trigger" disabled={disabled} aria-label={t('通知','Notifications')} title={t('通知','Notifications')} aria-describedby={descriptionId}><Icon name="inbox" size={16}/>{unread>0&&<span className="notification-unread-count">{unread}</span>}<span id={descriptionId} className="notification-sr-only">{t(`${unread} 条未读通知`,`${unread} unread notifications`)}</span></Button></PopoverTrigger>
  <PopoverContent className="notification-inbox" side="top" align="end" sideOffset={8} collisionPadding={12} aria-label={t('通知','Notifications')}>
   <header><h2>{t('通知','Notifications')}</h2><Button variant="ghost" size="sm" aria-label={t('关闭通知面板','Close notifications')} onClick={()=>setOpen(false)}><Icon name="close" size={16}/></Button></header>
   <div className="notification-inbox-list">
    {error&&<div className="notification-load-error"><span>{t('通知暂时无法刷新','Could not refresh notifications')}</span><Button variant="ghost" size="sm" onClick={inbox.refresh}>{t('重试','Retry')}</Button></div>}
    {!items.length&&!failures.length&&<div className="notification-inbox-empty"><Icon name="inbox" size={20}/><strong>{t('暂无通知','No notifications yet')}</strong><p>{t('任务动态会安静地收在这里。','Task updates will collect here quietly.')}</p></div>}
    {failures.map(failure=><div className="notification-inbox-row notification-save-failure" key={failure.id}>
     <Icon name="error" size={16}/><div className="notification-row-content"><strong title={failure.goal}>{failure.goal.split('\n')[0]}</strong><span className="notification-row-state" data-tone="danger">{t('任务保存未完成','Task was not fully saved')}</span><p>{failure.message}</p><div className="notification-recovery-actions"><Button size="sm" disabled={!!retrying} busy={retrying===failure.id} onClick={()=>void retry(failure)}>{t('重试保存','Retry save')}</Button>{failure.taskId&&<a href={'/tasks/'+failure.taskId} onClick={event=>openPath(event,'/tasks/'+failure.taskId)}>{t('查看任务','View task')}</a>}</div></div>
     <Button className="notification-dismiss" variant="ghost" aria-label={t('关闭保存提示 ','Dismiss save notice ')+failure.goal} onClick={()=>dismiss(failure.id)}><Icon name="close" size={14}/></Button>
    </div>)}
    {[...items].reverse().map(item=>{const review=['approval','input'].includes(item.state)&&item.executionConversationId,href=review?'/?conversation='+encodeURIComponent(item.executionConversationId!):'/tasks/'+encodeURIComponent(item.taskId),title=item.title||item.goal;
     const icon=item.state==='failed'?'error':item.state==='completed'||item.state==='succeeded'?'check':review?'approval':'clock';
     return <div className="notification-inbox-row" key={item.id}>
      <Icon name={icon} size={16}/><a className="notification-row-content" href={href} aria-label={review?t('查看审批','Review approval'):title} onClick={event=>openPath(event,href)}><strong title={title}>{title}</strong><span className="notification-row-meta"><span className="notification-row-state" data-tone={item.state==='failed'?'danger':review?'warning':'neutral'}>{labels[item.state]??labels.waiting}</span><time dateTime={item.createdAt}>{time(item.createdAt)}</time></span>{review&&<span className="notification-row-action">{t('查看审批','Review approval')}<Icon name="arrowRight" size={12}/></span>}</a>
      <Button className="notification-dismiss" variant="ghost" aria-label={t('关闭通知 ','Dismiss notification ')+title} onClick={()=>dismiss(item.id)}><Icon name="close" size={14}/></Button>
     </div>;
    })}
   </div>
   <footer><a href="/tasks" onClick={event=>openPath(event,'/tasks')}>{t('查看全部任务','View all tasks')}<Icon name="arrowRight" size={14}/></a></footer>
  </PopoverContent>
 </Popover>;
}
