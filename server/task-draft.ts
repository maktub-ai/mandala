import type { Schedule } from '../shared/automations';
import type { Criterion } from '../shared/tasks';
import { DomainError } from '../shared/workspace-contracts';
import { nextScheduledTime } from './automations';
export type TaskDraft = {goal:string;criteria:Criterion[];schedule:Schedule|null;timeZone:string;unresolved:string[]};
export type TaskDraftGenerator = (description:string,timeZone:string)=>Promise<unknown>;
// Suggestions are untrusted and never save or dispatch work. Explicit form fields win.
export async function draftTask(value:unknown,generate?:TaskDraftGenerator):Promise<TaskDraft> {
 const bad=():never=>{throw new DomainError('invalid_task_draft',422,'Invalid task draft');};
 if(!value||typeof value!=='object'||Array.isArray(value))return bad();
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['description','timeZone','fields'].includes(k))||typeof input.description!=='string'||!input.description.trim()||input.description.length>50000)return bad();
 const timeZone=typeof input.timeZone==='string'?input.timeZone:'UTC';try{new Intl.DateTimeFormat('en',{timeZone});}catch{return bad();}
 const validGoal=(goal:unknown):goal is string=>typeof goal==='string'&&Boolean(goal.trim())&&goal.length<=50000;
 const validCriteria=(criteria:unknown):criteria is Criterion[]=>Array.isArray(criteria)&&criteria.every(c=>c&&typeof c.id==='string'&&Boolean(c.id.trim())&&typeof c.text==='string'&&Boolean(c.text.trim())&&(c.checkRef===null||typeof c.checkRef==='string'&&Boolean(c.checkRef.trim())))&&new Set(criteria.map(c=>c.id)).size===criteria.length;
 const explicit=(input.fields??{}) as Record<string,unknown>;
 if(!explicit||typeof explicit!=='object'||Array.isArray(explicit)||Object.keys(explicit).some(k=>!['goal','criteria','schedule'].includes(k)))return bad();
 if(Object.hasOwn(explicit,'goal')&&!validGoal(explicit.goal)||Object.hasOwn(explicit,'criteria')&&!validCriteria(explicit.criteria))return bad();
 let suggested:Record<string,unknown>={},unresolved:string[]=[];
 if(generate)try{const result=await generate(input.description,timeZone);if(result&&typeof result==='object'&&!Array.isArray(result))suggested=result as Record<string,unknown>;else unresolved.push('识别结果格式无效，已保留原始需求');}catch(error){unresolved.push(error instanceof DomainError&&error.code==='system_runtime_required'?'请先在设置中选择可用的系统任务执行端，或直接手动填写。':'识别暂不可用，可直接保存或手动填写');}
 const text=input.description.trim(),daily=text.match(/(?:每天|每日|daily).*?(\d{1,2})[:：](\d{2})/i),weekly=text.match(/(?:每周|weekly).*?(?:周|星期)([日一二三四五六]).*?(\d{1,2})[:：](\d{2})/i),once=text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/);
 let schedule:unknown=weekly?{kind:'weekly',weekday:'日一二三四五六'.indexOf(weekly[1]),time:`${weekly[2].padStart(2,'0')}:${weekly[3]}`,timeZone}:daily?{kind:'daily',time:`${daily[1].padStart(2,'0')}:${daily[2]}`,timeZone}:once?{kind:'once',at:once[0]}:null;
 // Model suggestions need an explicit clock time in the request, plus a validated zoned schedule.
 const explicitTime=/(?:\d{1,2}[:：]\d{2}|[0-9一二三四五六七八九十两]{1,3}\s*(?:点|時|时)|\d{1,2}\s*(?:am|pm)\b)/i.test(text);
 if(schedule===null&&explicitTime&&suggested.scheduleConfirmed!==false&&suggested.schedule!==undefined)schedule=suggested.schedule;
 if(schedule===null&&/(每天|每日|每周|明天|下周|定时|daily|weekly|tomorrow)/i.test(text))unresolved.push('请确认具体日期、时间和时区');
 if(Object.hasOwn(explicit,'schedule'))schedule=explicit.schedule;
 if(schedule!==null)try{nextScheduledTime(schedule as Schedule,new Date());}catch{if(Object.hasOwn(explicit,'schedule'))return bad();schedule=null;unresolved.push('请确认执行时间');}
 const malformed=Object.hasOwn(suggested,'goal')&&!validGoal(suggested.goal)||Object.hasOwn(suggested,'criteria')&&!validCriteria(suggested.criteria);
 if(malformed)unresolved.push('识别结果格式无效，已保留原始需求和空完成标准');
 const goal=explicit.goal??(!malformed?suggested.goal:undefined)??text,criteria=explicit.criteria??(!malformed?suggested.criteria:undefined)??[];
 if(!validGoal(goal)||!validCriteria(criteria))return bad();
 return {goal:goal.trim(),criteria,schedule:schedule as Schedule|null,timeZone,unresolved};
}
