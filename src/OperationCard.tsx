import type {ReactNode} from 'react';
import Icon,{type IconName} from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import './operation-cards.css';

/**
 * A chat card reads in one pass: one header line (type · summary · status) and its object rows, always visible.
 * Only long bodies (full replies, exact diffs) fold, in place. `headless` drops the header when the card holds a single row.
 */
export default function OperationCard({title,icon,status,tone='neutral',children,footer,actions,primaryActions,label,summary,headless=false,attention=false,as:Tag='section'}:{title:string;icon:IconName;status?:string;tone?:'neutral'|'active'|'success'|'warning'|'danger';children?:ReactNode;footer?:ReactNode;actions?:ReactNode;primaryActions?:ReactNode;label?:string;summary?:ReactNode;headless?:boolean;attention?:boolean;as?:'section'|'article'}){
 return <Tag className="operation-card" data-tone={tone} data-attention={attention||undefined} aria-label={label??title}>
  {!headless&&<header className="operation-head">
   <Icon name={icon} size={14} className="operation-head-icon"/>
   <strong className="operation-head-title" title={title}>{title}</strong>
   {summary&&<span className="operation-summary">{summary}</span>}
   {status&&<StatusLabel filled icon="clock" tone={tone}>{status}</StatusLabel>}
  </header>}
  {children&&<div className="operation-card-body">{children}</div>}
  {(footer||actions)&&<footer className="operation-card-footer"><span className="operation-card-meta">{footer}</span><div className="operation-card-actions">{actions}</div></footer>}
  {primaryActions&&<div className="operation-primary-actions">{primaryActions}</div>}
 </Tag>;
}

export function OperationLink({path,children,onOpen,iconOnly=true,className,icon='external-link'}:{path:string;children:string;onOpen:(path:string)=>void;iconOnly?:boolean;className?:string;icon?:IconName}){
 return <a className={iconOnly?'operation-icon-link':className} aria-label={children} title={children} href={path} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(path);}}>{!iconOnly&&children}{(iconOnly||icon!=='external-link')&&<Icon name={icon} size={15}/>}</a>;
}

/** Segmented progress for a group of rows; colours follow each row's state. */
export function OperationProgress({states,label}:{states:('done'|'active'|'waiting'|'failed')[];label:string}){
 return <span className="operation-progress" role="img" aria-label={label}>{states.map((state,index)=><span key={index} data-state={state}/>)}</span>;
}
