import type {OperationOutcome} from '../shared/operation-results';

const commands=new Set(['mandala_create','mandala_takeover','mandala_delegate','mandala_temporary','task_create','task_update','task_assign','task_start','task_stop','task_cancel','task_review','task_accept','task_reopen','task_request_changes','task_mark_completed','task_execution_add','task_execution_remove','automation_create','automation_update','automation_remove','automation_run','automation_stop','artifact_publish','artifact_update','wiki_create','wiki_edit','wiki_configure','wiki_add_source','wiki_remove_source','wiki_refresh','wiki_restore','skill_register','skill_update','skill_accept','skill_reject','mandala_discover_work','mandala_discover_capabilities']);
export function hasOperationOutcome(command:string){return commands.has(command);}

// Only named public outcome fields are projected. Never persist tool bodies, credentials or prompts.
export function projectOperationOutcome(command:string,args:Record<string,unknown>,value:unknown):OperationOutcome|undefined{
 if(!hasOperationOutcome(command))return;
 const result=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 const text=(value:unknown)=>typeof value==='string'?value.split('\n')[0].slice(0,160):'';
 const facts:Record<string,string>={};
 if(result.unchanged===true)facts.unchanged='true';
 if(command==='automation_stop'&&Array.isArray(value)&&value.length===0)facts.unchanged='true';
 if(command.startsWith('automation_')){
  if(typeof result.enabled==='boolean')facts.enabled=String(result.enabled);
  const schedule=result.schedule as Record<string,unknown>|undefined;
  if(schedule){if(typeof schedule.time==='string')facts.schedule=schedule.time;if(typeof schedule.timeZone==='string')facts.timeZone=schedule.timeZone;if(typeof schedule.kind==='string')facts.scheduleKind=schedule.kind;if(Array.isArray(schedule.weekdays))facts.weekdays=schedule.weekdays.join(',');else if(typeof schedule.weekday==='number')facts.weekdays=String(schedule.weekday);if(typeof schedule.minutes==='number')facts.minutes=String(schedule.minutes);if(typeof schedule.at==='string')facts.scheduledAt=schedule.at;}
  if(result.enabled===true&&typeof result.nextRunAt==='string')facts.nextRunAt=result.nextRunAt;
  if(typeof result.status==='string')facts.runState=result.status;
  const ruleId=result.automationId??args.automationId??result.id;
  return {kind:'automation',name:text(result.name??args.name),facts,path:'/schedules'+(command!=='automation_remove'&&ruleId?'?schedule='+encodeURIComponent(String(ruleId)):'')};
 }
 if(command==='mandala_discover_work'||command==='mandala_discover_capabilities'){
  if(typeof result.truncated==='boolean')facts.truncated=String(result.truncated);
  const sources=Array.isArray(result.sources)?result.sources as Record<string,unknown>[]:[];
  if(sources.some(source=>source.truncated===true)||Array.isArray(result.notices)&&result.notices.some(notice=>typeof notice==='string'&&notice.startsWith('candidate_limit')))facts.truncated='true';
  if(sources.some(source=>['missing','unsupported','unavailable'].includes(String(source.status))))facts.unavailableSources=String(sources.filter(source=>['missing','unsupported','unavailable'].includes(String(source.status))).length);
  if(sources.length)facts.sources=sources.slice(0,12).map(source=>text(source.runtime??source.scope)+': '+text(source.status)).join(' · ');
  for(const key of ['candidates','directories','skills','connections','items'])if(Array.isArray(result[key]))facts[key]=String(result[key].length);
  return {kind:'discovery',name:'',facts};
 }
 if(command==='mandala_temporary')return {kind:'agent',name:text(result.name),facts,path:result.id?'/agents?agent='+encodeURIComponent(String(result.id)):undefined};
 if(command.startsWith('task_')||command.startsWith('mandala_')){
  if(typeof result.state==='string')facts[result.taskId?'runState':'taskState']=result.state;
  const id=result.taskId??result.id??args.taskId;
  return {kind:'task',name:text(result.goal??args.goal??args.request),facts,path:id?'/tasks/'+encodeURIComponent(String(id)):undefined};
 }
 const skill=result.skill as Record<string,unknown>|undefined,suggestion=result.suggestion as Record<string,unknown>|undefined;
 const version=(result.versionRef??skill?.versionRef) as Record<string,unknown>|undefined;
 if(typeof (result.versionId??result.headVersionId??version?.versionId)==='string')facts.version=String(result.versionId??result.headVersionId??version?.versionId);
 if(suggestion?.status==='pending')facts.workState='pending';
 const job=result.lastJob as Record<string,unknown>|undefined;
 if(['wiki_restore','wiki_refresh'].includes(command)&&typeof job?.state==='string')facts.workState=job.state;
 if(command.startsWith('wiki_')){const baseId=result.baseId??args.baseId??result.id;return {kind:'content',name:text(result.name??args.name),facts,path:baseId?'/library/'+encodeURIComponent(String(baseId)):'/library'};}
 const assetId=result.assetId??version?.assetId;
 const skillId=skill?.id??suggestion?.skillId??args.skillId??result.id;
 return {kind:'content',name:text(result.title??result.name??skill?.name??args.title??args.name),facts,path:command.startsWith('skill_')?'/settings/skills'+(skillId?'?skill='+encodeURIComponent(String(skillId)):''):assetId?'/library/'+encodeURIComponent(String(assetId)):'/library'};
}
