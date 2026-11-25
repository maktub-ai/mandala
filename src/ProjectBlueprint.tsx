import {taskProjectIds} from './object-scope';
import {useEffect,useRef,useState} from 'react';
import type {BlueprintModule,BlueprintRecord,BlueprintState} from '../shared/blueprint';
import type {Task} from '../shared/tasks';
import {useLanguage} from './i18n';
import {ObjectGroup} from './ObjectExperience';
import {DirectoryLink} from './SettingsObjectBrowser';
import Button from './ui/Button';
import Disclosure from './ui/Disclosure';
import Icon from './ui/Icon';
import StatusMark,{statusShape} from './ui/StatusMark';
import useSummaryResource from './useSummaryResource';
import './project-blueprint.css';

export const blueprintPath=(id:string)=>'/projects/'+encodeURIComponent(id)+'/blueprint';
/** The page for a project's blueprint tab (the API lives at '/api' + blueprintPath). */
export const blueprintPagePath=(id:string,query?:Record<string,string>)=>blueprintPath(id)+(query&&Object.keys(query).length?'?'+new URLSearchParams(query):'');

function ModuleStatus({status}:{status:BlueprintModule['status']}){
 const {text}=useLanguage();
 const label={planned:text('待开始','Planned'),active:text('进行中','Active'),done:text('已完成','Done')}[status];
 return <span className="blueprint-status" data-status={status}><StatusMark shape={status==='planned'?'ring':status==='active'?'play':'check'}/>{label}</span>;
}

export function BlueprintGroupSummary({projectId}:{projectId:string}){
 const {text}=useLanguage();
 const {data,error}=useSummaryResource<BlueprintState>('/api'+blueprintPath(projectId),projectId,0);
 if(!data?.summary)return <small className="blueprint-group-summary">{error||data?.status==='unavailable'?text('蓝图暂不可用','Blueprint unavailable'):data?text('蓝图待设置','Blueprint setup pending'):text('正在读取蓝图…','Loading blueprint…')}</small>;
 const modules=data.summary.modules;
 return <div className="blueprint-group-summary" aria-label={text('模块状态摘要','Module status summary')}>{modules.slice(0,3).map(m=><span key={m.lane}>{m.lane}<ModuleStatus status={m.status}/></span>)}{modules.length>3&&<small>{text(`另有 ${modules.length-3} 个模块`,`${modules.length-3} more modules`)}</small>}{!modules.length&&text('暂无模块','No modules yet')}</div>;
}

function Records({records,selected}:{records:BlueprintRecord[];selected:string|null}){
 const {text,language}=useLanguage();
 const ordered=[...records].sort((a,b)=>b.at.localeCompare(a.at));
 return <>{ordered.filter((r,i)=>i<3||r.id===selected).map(r=><Disclosure className="blueprint-record" key={r.id} data-record={r.id} open={r.id===selected||undefined} title={<><Icon name="book" size={15}/><span>{r.title}</span>{r.at&&<time dateTime={r.at}>{Number.isNaN(Date.parse(r.at))?r.at:new Date(r.at).toLocaleDateString(language,{month:'short',day:'numeric'})}</time>}</>}>
  {r.result&&<p>{r.result}</p>}{r.decisions.length>0&&<div><strong>{text('决策','Decisions')}</strong><ul>{r.decisions.map((decision,index)=><li key={index}>{decision}</li>)}</ul></div>}
 </Disclosure>)}</>;
}

export function ProjectBlueprint({projectId,tasks,tasksError,disabled,onNavigate}:{projectId:string;tasks:Task[]|null;tasksError:boolean;disabled:boolean;onNavigate:(path:string)=>void}){
 const {text}=useLanguage(),[revision,setRevision]=useState(0),box=useRef<HTMLDivElement>(null);
 const {data,error}=useSummaryResource<BlueprintState>('/api'+blueprintPath(projectId),projectId,revision);
 const summary=data?.summary,query=new URLSearchParams(location.search),lane=query.get('lane'),record=query.get('record');
 const found=Boolean(summary&&(record?summary.records.some(r=>r.id===record)||summary.modules.some(m=>m.records.some(r=>r.id===record)):summary.modules.some(m=>m.lane===lane)));
 useEffect(()=>{
  if(!found)return;
  const records=Array.from(box.current?.querySelectorAll<HTMLElement>('[data-record]')??[]).filter(el=>el.dataset.record===record);
  const target=record?(records.find(el=>el.closest<HTMLElement>('[data-lane]')?.dataset.lane===lane)??records[0]):
   Array.from(box.current?.querySelectorAll<HTMLElement>('[data-lane]')??[]).find(el=>el.dataset.lane===lane);
  const frame=requestAnimationFrame(()=>{if(target){target.scrollIntoView({block:'nearest'});(record?target.querySelector<HTMLElement>('summary')??target:target).focus({preventScroll:true});}});
  return ()=>cancelAnimationFrame(frame);
 },[projectId,lane,record,found]);
 const settings='/projects/'+encodeURIComponent(projectId)+'/settings#blueprint';
 const general=summary?.records.filter(r=>!r.lanes.some(value=>summary.modules.some(m=>m.lane===value)))??[];
 return <ObjectGroup title={text('项目蓝图','Project blueprint')} actions={(error||data?.status==='unavailable')&&<Button onClick={()=>setRevision(v=>v+1)}>{text('重试','Retry')}</Button>}>
  <div className="blueprint-board" ref={box}>
   {!summary?<div className="object-empty" role="status">{error||data?.status==='unavailable'?text('暂时无法读取蓝图。','Blueprint is unavailable.'):!data?text('正在读取蓝图…','Loading blueprint…'):text('请完成项目蓝图设置。','Finish setting up this project’s blueprint.')} {data&&<DirectoryLink href={settings} disabled={disabled} onNavigate={onNavigate}>{text('蓝图设置','Blueprint settings')}</DirectoryLink>}</div>:<>
    {(lane||record)&&!found&&<p className="object-empty" role="status">{text('此模块或记录已不在蓝图中。','This module or record is no longer in the blueprint.')}</p>}
    {tasksError&&<p className="object-empty" role="status">{text('暂时无法读取模块任务。','Module tasks are unavailable.')}</p>}
    {summary.modules.map(m=>{
     const work=tasks?.filter(t=>t.moduleRef?.projectId===projectId&&t.moduleRef.lane===m.lane&&!['completed','cancelled'].includes(t.state));
     return <section key={m.lane} className="blueprint-lane" data-lane={m.lane} tabIndex={-1} aria-label={m.lane} data-target={lane===m.lane||undefined}>
      <header><h3>{m.lane}</h3><ModuleStatus status={m.status}/></header><div className="blueprint-lane-items">
       {work?.map(task=><DirectoryLink key={task.id} disabled={disabled} onNavigate={onNavigate} href={'/tasks/'+encodeURIComponent(task.id)+'?'+new URLSearchParams({project:projectId})} className="blueprint-task" data-state={task.state}><StatusMark shape={statusShape(task.state)}/><span>{task.goal.split('\n')[0]}</span><Icon name="arrowRight" size={14}/></DirectoryLink>)}
       <Records records={m.records} selected={record}/>{!m.records.length&&work?.length===0&&<small>{text('暂无任务或记录','No tasks or records yet')}</small>}
      </div>
     </section>;
    })}
    {!!general.length&&<section className="blueprint-lane" aria-label={text('项目记录','Project records')}><header><h3>{text('项目记录','Project records')}</h3></header><div className="blueprint-lane-items"><Records records={general} selected={record}/></div></section>}
    {!summary.modules.length&&!general.length&&<p className="object-empty">{text('蓝图暂无模块或记录。','No modules or records yet.')}</p>}
   </>}
  </div>
 </ObjectGroup>;
}

/** The blueprint tab: the plan's modules, each with the project's Tasks that work on it. */
export function ProjectBlueprintPage({projectId,disabled,onNavigate}:{projectId:string;disabled:boolean;onNavigate:(path:string)=>void}){
 const tasks=useSummaryResource<Task[]>('/api/v2/tasks','project:'+projectId,0);
 const associated=tasks.data?tasks.data.filter(task=>taskProjectIds(task).includes(projectId)):null;
 return <ProjectBlueprint projectId={projectId} tasks={associated} tasksError={tasks.error} disabled={disabled} onNavigate={onNavigate}/>;
}
