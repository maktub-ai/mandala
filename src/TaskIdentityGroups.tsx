import type {ReactNode} from 'react';
import type {Task} from '../shared/tasks';
import type {Config} from '../shared/types';
import {taskProjectIds} from './object-scope';
import {BlueprintGroupSummary} from './ProjectBlueprint';
import IdentityAvatar from './IdentityAvatar';
import Icon from './ui/Icon';
import {useLanguage} from './i18n';
import './mandala-panels.css';

export type TaskGrouping='agent'|'project';
export function groupTasksByIdentity(tasks:readonly Task[],mode:TaskGrouping) {
 const groups=new Map<string|null,Task[]>(),seen=new Set<string>();
 for(const task of tasks){
  if(seen.has(task.id))continue;
  seen.add(task.id);
  const ids=mode==='agent'?[task.assigneeAgentId]:taskProjectIds(task);
  for(const id of new Set(ids.length?ids:[null])){
   const group=groups.get(id);
   if(group)group.push(task);
   else groups.set(id,[task]);
  }
 }
 const unassigned=groups.get(null);
 if(unassigned){
  groups.delete(null);
  groups.set(null,unassigned);
 }
 return groups;
}

export default function TaskIdentityGroups({tasks,grouping,config,onOpen,children,className='',showBlueprint=true}:{
 tasks:readonly Task[]; grouping:TaskGrouping; config:Config; onOpen:(path:string)=>void;
 children:(members:Task[])=>ReactNode; className?:string; showBlueprint?:boolean;
}) {
 const {text:say}=useLanguage();
 return <>{[...groupTasksByIdentity(tasks,grouping)].map(([id,members])=>{
  const project=grouping==='project'&&id?config.projects.find(item=>item.id===id):undefined;
  const agent=grouping==='agent'&&id?config.agents.find(item=>item.id===id):undefined;
  const identity=project??agent;
  const fallback=grouping==='project'
   ? (id?say('项目已移除','Project removed'):say('无项目','No project'))
   : (id?say('Agent 已移除','Agent removed'):say('未分配 Agent','Unassigned Agent'));
  const name=identity?.name??fallback;
  const path=project?'/projects/'+encodeURIComponent(project.id)+'/overview':null;
  return <section key={JSON.stringify([grouping,id])} className={'mandala-task-group '+className} aria-label={name}>
   <header><h2>{identity?<IdentityAvatar identity={identity} kind={grouping} size={18}/>:<Icon name={grouping} size={16}/>}<span>{name}</span></h2>
    {path&&<a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onOpen(path);}}}>{say('打开项目','Open project')}<Icon name="arrowRight" size={13}/></a>}
   </header>
   {showBlueprint&&project&&(project.blueprintEnabled??config.blueprintDefaultEnabled)&&<BlueprintGroupSummary projectId={project.id}/>}
   {children(members)}
  </section>;
 })}</>;
}
