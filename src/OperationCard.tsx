import {useState,type ReactNode} from 'react';
import Icon,{type IconName} from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import Disclosure from './ui/Disclosure';
import './operation-cards.css';

/** `flat` is for cards whose content is required reading (a question awaiting the user); `open` starts a foldable card expanded. */
export default function OperationCard({title,icon,status,tone='neutral',children,footer,actions,primaryActions,label,summary,flat=false,open}:{title:string;icon:IconName;status?:string;tone?:'neutral'|'active'|'success'|'warning'|'danger';children?:ReactNode;footer?:ReactNode;actions?:ReactNode;primaryActions?:ReactNode;label?:string;summary?:ReactNode;flat?:boolean;open?:boolean}){
 const [initiallyOpen]=useState(open); // Opens once; a decision made inside does not snap it shut.
 const head=<><span className="operation-type"><Icon name={icon} size={18}/></span><span className="operation-heading-main"><strong title={title}>{title}</strong>{summary&&<span className="operation-summary">{summary}</span>}</span>{status&&<StatusLabel filled icon="clock" tone={tone}>{status}</StatusLabel>}</>;
 const body=<>{children&&<div className="operation-card-body">{children}</div>}{(footer||actions)&&<footer className="operation-card-footer"><span className="operation-card-meta">{footer}</span><div className="operation-card-actions">{actions}</div></footer>}</>;
 return <section className="operation-card" data-tone={tone} aria-label={label??title}>{flat?<div className="operation-flat"><div className="operation-flat-head">{head}</div>{body}</div>:<Disclosure className="operation-receipt" open={initiallyOpen} summaryLabel={title} title={head}>{body}</Disclosure>}{primaryActions&&<div className="operation-primary-actions">{primaryActions}</div>}</section>;
}

export function OperationLink({path,children,onOpen,iconOnly=true,className}:{path:string;children:string;onOpen:(path:string)=>void;iconOnly?:boolean;className?:string}){
 return <a className={iconOnly?'operation-icon-link':className} aria-label={children} title={children} href={path} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(path);}}>{!iconOnly&&children}<Icon name="external-link" size={15}/></a>;
}
