import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../../server/store';
import type {SessionManager} from '../../server/sessions';

export function notificationInboxFixture(req:IncomingMessage,res:ServerResponse,store:Store,manager:SessionManager){
 const match=req.url?.match(/^\/__test__\/notification-inbox\/(completed|approval|failed)$/);
 if(req.method!=='POST'||!match)return false;
 const state=match[1],id=crypto.randomUUID(),title=state==='approval'?'跨项目账单核验与资产采集记录验证'.repeat(4):state==='failed'?'账单采集执行失败':'海德拉巴预付账单核验';
 const chat=store.createConversation({projectId:'',agentId:'notification-fixture-agent',cli:'codex',model:null});store.renameConversation(chat.id,title);
 const task=manager.taskService.createTask({userId:store.ownerUserId},{goal:'用户问：请检查数据来源并核验账单采集结果。'.repeat(30)},id);
 const execution=manager.taskService.createExecution({userId:store.ownerUserId},task.id,{conversationId:chat.id,agentId:'notification-fixture-agent',projectId:null,request:task.goal},id+'-execution');
 const at=new Date().toISOString();
 store.database.prepare('INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,created_at) VALUES (?,?,?,1,?,?,?)').run(id,task.id,execution.id,state==='completed'?'succeeded':state,JSON.stringify({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}),at);
 store.enqueueOutbox({type:state==='approval'?'task.execution_attention':'task.run_terminal',aggregateId:task.id,aggregateRevision:1,causationId:id,payload:{taskId:task.id,runId:id,state}});
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({taskId:task.id,executionId:chat.id,title}));return true;
}
