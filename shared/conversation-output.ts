import {groupChatTurns,type ChatTurn} from './chat-turns';
import type {LatestProgress,ProgressStep} from './conversation-progress';

/** Public assistant text only; unphased output is not a final answer until normal end. */
export function presentTurnText(turn:ChatTurn,status:string){
 const events=turn.events.filter(event=>event.kind!=='text'||(event.data as {phase?:string}).phase!=='analysis');
 const messages=events.length===turn.events.length?turn.messages:groupChatTurns(events).flatMap(turn=>turn.messages);
 const items=new Map<string,{phase?:string;stopReason?:string}>();
 const observedText=new Map<string,string>();
 for(const event of events){
  const data=event.data as {text?:string;itemId?:string;method?:string;params?:{item?:{id:string;type:string;phase?:string;stopReason?:string;text?:string}}};
  if(event.kind==='text'&&data.itemId)observedText.set(data.itemId,(observedText.get(data.itemId)??'')+(data.text??''));
  const item=data.params?.item;
  if(event.kind==='tool'&&item?.type==='agentMessage'){
   items.set(item.id,{...items.get(item.id),...item});
   if(data.method==='item/completed'&&typeof item.text==='string')observedText.set(item.id,item.text);
  }
 }
 const text=messages.filter(message=>message.kind==='text'&&message.text.length>0&&items.get(message.item??'')?.phase!=='analysis'),last=text.at(-1);
 const incomplete=['error','interrupted'].includes(status)||['length','aborted','error'].includes(items.get(last?.item??'')?.stopReason??'');
 const explicit=text.filter(message=>['final_answer','partial_answer'].includes(items.get(message.item??'')?.phase??''));
 const selected=incomplete?[]:explicit.length?explicit:status==='idle'&&last&&items.get(last.item??'')?.phase!=='commentary'&&items.get(last.item??'')?.stopReason!=='toolUse'?[last]:[];
 const answerItems=new Set(selected.flatMap(message=>message.item?[message.item]:[]));
 const unique=(messages:typeof text)=>{
  const byKey=new Map<string|number,(typeof text)[number]>();
  for(const message of messages){
   const key=message.item??message.key;
   if(!byKey.has(key))byKey.set(key,{...message,text:observedText.get(message.item??'')??message.text});
  }
  return [...byKey.values()];
 };
 const answers=unique(selected);
 const progress=unique(text.filter(message=>!selected.includes(message)&&!(message.item&&answerItems.has(message.item))&&!(/^[.⋯…\s]+$/.test(message.text)&&items.get(message.item??'')?.phase!=='final_answer')));
 const output=progress.filter(message=>items.get(message.item??'')?.phase!=='commentary');
 const byItem=new Map(progress.filter(message=>message.item).map(message=>[message.item!,message]));
 const byEvent=new Map(progress.map(message=>[message.key,message]));
 const runId=(events.find(event=>(event.data as {runId?:string}).runId)?.data as {runId?:string}|undefined)?.runId??'';
 const historical=!['running','approval'].includes(status);
 let latestProgress:LatestProgress|null=null;
 for(const event of events){
  const data=event.data as {text?:string;itemId?:string;runId?:string;steps?:ProgressStep[];params?:{item?:{id:string;type:string}};method?:string};
  if(event.kind==='progress'&&data.text)latestProgress={text:data.text,source:'cli',runId:data.runId??runId,sourceEventId:event.id,updatedAt:event.createdAt,historical,...(data.steps?{steps:data.steps}:{})};
  const message=event.kind==='text'?(data.itemId?byItem.get(data.itemId):byEvent.get(event.id)):event.kind==='tool'&&data.method==='item/completed'&&data.params?.item?.type==='agentMessage'?byItem.get(data.params.item.id):undefined;
  if(message)latestProgress={text:observedText.get(message.item??'')??message.text,source:output.includes(message)?'output':'commentary',runId:data.runId??runId,sourceEventId:event.id,updatedAt:event.createdAt,historical};
 }
 return {answers,progress,output,incomplete,latestProgress};
}
