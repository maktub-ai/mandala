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

const safeOptionLabel = (label:unknown):label is string =>
 typeof label==='string'&&!!label.trim()&&label.length<=160&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label);

// Persist display evidence from the authoritative request, never a raw answer.
export function projectQuestionAnswer(approval:Approval,response:ReturnType<typeof questionResponse>) {
 const selectedOptions=nativeQuestions(approval).flatMap(question=>{
  if(question.isSecret!==undefined&&question.isSecret!==false)return [];
  const value=response.answers[question.id]?.answers[0];
  const matches=question.options?.filter(option=>option.label===value);
  return matches?.length===1&&safeOptionLabel(matches[0].label)?[matches[0].label]:[];
 });
 return {version:1 as const,selectedOptions};
}

export function readQuestionAnswerDisplay(data:unknown) {
 if(!data||typeof data!=='object')return null;
 const {answeredQuestionId, questionAnswerDisplay}=data as {answeredQuestionId?:unknown;questionAnswerDisplay?:{version?:unknown;selectedOptions?:unknown}};
 if(typeof answeredQuestionId!=='string'||!answeredQuestionId||answeredQuestionId.length>200||questionAnswerDisplay?.version!==1)return null;
 const options=questionAnswerDisplay.selectedOptions;
 return Array.isArray(options)&&options.length<=10&&options.every(safeOptionLabel)?{id:answeredQuestionId,options}:null;
}

export function hasBlockingApprovals(approvals:Iterable<Approval>) {
 return [...approvals].some(a=>a.method!=="item/tool/requestUserInput"||(a.params as {isBlocking?:boolean})?.isBlocking!==false);
}
