import {createTaskWithExecutions} from '../helpers/task-executions';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import type {Store} from '../../server/store';
import type {SessionManager} from '../../server/sessions';
import type {CodexOptions} from '../../server/codex';

export async function liveOutputFixture(req:IncomingMessage,res:ServerResponse,store:Store,manager:SessionManager,native:Map<string,CodexOptions>){
 if(req.method!=='POST'||!['/__test__/live-output-fixture','/__test__/live-output-update'].includes(req.url??''))return false;
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body||'{}') as {id?:string;tagged?:boolean;stage?:string};
 const chat=input.id?store.getConversation(input.id)!:await manager.create('activity','inspector');
 if(!input.id){store.renameConversation(chat.id,'最新过程说明同步实验');await manager.send(chat.id,'activity-flow');}
 const current=store.getConversation(chat.id)!,options=native.get(current.nativeId!)!;
 const emit=(method:string,params:Record<string,unknown>)=>options.onEvent({method,params:{threadId:current.nativeId,turnId:current.turnId,...params}});
 if(!input.id){
  emit('item/started',{item:{id:'live-comment',type:'agentMessage',text:'',...(input.tagged?{phase:'commentary'}:{})}});
  emit('item/agentMessage/delta',{itemId:'live-comment',delta:'正在核对明细'});
 }else if(input.stage==='chunk')emit('item/agentMessage/delta',{itemId:'live-comment',delta:'，并检查汇总差异'});
 else if(input.stage==='spawn-child'||input.stage==='child-result'){
  const done=input.stage==='child-result';
  emit('item/completed',{item:{id:input.stage,type:'collabAgentToolCall',tool:done?'wait':'spawnAgent',status:'completed',senderThreadId:current.nativeId,receiverThreadIds:['child-docs'],prompt:'核对发布说明',agentsStates:{'child-docs':{status:done?'completed':'running',message:done?'升级步骤已经核对。':'正在核对升级步骤。'}}}});
 } else if(input.stage==='another-child'){
  emit('item/completed',{item:{id:'second-spawn',type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',senderThreadId:current.nativeId,receiverThreadIds:['child-links'],prompt:'检查文档链接',agentsStates:{'child-links':{status:'running',message:'正在核对新增链接。'}}}});
 } else if(input.stage==='answer'){
  emit('item/completed',{item:{id:'live-comment',type:'agentMessage',text:'正在核对明细，并检查汇总差异',...(input.tagged?{phase:'commentary'}:{})}});
  emit('item/completed',{item:{id:'read',type:'mcpToolCall',server:'OMP',tool:'read',status:'completed',arguments:{path:'fixture.json'},result:'Synthetic fixture'}});
  emit('item/started',{item:{id:'live-answer',type:'agentMessage',text:'',...(input.tagged?{phase:'final_answer'}:{})}});
  emit('item/agentMessage/delta',{itemId:'live-answer',delta:'核对完成，真实合计为 885。'});
 }else if(input.stage==='done')emit('turn/completed',{turn:{id:current.turnId,status:'completed'}});
 const task=input.id?undefined:createTaskWithExecutions(store,manager.taskService,{userId:store.ownerUserId},{goal:'核对最新过程同步',projectId:'activity'},[chat.id],randomUUID());
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:chat.id,task:task?.id}));return true;
}
