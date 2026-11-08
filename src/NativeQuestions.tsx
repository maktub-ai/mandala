import Input from './ui/Input';
import Button from './ui/Button';
import { useState } from 'react';
import type { Approval } from '../shared/types';
import { nativeQuestions } from '../shared/questions';
import { useLanguage } from './i18n';
export default function NativeQuestions({approval,pending,onSubmit}:{approval:Approval;pending:boolean;onSubmit:(answers:Record<string,{answers:string[]}>)=>void}) {
 const {t}=useLanguage(),questions=nativeQuestions(approval),[answers,setAnswers]=useState<Record<string,string>>(()=>Object.create(null));
 return <form className="native-questions" onSubmit={e=>{e.preventDefault();onSubmit(Object.fromEntries(questions.map(q=>[q.id,{answers:[answers[q.id]]}])));}}>
  <div className="approval-heading">{t('需要你的回答')}</div>
  {questions.map(q=><fieldset key={q.id} disabled={pending}>
   <legend>{q.question}</legend>
   {q.options?.map((option,index)=><label className="question-option" key={index}>
    <Input type="radio" name={approval.id+q.id} checked={answers[q.id]===option.label} onChange={()=>setAnswers(values=>Object.assign(Object.create(null),values,{[q.id]:option.label}))}/>
    <span>{option.label}<small>{option.description}</small></span>
   </label>)}
   <label className="question-custom">{t(q.options?.length?'补充或自定义回答':'你的回答')}
    <Input type={q.isSecret?'password':'text'} value={answers[q.id]??''} autoComplete="off" onChange={e=>setAnswers(values=>Object.assign(Object.create(null),values,{[q.id]:e.target.value}))}/>
   </label>
  </fieldset>)}
  <Button type="submit" disabled={pending||!questions.length||questions.some(q=>!answers[q.id]?.trim())}>{t(pending?'提交中…':'提交回答')}</Button>
 </form>;
}
