import {useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import type {Agent, Config, Project} from '../shared/types';
import {identityColor} from '../shared/identity';
import IdentityPicker from './IdentityPicker';
import {useLanguage} from './i18n';
import {DirectoryLink} from './SettingsObjectBrowser';
import IdentityAvatar from './IdentityAvatar';
import MarkdownMessage from './MarkdownMessage';
import Dialog from './Dialog';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import Icon from './ui/Icon';
import {Popover, PopoverContent, PopoverTrigger} from './components/ui/popover';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from './components/ui/dropdown-menu';
import './object-experience.css';

const objectScroll = new Map<string, number>();
// First sentence of a role or background; the full text stays on the detail page.
export const firstSentence=(text?:string)=>text?.split('\n').find(line=>line.trim())?.replace(/^#+\s*/,'').split(/(?<=[。！？!?])/)[0].replace(/[；;，,]\s*$/,'').trim();

export function ObjectGroup({title, actions, children, id}: {title:string; actions?:ReactNode; children:ReactNode; id?:string}) {
 const heading=useId();
 return <section id={id} className="object-group" aria-labelledby={heading}><div className="object-group-heading"><h2 id={heading}>{title}</h2>{actions}</div><div className="object-group-body">{children}</div></section>;
}

export function ObjectRow({label, hint, stacked, children}: {label:string; hint?:string; stacked?:boolean; children:ReactNode}) {
 return <div className={'object-row'+(stacked?' is-stacked':'')}><div className="object-row-label"><span>{label}</span>{hint&&<small>{hint}</small>}</div><div className="object-row-value">{children}</div></div>;
}

export function ObjectText({label, value, onChange, disabled, pending, footer, maxLength}: {label:string;value:string;onChange:(value:string)=>void;disabled:boolean;pending:boolean;footer?:ReactNode;maxLength?:number}) {
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [editing,setEditing]=useState(false),[preview,setPreview]=useState(false),[expanded,setExpanded]=useState(false),[overflow,setOverflow]=useState(false);
 const reader=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const element=reader.current;if(!element)return;
  const measure=()=>setOverflow(element.scrollHeight>element.clientHeight+1);
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[value,editing,expanded]);
 return <ObjectGroup title={label} actions={<div className="object-inline-actions">{editing&&<Button disabled={disabled} aria-pressed={preview} onClick={()=>setPreview(!preview)}>{preview?say('继续编辑','Continue editing'):say('预览','Preview')}</Button>}<Button disabled={disabled||editing&&pending} onClick={()=>{setEditing(!editing);setPreview(false);}}>{editing?say('完成','Done'):say('编辑','Edit')}</Button></div>}>
  {editing&&!preview?<div className="object-text-editor"><Textarea autoFocus aria-label={label} rows={8} maxLength={maxLength} disabled={disabled} value={value} onChange={event=>onChange(event.target.value)}/></div>:<div className="object-text-content"><div ref={reader} className={'object-text-reader'+(!expanded&&!editing?' is-collapsed':'')}><MarkdownMessage text={value||say('尚未填写。','Not set yet.')}/></div>{!editing&&(overflow||expanded)&&<Button className="ghost" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?say('收起','Show less'):say('展开全文','Read more')}<Icon name={expanded?'arrowUp':'chevronDown'} size={14}/></Button>}</div>}
  {footer}
 </ObjectGroup>;
}

export function ObjectIdentityFields({kind, object, nameLabel, onChange}: {kind:'project'|'agent';object:Project|Agent;nameLabel:string;onChange:(patch:Partial<Project & Agent>)=>void}) {
 const {t}=useLanguage();
 return <>
  <label>{nameLabel}<Input aria-label={nameLabel} value={object.name} onChange={event=>onChange({name:event.target.value})}/></label>
  <IdentityPicker kind={kind} identity={object} onChange={onChange}/>
  <div className="identity-settings-row"><label>{t('身份颜色')}<Input type="color" aria-label={t('身份颜色')} value={identityColor(object,kind)} onChange={event=>onChange({color:event.target.value})}/></label><Button disabled={!object.color} onClick={()=>onChange({color:undefined})}>{t('恢复默认颜色')}</Button></div>
 </>;
}

export function ObjectHeader({kind, object, config, disabled, pending, onNavigate, onChange, onDelete, children}: {
 kind:'project'|'agent'; object:Project|Agent;config:Config;disabled:boolean;pending:boolean;onNavigate:(path:string)=>void;
 onChange:(patch:Partial<Project & Agent>)=>void;onDelete:()=>void;children?:ReactNode;
}) {
 const {text: localize, t}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [dialog,setDialog]=useState<'identity'|'delete'|null>(null);
 const header=useRef<HTMLElement>(null),path=location.pathname+location.search+location.hash;
 useLayoutEffect(()=>{
  const main=header.current?.closest<HTMLElement>('.project-workbench, main');if(!main)return;
  const saved=objectScroll.get(path);
  const frame=requestAnimationFrame(()=>{
   if(saved!==undefined)main.scrollTop=saved;
   else if(location.hash)document.getElementById(location.hash.slice(1))?.scrollIntoView({block:'start'});
   else main.scrollTop=0;
  });
  const remember=()=>objectScroll.set(path,main.scrollTop);
  main.addEventListener('scroll',remember);
  return()=>{cancelAnimationFrame(frame);main.removeEventListener('scroll',remember);};
 },[path]);
 const navLocked=disabled||pending,project=kind==='project',base=project?'/projects':'/agents';
 const switchObject=(id:string)=>{
  if(project){const tab=location.pathname.endsWith('/library')?'library':location.pathname.endsWith('/settings')?'settings':'overview';onNavigate(`/projects/${encodeURIComponent(id)}/${tab}`);}
  else {const params=new URLSearchParams(location.search);params.delete('project');params.delete('from');onNavigate('/agents/'+encodeURIComponent(id)+(params.size?'?'+params:''));}
 };
 const source=new URLSearchParams(location.search).get('from');
 const returnPath=source&&/^\/(?:projects\/[^/]+\/overview|agents\/[^/?]+)(?:#associations)?$/.test(source)?source:base;
 return <>
  <header ref={header} className="object-header">
   <div className="object-location"><DirectoryLink disabled={navLocked} onNavigate={onNavigate} href={returnPath}><Icon name="arrowLeft" size={14}/>{source&&returnPath!==base?(returnPath.startsWith('/projects/')?say('返回项目','Back to project'):say('返回智能体','Back to Agent')):project?say('项目','Projects'):say('智能体','Agents')}</DirectoryLink></div>
   <div className="object-header-main"><div className="object-identity"><IdentityAvatar identity={object} kind={kind} size={28}/><h1>{object.name}</h1><Select className="object-switcher" ariaLabel={project?say('切换项目','Switch project'):say('切换智能体','Switch Agent')} value={object.id} disabled={navLocked} onChange={switchObject} options={(project?config.projects:config.agents.filter(a=>!a.systemRole && !a.temporary)).map(item=>({value:item.id,label:item.name,icon:<IdentityAvatar identity={item} kind={kind} size={20}/>}))}/></div>
    <div className="object-header-actions">{children}<DropdownMenu><DropdownMenuTrigger asChild><Button className="icon-button" disabled={disabled} aria-label={say('对象操作','Object actions')}><Icon name="more" size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>setDialog('identity')}>{say('编辑名称与外观','Edit name and appearance')}</DropdownMenuItem><DropdownMenuItem variant="destructive" disabled={navLocked} onSelect={()=>setDialog('delete')}>{project?t('删除项目'):t('删除智能体')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
   </div>
  </header>
  {dialog&&<Dialog label={dialog==='identity'?say('名称与外观','Name and appearance'):say('确认删除','Confirm deletion')} locked={disabled} onClose={()=>setDialog(null)} className="object-identity-dialog">
   <div className="object-dialog-heading"><h2>{dialog==='identity'?say('名称与外观','Name and appearance'):say('确认删除','Confirm deletion')}</h2><Button className="icon-button" disabled={disabled} aria-label={say('关闭','Close')} onClick={()=>setDialog(null)}><Icon name="close" size={16}/></Button></div>
   {dialog==='identity'?<><ObjectIdentityFields kind={kind} object={object} nameLabel={say('名称','Name')} onChange={onChange}/><p className="field-hint" role="status">{pending?say('修改尚未保存完成。可关闭弹窗，在页面查看保存状态并重试。','Changes are not saved yet. Close this dialog to review the page save status.'):say('所有修改已保存','All changes saved')}</p><Button disabled={navLocked} onClick={()=>setDialog(null)}>{say('完成','Done')}</Button></>:<><p>{object.name}</p><p className="field-hint">{project?t('只移除项目配置。工作目录、历史对话、工作区资料和共享 Agent 均保留。'):t('删除此智能体的配置，并从所有关联项目中移除。历史对话、任务记录、资料和工作目录保留。')}</p><div className="object-inline-actions"><Button onClick={()=>setDialog(null)}>{t('取消')}</Button><Button className="danger" disabled={navLocked} onClick={()=>{onDelete();setDialog(null);}}>{project?t('删除项目'):t('删除智能体')}</Button></div></>}
  </Dialog>}
 </>;
}

export function ObjectAssociations({kind, id, config, disabled, pending, onChange, onNavigate, onStartChat}: {
 kind:'project'|'agent';id:string;config:Config;disabled:boolean;pending:boolean;onChange:(update:(config:Config)=>Config)=>void;onNavigate:(path:string)=>void;onStartChat?:(id:string)=>void;
}) {
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en),project=kind==='project';
 const [query,setQuery]=useState(''),[open,setOpen]=useState(false);
 const linked=(other:string)=>project?!!config.projects.find(p=>p.id===id)?.agentIds.includes(other):!!config.projects.find(p=>p.id===other)?.agentIds.includes(id);
 const items=project?config.agents.filter(agent=>!agent.systemRole&&!agent.temporary):config.projects,related=items.filter(item=>linked(item.id));
 const toggle=(other:string,checked:boolean)=>onChange(current=>({...current,projects:current.projects.map(p=>{
  if(p.id!==(project?id:other))return p;
  const agentId=project?other:id;
  return {...p,agentIds:checked?[...new Set([...p.agentIds,agentId])]:p.agentIds.filter(value=>value!==agentId)};
 })}));
 const options=items.filter(item=>item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>Number(linked(b.id))-Number(linked(a.id)));
 return <ObjectGroup id="associations" title={project?say('关联智能体','Associated Agents'):say('关联项目','Associated projects')} actions={<Popover open={open} onOpenChange={value=>{setOpen(value);if(value)setQuery('');}}><PopoverTrigger asChild><Button disabled={disabled}><Icon name="plus" size={14}/>{say('添加关联','Add associations')}</Button></PopoverTrigger><PopoverContent className="object-association-popover" align="end" collisionPadding={16}><Input type="search" aria-label={say('搜索关联对象','Search associations')} placeholder={say('搜索名称…','Search names…')} value={query} onChange={event=>setQuery(event.target.value)}/><div className="object-association-options">{options.map(item=><label key={item.id}><Input type="checkbox" aria-label={item.name} disabled={disabled} checked={linked(item.id)} onChange={event=>toggle(item.id,event.target.checked)}/><IdentityAvatar identity={item} kind={project?'agent':'project'} size={20}/><span>{item.name}</span></label>)}{!options.length&&<p>{say('没有匹配对象','No matching items')}</p>}</div><small role="status">{pending?say('修改尚未保存完成','Changes not saved yet'):say('所有修改已保存','All changes saved')}</small></PopoverContent></Popover>}>
  <div className={project?'project-associated-agents project-agent-rows':'agent-associated-projects'}>{related.map(item=><div key={item.id} className="object-association-row"><IdentityAvatar identity={item} kind={project?'agent':'project'} size={24}/><div className="object-association-copy"><DirectoryLink disabled={disabled||pending} onNavigate={onNavigate} href={project?'/agents/'+encodeURIComponent(item.id)+'?'+new URLSearchParams({project:id,from:'/projects/'+encodeURIComponent(id)+'/overview#associations'}):'/projects/'+encodeURIComponent(item.id)+'/overview?'+new URLSearchParams({from:'/agents/'+encodeURIComponent(id)+'#associations'})}>{item.name}</DirectoryLink>{project&&<small>{firstSentence((item as Agent).instructions)||say('尚未填写职责','No role set')}</small>}</div>{project&&onStartChat&&<Button className="ghost" disabled={disabled||pending} onClick={()=>onStartChat(item.id)}><Icon name="message" size={14}/>{say('开始对话','Start chat')}</Button>}<DropdownMenu><DropdownMenuTrigger asChild><Button className="icon-button" disabled={disabled} aria-label={say('关联操作：','Association actions: ')+item.name}><Icon name="more" size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>toggle(item.id,false)}>{say('解除关联','Remove association')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>)}{!related.length&&<p className="object-empty">{say('添加关联，便于在这里协作。','Add an association to collaborate here.')}</p>}</div>
 </ObjectGroup>;
}
