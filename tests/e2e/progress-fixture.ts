import {createTaskWithExecutions} from '../helpers/task-executions';
import {readConfig,writeConfig} from '../../server/config';
import type {CodexOptions} from '../../server/codex';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import type {Store} from '../../server/store';
import type {SessionManager} from '../../server/sessions';
export async function progressFixture(req:IncomingMessage,res:ServerResponse,store:Store,manager:SessionManager,home:string,native?:Map<string,CodexOptions>){
 if(req.method!=='POST'||!['/__test__/explicit-progress-fixture','/__test__/progress-fixture','/__test__/progress-closure-fixture','/__test__/progress-age-task','/__test__/progress-update','/__test__/progress-age','/__test__/progress-native','/__test__/progress-wrong-run-notice'].includes(req.url??''))return false;
 let payload:unknown;
 if(req.url==='/__test__/explicit-progress-fixture'){
  const make=(title:string)=>{const c=store.createConversation({projectId:'',agentId:'explicit-progress-fixture-agent',cli:'codex',model:null});store.renameConversation(c.id,title);return c.id;};
  const first=make('中文检查对话'),second=make('并行验证对话'),empty=make('没有上报的对话');
  const user=store.appendEvent(first,'user',{text:'检查中文窄屏进度',runId:'explicit-fixture'});
  store.appendEvent(first,'status',{status:'running',runId:'explicit-fixture'});
  store.appendEvent(first,'tool',{method:'item/started',params:{item:{id:'check',type:'commandExecution',command:'inspect 中文',status:'inProgress'}}});
  store.appendEvent(first,'tool',{method:'item/started',params:{item:{id:'report-call',type:'commandExecution',command:'mandala progress report',status:'inProgress'}}});
  store.appendEvent(first,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'原生补充说明保留在观察位置。'}}});
  const report=store.appendEvent(first,'progress',{text:'已完成环境检查，正在验证中文显示。',source:'cli',runId:'explicit-fixture',steps:[{text:'检查环境',status:'completed'},{text:'验证中文与键盘',status:'running'}]});
  store.appendEvent(first,'tool',{method:'item/completed',params:{item:{id:'report-call',type:'commandExecution',command:'mandala progress report',status:'completed',aggregatedOutput:JSON.stringify({ok:true,command:'progress report',data:{id:report.id,kind:'progress'}})}}});
  store.appendEvent(first,'tool',{method:'item/completed',params:{item:{id:'check',type:'commandExecution',command:'inspect 中文',status:'completed',aggregatedOutput:'检查通过'}}});
  store.appendEvent(first,'tool',{method:'item/completed',params:{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'中文最终答复独立展示。'}}});
  store.appendEvent(first,'status',{status:'idle',runId:'explicit-fixture'});
  for(const id of [second,empty]){store.appendEvent(id,'user',{text:'独立验证',runId:id});store.appendEvent(id,'status',{status:'running',runId:id});store.updateConversation(id,{status:'running'});}
  const task=createTaskWithExecutions(store,manager.taskService,{userId:'local'},{goal:'检查进度与中文渲染'},[first,second,empty],randomUUID());
  payload={first,second,empty,task:task.id,reportId:report.id,userId:user.id};
 }else if(req.url==='/__test__/progress-fixture'){
  const initial=await readConfig(home),agentIds=['progress-planner','progress-engineer','progress-reviewer'];
  if(!initial.config.projects.some(p=>p.id==='progress-demo'))await writeConfig(home,{...initial.config,agents:[...initial.config.agents,...agentIds.map((id,index)=>({id,name:['产品策划','工程实现','代码评审'][index],instructions:'Synthetic preview',defaultCli:'codex' as const,models:{},mcp:[],skills:[]}))],projects:[...initial.config.projects,{id:'progress-demo',name:'发布协作 · 示例',cwd:mkdtempSync(join(home,'progress-demo-')),agentIds,resources:[],mcp:[],skills:[]}]},initial.revision);
  const old=new Date(Date.now()-2*86400000).toISOString(),make=(title:string,status:'idle'|'running'='idle',stale=false)=>{
   const c=store.createConversation({projectId:'progress-demo',agentId:title.includes('登录')?'progress-engineer':title.includes('评审')||title.includes('审阅')?'progress-reviewer':'progress-planner',cli:'codex',model:null});store.renameConversation(c.id,title);store.appendEvent(c.id,'user',{text:title});store.updateConversation(c.id,{status});
   if(stale){store.database.prepare("UPDATE conversations SET updated_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").run(old,old,c.id);store.database.prepare('UPDATE events SET createdAt=? WHERE conversationId=?').run(old,c.id);}return c.id;
  };
  const expiredError=make('历史失败'),expiredInterrupted=make('10月1日已中断');store.updateConversation(expiredError,{status:'error'});store.updateConversation(expiredInterrupted,{status:'interrupted'});for(const id of [expiredError,expiredInterrupted]){store.database.prepare("UPDATE conversations SET data=json_set(data,'$.createdAt',?) WHERE id=?").run(old,id);store.database.prepare('UPDATE events SET createdAt=? WHERE conversationId=?').run(old,id);}
  const longTitle='统一任务与对话进度展示，修复长中文标题在窄窗口下被挤压截断的问题，并保留筛选、完成和协作回执状态的独立性，同时验证待处理事项、运行记录和已完成结果在深浅色主题中的可读性',long=make(longTitle);
  const recent=make('梳理发布方案'),running=make('修复登录回归','running',true),waiting=make('等待审阅结论','idle',true),stale=make('上周的方案讨论','idle',true),target=make('独立评审','running',true);
  store.database.prepare("INSERT INTO agent_messages VALUES (?,?,?,1,'fixture','请确认发布范围','resume','running',NULL,'pending',1,?,NULL,'fixture',?)").run(randomUUID(),waiting,target,randomUUID(),old);
  for(const [id,text] of [[recent,'请整理上线范围、回滚步骤和评审结论，汇总为可直接分享的发布方案。'],[running,'修复登录回归，并核对相关测试是否通过。'],[waiting,'等待独立评审返回结论，再继续汇总发布清单。']])store.appendEvent(id,'user',{text});
  const task=createTaskWithExecutions(store,manager.taskService,{userId:'local'},{goal:'发布计划\n\n汇总上线范围、回滚步骤与验证结果，完成评审后交付。',projectId:'progress-demo'},[recent],randomUUID());payload={recent,running,waiting,stale,expiredError,expiredInterrupted,long,longTitle,task:task.id};
 }else if(req.url==='/__test__/progress-closure-fixture'){
  const root={userId:'local'},agent={userId:'local',agentId:'progress-planner'};
  const user=manager.taskService.createTask(root,{goal:'用户创建的发布检查',projectId:'progress-demo',assigneeAgentId:'progress-reviewer'},randomUUID());
  const delegated=manager.taskService.createTask(agent,{goal:'Agent 创建的长标题任务：确认发布回滚步骤并收集最终评审结果',projectId:'progress-demo'},randomUUID());
  const unknown=manager.taskService.createTask(root,{goal:'来源未记录的历史任务',projectId:'progress-demo'},randomUUID());
  if(store.database.prepare("SELECT name FROM sqlite_master WHERE name='task_creation_sources'").get())store.database.prepare('DELETE FROM task_creation_sources WHERE task_id=?').run(unknown.id);
  const system=manager.taskService.createTask(root,{goal:'平台创建的协调任务',projectId:'progress-demo'},randomUUID(),'system');
  payload={userTask:user.id,agentTask:delegated.id,unknownTask:unknown.id,systemTask:system.id};
 }else if(req.url==='/__test__/progress-age-task'){
  let body='';for await(const chunk of req)body+=chunk;const {id,ageMinutes}=JSON.parse(body),at=new Date(Date.now()-ageMinutes*60000).toISOString();
  store.database.prepare("UPDATE work_tasks SET created_at=?,completion=CASE WHEN completion IS NULL THEN NULL ELSE json_set(completion,'$.acceptedAt',?) END WHERE id=?").run(at,at,id);
  store.database.prepare('UPDATE outbox SET created_at=? WHERE aggregate_id=?').run(at,id);payload={ok:true,at};
 }else if(req.url==='/__test__/progress-wrong-run-notice'){
  let body='';for await(const chunk of req)body+=chunk;const {taskId}=JSON.parse(body),other=manager.taskService.createTask({userId:'other-user'},{goal:'Private other user goal'},randomUUID()),runId=randomUUID();
  const privateChat=store.createConversation({projectId:'',agentId:'private-fixture-agent',cli:'codex',model:null}),privateChatId=privateChat.id;
  const execution=manager.taskService.createExecution({userId:'other-user'},other.id,{conversationId:privateChat.id,agentId:'private-fixture-agent',projectId:null,request:other.goal},runId+'-execution');
  store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,created_at) VALUES (?,?,?,1,'approval',?,?)").run(runId,other.id,execution.id,JSON.stringify({executionConversationId:privateChat.id,mode:'dedicated',destinationConversationId:null}),new Date().toISOString());
  const noticeId=store.enqueueOutbox({type:'task.execution_attention',aggregateId:taskId,aggregateRevision:1,causationId:randomUUID(),payload:{taskId,runId,state:'approval'}});payload={noticeId,runId,privateChatId};
 }else if(req.url==='/__test__/progress-native'){
  let body='';for await(const chunk of req)body+=chunk;const {id,outcome,text}=JSON.parse(body),chat=store.getConversation(id),options=chat?.nativeId?native?.get(chat.nativeId):null;
  if(!chat?.nativeId||!chat.turnId||!options){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'No active synthetic native turn'}));return true;}
  if(outcome==='unknown')options.onExit('Synthetic controlled disconnection');
  else{if(text)options.onEvent({method:'item/completed',params:{threadId:chat.nativeId,turnId:chat.turnId,item:{id:randomUUID(),type:'agentMessage',phase:'final_answer',text}}});options.onEvent({method:'turn/completed',params:{threadId:chat.nativeId,turn:{id:chat.turnId,status:outcome==='failed'?'failed':'completed',...(outcome==='failed'?{error:{message:'Synthetic controlled failure'}}:{})}}});}
  payload={ok:true};
 }else if(req.url==='/__test__/progress-age'){
  let body='';for await(const chunk of req)body+=chunk;const {id,ageMinutes,status}=JSON.parse(body);
  if(status)store.updateConversation(id,{status});
  const at=new Date(Date.now()-ageMinutes*60000).toISOString();
  store.database.prepare("UPDATE conversations SET updated_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").run(at,at,id);
  store.database.prepare('UPDATE events SET createdAt=? WHERE conversationId=?').run(at,id);
  store.database.prepare('UPDATE conversation_progress SET completed_at=CASE WHEN completed_at IS NULL THEN NULL ELSE ? END,visited_at=CASE WHEN visited_at IS NULL THEN NULL ELSE ? END,changed_at=CASE WHEN changed_at IS NULL THEN NULL ELSE ? END WHERE conversation_id=?').run(at,at,at,id);
  payload={ok:true,at};
 }else{
  let body='';for await(const chunk of req)body+=chunk;const {id,kind}=JSON.parse(body);
  store.appendEvent(id,'user',{text:kind==='late'?'后台协作回复':'新工作',...(kind==='late'?{agentMessage:{id:'fixture',direction:'reply'}}:{})});
  store.updateConversation(id,{status:'running'});store.appendEvent(id,'text',{text:'收到新的评审结论'});payload={ok:true};
 }
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));return true;
}
