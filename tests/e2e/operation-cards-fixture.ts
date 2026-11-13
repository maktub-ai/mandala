import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../../server/store';
import type {SessionManager} from '../../server/sessions';
import {ensureMandalaConfig,writeConfig} from '../../server/config';
import {ensureMandalaConversation} from '../../server/mandala';
import {projectOperationOutcome} from '../../server/operation-results';
export async function operationCardsFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store,manager:SessionManager){
 if(req.method!=='POST'||!['/__test__/task-operation-cards','/__test__/operation-cards','/__test__/operation-cards-partial','/__test__/operation-card-reply','/__test__/operation-outcomes','/__test__/operation-outcomes-only'].includes(req.url??''))return false;
 if(req.url==='/__test__/task-operation-cards'){
  const current=await ensureMandalaConfig(home),chat=ensureMandalaConversation(store,current.config),invocationId=crypto.randomUUID();
  const source=store.appendEvent(chat.id,'user',{text:'创建测试目标并分派执行任务。',invocationId});
  const goal=await manager.coordination.create({agentId:chat.agentId,conversationId:chat.id,invocationId,humanEventId:source.id},{goal:'验证关联卡片',criteria:[{id:'verify',text:'核对明确来源',checkRef:null}],projectId:null},invocationId);
  const executionChat=store.createConversation({projectId:'',agentId:chat.agentId,cli:'codex',model:null});
  const execution=manager.taskService.createExecution({userId:store.ownerUserId},goal.id,{conversationId:executionChat.id,agentId:chat.agentId,projectId:null,request:'核对明确来源'},invocationId+'-execution');
  const other=manager.taskService.createTask({userId:store.ownerUserId},{goal:'同名但独立的目标'},invocationId+'-other');
  for(const [command,task] of [['mandala_create',goal],['mandala_delegate',{...goal,execution}],['task_create',other]] as const)store.appendEvent(chat.id,'metadata',{operationResult:{...projectOperationOutcome(command,{},task),id:invocationId+'-'+task.id,command,state:'succeeded',sourceEventId:source.id,invocationId,createdAt:source.createdAt}});
  const cancelSource=store.appendEvent(chat.id,'user',{text:'取消独立的测试任务。',invocationId:invocationId+'-cancel'});
  manager.taskService.stopTask({userId:store.ownerUserId},other.id,other.revision,true);
  const cancelled=manager.taskService.getTask({userId:store.ownerUserId},other.id);
  store.appendEvent(chat.id,'metadata',{operationResult:{...projectOperationOutcome('task_cancel',{},cancelled),id:invocationId+'-cancel',command:'task_cancel',state:'succeeded',sourceEventId:cancelSource.id,invocationId:invocationId+'-cancel',createdAt:cancelSource.createdAt}});
  store.appendEvent(chat.id,'status',{status:'idle'});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({goalId:goal.id,executionId:execution.id,otherId:other.id}));return true;
 }
 if(req.url==='/__test__/operation-outcomes'||req.url==='/__test__/operation-outcomes-only'){
  const only=req.url==='/__test__/operation-outcomes-only';
  let body='';for await(const chunk of req)body+=chunk;
  const {answer='已保存账单计划和核对报告。'}=JSON.parse(body||'{}') as {answer?:string};
  const {config}=await ensureMandalaConfig(home),chat=ensureMandalaConversation(store,config),invocationId=crypto.randomUUID();
  const source=store.appendEvent(chat.id,'user',{text:'保存计划与报告，并返回工作发现结果。',invocationId,...(only?{agentMessage:{id:invocationId}}:{})});
  const samples=[{command:'automation_create',output:{id:'sample-rule',name:'账单检查',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}},{command:'artifact_publish',output:{assetId:'sample-asset',title:'核对报告',versionId:'sample-version'}},{command:'mandala_discover_capabilities',output:{items:[{name:'Skill'}],truncated:true}},{command:'wiki_refresh',output:null,state:'unknown'},{command:'task_update',output:{id:'failed-task',goal:'失败任务'},state:'failed'},...['automation_update','task_update','skill_update'].map(command=>({command,output:{id:'unchanged-item',name:'未更改项目',unchanged:true}}))];
  for(const [i,sample] of samples.entries())store.appendEvent(chat.id,'metadata',{runId:invocationId,operationResult:{...projectOperationOutcome(sample.command,{},sample.output),id:invocationId+'-'+i,command:sample.command,state:('state' in sample?sample.state:'succeeded'),sourceEventId:source.id,invocationId,createdAt:source.createdAt}});
  if(only)store.appendEvent(chat.id,'metadata',{runId:invocationId,operationResult:{...projectOperationOutcome('skill_update',{}, {suggestion:{skillId:'pending-skill',status:'pending'}}),id:invocationId+'-skill',command:'skill_update',state:'succeeded',sourceEventId:source.id,invocationId,createdAt:source.createdAt}});
  if(only)await manager.coordination.configure({agentId:chat.agentId,conversationId:chat.id,invocationId,humanEventId:source.id},{kind:'agent',action:'create',values:{id:invocationId+'-pending',name:'等待确认的助手',instructions:'Review',defaultCli:'codex',models:{},mcp:[],skills:[]}},'propose',invocationId+'-pending',()=>{});
  else store.appendEvent(chat.id,'text',{text:answer,phase:'final_answer',runId:invocationId});
  store.appendEvent(chat.id,'status',{status:'idle'});
  const next=only?undefined:store.appendEvent(chat.id,'user',{text:'接着讨论下一件事。',invocationId:invocationId+'-next'});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({sourceEventId:source.id,invocationId,nextEventId:next?.id}));return true;
 }
 if(req.url==='/__test__/operation-card-reply'){
  let body='';for await(const chunk of req)body+=chunk;const {conversationId,message}=JSON.parse(body);
  store.appendEvent(conversationId,'metadata',{agentMessage:{...message,direction:'reply',state:'succeeded',reply:'覆盖清单已返回。',replyState:'parked',autoResumeAllowed:false}});
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return true;
 }
 const current=await ensureMandalaConfig(home),chat=ensureMandalaConversation(store,current.config),prefix=crypto.randomUUID();
 const agents=['Billing Domain','Data Pipeline Dev','Data Ops Quality'].map((name,i)=>({id:prefix+'-'+i,name,instructions:'Synthetic card fixture',defaultCli:'codex' as const,models:{},mcp:[],skills:[]}));
 await writeConfig(home,{...current.config,agents:[...current.config.agents,...agents]},current.revision);
 const source=store.appendEvent(chat.id,'user',{text:'请三位智能体分别核对今日账单，汇总给我。',invocationId:prefix});
 const messages=agents.map((agent,i)=>{const target=store.createConversation({projectId:'',agentId:agent.id,cli:'codex',model:null});return {id:prefix+'-message-'+i,sourceRequestEventId:source.id,sourceConversationId:chat.id,targetConversationId:target.id,sourceAgentId:chat.agentId,targetAgentId:agent.id,text:'核对账单并返回证据。',policy:'notify',state:i===2?'queued':'succeeded',reply:i===2?null:'检查已返回；来源覆盖仍需确认。',replyState:i===2?'pending':'parked',autoResumeAllowed:false};});
 for(const message of messages)store.appendEvent(chat.id,'metadata',{agentMessage:{...message,direction:'sent'}});
 store.appendEvent(chat.id,'status',{status:'idle'});
 const create=store.appendEvent(chat.id,'user',{text:'按已确认方案创建三个资料整理助手。',invocationId:prefix+'-create'});
 for(let i=0;i<3;i++)await manager.coordination.configure({agentId:chat.agentId,conversationId:chat.id,invocationId:prefix+'-create',humanEventId:create.id},{kind:'agent',action:'create',values:{id:prefix+'-helper-'+i,name:'资料整理助手 '+(i+1),instructions:'整理资料并给出证据。',defaultCli:'codex',models:{},mcp:[],skills:[]}},'direct',prefix+'-create-'+i,()=>{});
 if(req.url==='/__test__/operation-cards-partial'){
  try{await manager.coordination.configure({agentId:chat.agentId,conversationId:chat.id,invocationId:prefix+'-create',humanEventId:create.id},{kind:'agent',action:'create',values:{id:prefix+'-helper-0',name:'重复标识的助手',instructions:'Help',defaultCli:'codex',models:{},mcp:[],skills:[]}},'direct',prefix+'-conflict',()=>{});}catch(error){if((error as {status?:number}).status!==422)throw error;}
  await manager.coordination.configure({agentId:chat.agentId,conversationId:chat.id,invocationId:prefix+'-create',humanEventId:create.id},{kind:'agent',action:'update',id:prefix+'-helper-0',values:{name:'资料整理助手 1'}},'direct',prefix+'-unchanged',()=>{});
 }
 store.appendEvent(chat.id,'status',{status:'idle'});
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({conversationId:chat.id,message:messages[2],sourceEventId:create.id}));return true;
}
