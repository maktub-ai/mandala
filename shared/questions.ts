import type { Approval } from './types';
export type NativeQuestion={id:string;header:string;question:string;isSecret?:boolean;options?:{label:string;description:string}[]|null};
export function nativeQuestions(approval:Approval):NativeQuestion[] {
 if(approval.method!=='item/tool/requestUserInput')return [];
 const questions=(approval.params as {questions?:unknown})?.questions;
 if(!Array.isArray(questions)||!questions.length||questions.length>10)return [];
 const valid=questions.every(q=>q&&typeof q.id==='string'&&q.id.length>0&&typeof q.header==='string'&&typeof q.question==='string'&&
  (q.options==null||Array.isArray(q.options)&&q.options.every((o:any)=>o&&typeof o.label==='string'&&typeof o.description==='string')));
 return valid&&new Set(questions.map(q=>q.id)).size===questions.length?questions:[];
}
export function questionResponse(approval:Approval, answers:unknown) {
 const questions=nativeQuestions(approval);
 if(!questions.length||!answers||typeof answers!=='object'||Array.isArray(answers))throw new Error('invalid question answers');
 const values=answers as Record<string,{answers?:unknown}>;
 if(Object.keys(values).length!==questions.length||questions.some(q=>!Object.hasOwn(values,q.id)))throw new Error('invalid question answers');
 const result=Object.create(null) as Record<string,{answers:string[]}>;
 for(const q of questions) {
  const value=values[q.id]?.answers;
  if(!Array.isArray(value)||value.length!==1||typeof value[0]!=='string'||!value[0].trim()||value[0].length>20000)throw new Error('invalid question answers');
  result[q.id]={answers:[value[0]]};
 }
 return {answers:result};
}

export function hasBlockingApprovals(approvals:Iterable<Approval>) {
 return [...approvals].some(a=>a.method!=="item/tool/requestUserInput"||(a.params as {isBlocking?:boolean})?.isBlocking!==false);
}
