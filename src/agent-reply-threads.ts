import type {ChatMessage,ChatTurn} from '../shared/chat-turns';

type Reply = NonNullable<ChatMessage['agentMessage']>;
/** Which replies Mandala continued in which turn, so the summary owns the reply and the original folds under it. */
export type ReplyThreads = {summaryOf:(messageId:string)=>number|undefined;sourcesOf:(turnKey:number)=>Reply[];hiddenTurn:(turn:ChatTurn)=>boolean};

export function replyThreads(turns:readonly ChatTurn[]):ReplyThreads{
 const replies=new Map<string,Reply>(),summaries=new Map<string,number>(),continued=new Map<number,string[]>();
 for(const turn of turns){
  for(const message of turn.messages)if(message.kind==='agent_message'&&message.agentMessage?.direction==='reply')replies.set(message.agentMessage.id,message.agentMessage);
  for(const event of turn.events){
   const origin=event.kind==='user'?(event.data as {agentMessage?:{id:string;direction:string;batchIds?:string[]}}).agentMessage:undefined;
   if(origin?.direction!=='reply')continue;
   const ids=origin.batchIds?.length?origin.batchIds:[origin.id];
   continued.set(turn.key,ids);for(const id of ids)summaries.set(id,turn.key);
  }
 }
 return {
  summaryOf:id=>replies.has(id)?summaries.get(id):undefined,
  sourcesOf:key=>(continued.get(key)??[]).flatMap(id=>{const reply=replies.get(id);return reply?.reply?.trim()?[reply]:[];}),
  // A turn that only announced replies now shown under their summaries has nothing left to show.
  hiddenTurn:turn=>turn.messages.length>0&&turn.messages.every(message=>message.kind==='agent_message'&&message.agentMessage?.direction==='reply'&&summaries.has(message.agentMessage.id))
   &&!turn.events.some(event=>['user','text','error','approval'].includes(event.kind)||event.kind==='metadata'&&!(event.data as {agentMessage?:unknown}).agentMessage),
 };
}
