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

export function firstBlockingApproval(approvals:Iterable<Approval>) {
 return [...approvals].find(a=>a.method!=="item/tool/requestUserInput"||(a.params as {isBlocking?:boolean})?.isBlocking!==false);
}

export function hasBlockingApprovals(approvals:Iterable<Approval>) {
 return Boolean(firstBlockingApproval(approvals));
}

export type QuestionAnswer = { question: string; answer: string };

// Only an authenticated form receipt can unmask the public questions it names.
// Historic receipts without this projection may belong to a different page.
export function presentSubmittedQuestions(text:string,publicItems:unknown) {
 const start='<send_user_message_question_reply>',end='</send_user_message_question_reply>';
 if(!text.startsWith(start))return;
 const masked={text:'••••••',questionAnswers:[] as QuestionAnswer[]};
 if(!text.endsWith(end))return masked;
 const allowed=new Set(Array.isArray(publicItems)?publicItems:[]);
 try{
  const items:unknown=JSON.parse(text.slice(start.length,-end.length));
  if(!Array.isArray(items)||!items.length||items.length>10)return masked;
  const questionAnswers:QuestionAnswer[]=[];
  for(const item of items){
   if(!item||typeof item.questionItemId!=='string'||typeof item.question!=='string'||typeof item.answer!=='string')return masked;
   questionAnswers.push({question:item.question,answer:allowed.has(item.questionItemId)?item.answer:'••••••'});
  }
  return {questionAnswers,text:questionAnswers.map(pair=>pair.question+'\n'+pair.answer).join('\n\n')};
 }catch{return masked;}
}

export function questionReplyPresenter(events:import('./types').DisplayEvent[]){
 const submitted=new Map<string,unknown>();
 for(const event of events){
  if(event.kind!=='metadata')continue;
  const {answeredQuestionId,queuedInputId,publicQuestionItems}=event.data as {answeredQuestionId?:string;queuedInputId?:string;publicQuestionItems?:unknown};
  if(typeof answeredQuestionId==='string'&&answeredQuestionId.startsWith('async:')&&queuedInputId)submitted.set(queuedInputId,publicQuestionItems);
 }
 return (inputId:string|undefined,text:string)=>inputId&&submitted.has(inputId)?presentSubmittedQuestions(text,submitted.get(inputId)):undefined;
}
