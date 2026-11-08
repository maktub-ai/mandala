import StatusLabel from './ui/StatusLabel';
import {statusShape} from './ui/StatusMark';
import Button from './ui/Button';
import {useId,useState,type ReactNode,type DragEventHandler} from 'react';
import type {Agent,Project} from '../shared/types';
import {followAssetPage} from './AssetLibrary';
import {useLanguage} from './i18n';
import IdentityAvatar from './IdentityAvatar';
import Icon from './ui/Icon';
import {progressTitle,progressExcerpt} from './progress-presentation';

type Props={kind:'task'|'chat';id:string;title:string;preview?:string|null;state:string;status:string;owner?:Agent;project?:Project;at:string;href:string;relations?:number;newActivity?:boolean;draggable?:boolean;onDragStart?:DragEventHandler;onDragEnd?:DragEventHandler;summary?:ReactNode;children:ReactNode};
export default function ProgressItem({kind,id,title,preview,state,status,owner,project,at,href,relations,newActivity,draggable,onDragStart,onDragEnd,summary,children}:Props){
 const {text: localize, language}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en),[open,setOpen]=useState(false),bodyId=useId();
 const age=Math.max(0,Date.now()-Date.parse(at)),minutes=Math.floor(age/60000),time=minutes<1?say('刚刚','Just now'):minutes<60?say(minutes+' 分钟前',minutes+'m ago'):minutes<1440?say(Math.floor(minutes/60)+' 小时前',Math.floor(minutes/60)+'h ago'):new Date(at).toLocaleDateString(language,{month:'short',day:'numeric'});
 const kindLabel=kind==='task'?say('任务','Task'):say('对话','Chat'),ownerName=owner?.name??say('未指派','Unassigned');
 return <article className={'progress-item '+state+(open?' is-expanded':'')} data-conversation-id={kind==='chat'?id:undefined} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}>
  <div className="progress-item-heading"><span className="progress-item-kind" title={kindLabel} aria-label={kindLabel}><Icon name={kind==='task'?'plan':'message'} size={15}/></span><a className="progress-item-title" draggable={false} href={href} title={title} onClick={followAssetPage}>{open?title:progressTitle(title)}</a></div>
  {progressExcerpt(title,preview)&&<p className="progress-item-preview">{progressExcerpt(title,preview)}</p>}
  <div className="progress-item-footer"><span className={'progress-state '+state}><StatusLabel filled shape={statusShape(state)} title={status} icon={state==='completed'?'circleCheck':state==='running'?'activity':state==='attention'||state==='review'?'info':'clock'} tone={state==='completed'?'success':state==='running'?'active':state==='attention'||state==='review'||state==='waiting'||state==='queued'?'warning':'neutral'}>{status}</StatusLabel></span>
   {newActivity&&<span className="progress-new" title={say('有新进展，仍保留在已完成','New activity; kept completed')}>{say('有新进展','New activity')}</span>}
   <span className="progress-owner" title={ownerName}>{owner?<IdentityAvatar identity={owner} kind="agent" size={16}/>:<Icon name="user" size={13}/>}<span>{ownerName}</span></span>
   {project&&<span className="progress-project" title={project.name}><IdentityAvatar identity={project} kind="project" size={13}/><span>{project.name}</span></span>}
   <time dateTime={at} title={(kind==='chat'?say('最后消息：','Last message: '):'')+new Date(at).toLocaleString()}>{time}</time><Button className="progress-expand" type="button" aria-label={say(open?'收起详情：':'展开详情：',open?'Collapse details: ':'Expand details: ')+title} aria-expanded={open} aria-controls={bodyId} onClick={()=>setOpen(value=>!value)}><Icon name="chevronRight" size={14}/><span>{relations?say(relations+' 个关联对话',relations+' linked '+(relations===1?'chat':'chats')):say('详情','Details')}</span></Button>
  </div>
  <div id={bodyId} className="progress-item-details" hidden={!open}><div className="progress-item-context"><span>{kindLabel}</span>{kind==='chat'&&state==='completed'&&<span>{say('对话已结束，任务完成单独确认','Chat closed; Task completion is separate')}</span>}{project&&<span><IdentityAvatar identity={project} kind="project" size={13}/>{project.name}</span>}</div>{summary}{children}</div>
 </article>;
}
