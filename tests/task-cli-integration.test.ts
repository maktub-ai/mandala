import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {DomainError} from '../shared/workspace-contracts';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir}from'node:os';import{join}from'node:path';import{once}from'node:events';
import {openStore}from'../server/store';import{readConfig,writeConfig}from'../server/config';import{createSessionManager}from'../server/sessions';import{createHttpServer}from'../server/http';import{createSystemTasks}from'../server/system-tasks';import{businessCliContext}from'./business-cli-context';import type{CodexClient,CodexOptions}from'../server/codex';
let home:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,server:ReturnType<typeof createHttpServer>,system:ReturnType<typeof createSystemTasks>,base:string,token:string,native:CodexOptions,turn:number;
const settled=vi.fn(),generate=vi.fn();
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'mana-task-cli-'));const initial=await readConfig(home);
 await writeConfig(home,{...initial.config,system:{cli:'codex',memoryCapture:false},agents:['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex' as const,models:{},mcp:[],skills:[]})),projects:[{id:'p',name:'P',cwd:'',agentIds:['a','b'],resources:[],mcp:[],skills:[]}]},initial.revision);
 store=openStore(home);turn=0;settled.mockReset();generate.mockReset().mockResolvedValue(JSON.stringify([{taskId:'placeholder',state:'review',evidence:'Goal met'}]));
 manager=createSessionManager(store,async()=>(await readConfig(home)).config,async(options):Promise<CodexClient>=>{native=options;return{getStatus:async()=>({status:'ready',version:'fake'}),listModels:async()=>[],startThread:async p=>{token=businessCliContext(p.instructions).token;return's';},resumeThread:async(_id,_mcp,instructions)=>{token=businessCliContext(instructions).token;},startTurn:async()=>`t${++turn}`,interrupt:async()=>{},replyApproval(){},close(){}};},undefined,home,(id,round)=>{settled(id,round);void system.onSettled(id,round).catch(()=>{});});
 system=createSystemTasks({store,home,loadConfig:async()=>(await readConfig(home)).config,tasks:manager.taskService,generate});
 server=createHttpServer({requireIdentity:false,store,home,manager,systemTasks:system});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{system.close();await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});});
const request=(path:string,data:unknown,method='POST',key:string=crypto.randomUUID())=>fetch(base+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(data)});
test('task list displays the latest execution conversation title without replacing the task goal',async()=>{
 const p={userId:'local'},task=manager.taskService.createTask(p,{goal:'Long original instructions',assigneeAgentId:'a'},'title-task');
 const first=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),latest=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 store.renameConversation(first.id,'Earlier execution');store.renameConversation(latest.id,'Collection check');
 for(const [index,chat] of [first,latest].entries()){const execution=manager.taskService.createExecution(p,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:task.goal},'title-execution-'+index);store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,created_at) VALUES (?,?,?,?,'succeeded',?,?)").run('title-run-'+index,task.id,execution.id,index+1,JSON.stringify({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}),new Date().toISOString());}
 const read=async()=>{const response=await fetch(base+'/api/v2/tasks');expect(response.status).toBe(200);return await response.json();};
 expect(await read()).toMatchObject([{id:task.id,goal:'Long original instructions',executionTitle:'Collection check'}]);
 store.renameConversation(latest.id,'Renamed collection check');
 expect(await read()).toMatchObject([{executionTitle:'Renamed collection check'}]);
 const authorize=vi.spyOn(manager,'authorizeConversationRead').mockImplementation(id=>{if(id===latest.id)throw new DomainError('forbidden',403,'Forbidden');});
 expect(JSON.stringify(await read())).not.toContain('Renamed collection check');authorize.mockRestore();
});
test('HTTP independently creates edits associates and manually accepts a Task without any Run',async()=>{
 const chat=await manager.create('p','a',undefined,undefined,{workspaceId:null});
 const made=await request('/api/v2/tasks',{goal:'Independent goal',projectId:null,participantAgentIds:['a','b']});expect(made.status).toBe(201);let task=await made.json();expect(task).toMatchObject({projectId:null,criteria:[],participantAgentIds:['a','b']});
 const edit=await request('/api/v2/tasks/'+task.id,{expectedRevision:task.revision,goal:'Updated goal'},'PATCH');expect(edit.status).toBe(200);task=await edit.json();const attached=await request('/api/v2/tasks/'+task.id+'/executions',{expectedRevision:task.revision,conversationId:chat.id});expect(attached.status).toBe(201);task=await attached.json();expect(task.conversationIds).toEqual([chat.id]);
 expect(await(await fetch(base+'/api/v2/tasks?conversationId='+chat.id)).json()).toMatchObject([{id:task.id}]);
 const review=await request('/api/v2/tasks/'+task.id+'/complete',{expectedRevision:task.revision});expect(review.status).toBe(200);task=await review.json();expect(task.state).toBe('review');
 const accepted=await request('/api/v2/tasks/'+task.id+'/accept',{expectedRevision:task.revision});expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({state:'completed',completion:{completedBy:'user',sourceRunId:null}});
});
test('Agent CLI uses bound identity explicit null/empty links and cannot bypass state transitions or transcript ACL',async()=>{
 const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Work');
 const created=await manager.callBoundTool(token,'task_create',{goal:'Independent',projectId:null,participantAgentIds:[]},'create');expect(created).toMatchObject({creatorAgentId:'a',projectId:null});
 await expect(manager.callBoundTool(token,'task_create',{goal:'Implicit'},'implicit')).rejects.toMatchObject({status:422});
 await expect(manager.callBoundTool(token,'task_create',{goal:'Legacy field',projectId:null,conversationIds:[]},'legacy')).rejects.toMatchObject({code:'invalid_tool_arguments',status:422});
 const task=created as any;await expect(manager.callBoundTool(token,'task_update',{taskId:task.id,expectedRevision:task.revision,state:'completed'},'force')).rejects.toMatchObject({status:422});
 await expect(manager.callBoundTool(token,'task_accept',{taskId:task.id,expectedRevision:task.revision},'force-accept')).rejects.toMatchObject({status:409});
 const foreign=await manager.create('','b',undefined,undefined,{workspaceId:null});
 await expect(manager.callBoundTool(token,'conversation_read',{conversationId:foreign.id},'read-foreign')).rejects.toMatchObject({status:403});
 const linked=await manager.callBoundTool(token,'task_execution_add',{taskId:task.id,expectedRevision:task.revision,conversationId:source.id},'link');expect(linked).toMatchObject({conversationIds:[source.id]});
 expect(await manager.callBoundTool(token,'task_context',{},'context')).toMatchObject({conversationId:source.id,project:{id:'p'},agent:{id:'a'}});
});
test('ordinary successful native final turn actually schedules linked Task assessment with exact final answer',async()=>{
 const chat=await manager.create('p','a',undefined,undefined,{workspaceId:null});const task=createTaskWithExecutions(store,manager.taskService,{userId:'local'},{goal:'Goal',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null},[chat.id],'goal');
 generate.mockResolvedValue(JSON.stringify([{taskId:task.id,state:'review',evidence:'Goal met'}]));await manager.send(chat.id,'This round user input');
 native.onEvent({method:'item/completed',params:{threadId:'s',turnId:'t1',item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Midway'}}});
 native.onEvent({method:'item/completed',params:{threadId:'s',turnId:'t1',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Final goal evidence'}}});
 native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});
 expect(settled).toHaveBeenCalledWith(chat.id,expect.objectContaining({user:'This round user input',reply:'Final goal evidence',sourceEventId:expect.any(Number)}));
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));await vi.waitFor(()=>expect(manager.taskService.getTask({userId:'local'},task.id).state).toBe('review'));
 expect(generate.mock.calls[0][1]).not.toContain('Midway');expect(manager.taskService.getTask({userId:'local'},task.id).completion).toBeNull();
});

test('successful turn with only commentary does not evaluate linked Tasks',async()=>{
 const chat=await manager.create('p','a',undefined,undefined,{workspaceId:null});const task=createTaskWithExecutions(store,manager.taskService,{userId:'local'},{goal:'Goal'},[chat.id],'no-final');
 await manager.send(chat.id,'Input');native.onEvent({method:'item/completed',params:{threadId:'s',turnId:'t1',item:{id:'comment',type:'agentMessage',phase:'commentary',text:'I am working'}}});
 native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});await new Promise(r=>setTimeout(r,20));
 expect(generate).not.toHaveBeenCalled();expect(manager.taskService.getTask({userId:'local'},task.id).state).toBe('todo');
});
test('context endpoint is descriptive and never associates an independent Task',async()=>{
 const chat=await manager.create('p','a',undefined,undefined,{workspaceId:null});const before=manager.taskService.listTasks({userId:'local'}).length;
 const response=await fetch(base+'/api/v2/tasks/context?conversationId='+chat.id);expect(response.status).toBe(200);expect(await response.json()).toEqual({conversationId:chat.id,project:{id:'p',name:'P'},agent:{id:'a',name:'a'}});expect(manager.taskService.listTasks({userId:'local'})).toHaveLength(before);
});
test('Agent conversation history includes completed native final snapshots even without deltas',async()=>{
 const chat=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(chat.id,'First input');
 native.onEvent({method:'item/completed',params:{threadId:'s',turnId:'t1',item:{id:'only-final',type:'agentMessage',phase:'final_answer',text:'Snapshot-only final'}}});
 native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});await manager.send(chat.id,'Second input');
 const history=await manager.callBoundTool(token,'conversation_history',{conversationId:chat.id},'history');expect(JSON.stringify(history)).toContain('Snapshot-only final');
});
test('HTTP and bound Agent execution commands replay after later edits and reject historical removal',async()=>{
 const source=await manager.create('p','a',undefined,undefined,{workspaceId:null}),other=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Execution sample');
 const task=await manager.callBoundTool(token,'task_create',{goal:'Executions',projectId:null},'task') as any;
 const first=await manager.callBoundTool(token,'task_execution_add',{taskId:task.id,expectedRevision:1,conversationId:source.id},'first') as any;
 const second=await request(`/api/v2/tasks/${task.id}/executions`,{expectedRevision:first.revision,conversationId:other.id},'POST','second');expect(second.status).toBe(201);const both=await second.json();
 await expect(manager.callBoundTool(token,'task_execution_add',{taskId:task.id,expectedRevision:1,conversationId:source.id},'first')).resolves.toMatchObject({revision:both.revision});
 const historical=both.executions.find((e:any)=>e.conversationId===source.id),pristine=both.executions.find((e:any)=>e.conversationId===other.id);
 expect((await request(`/api/v2/tasks/${task.id}/executions/${historical.id}/remove`,{expectedRevision:both.revision},'POST','history')).status).toBe(409);
 const removed=await request(`/api/v2/tasks/${task.id}/executions/${pristine.id}/remove`,{expectedRevision:both.revision},'POST','remove');expect(removed.status).toBe(200);const without=await removed.json();expect(without.conversationIds).toEqual([source.id]);
 const restored=await request(`/api/v2/tasks/${task.id}/executions`,{expectedRevision:without.revision,conversationId:other.id},'POST','restore');expect(restored.status).toBe(201);const current=await restored.json();
 expect(await(await request(`/api/v2/tasks/${task.id}/executions/${pristine.id}/remove`,{expectedRevision:both.revision},'POST','remove')).json()).toEqual(current);
});

test.each(['q',null])('Task project edited to %s starts a fresh execution in the chosen context after failure',async(projectId)=>{
 const config=await readConfig(home);await writeConfig(home,{...config.config,projects:[...config.config.projects,{...config.config.projects[0],id:'q',name:'Q'}]},config.revision);
 const p={userId:'local'},task=manager.taskService.createTask(p,{goal:'Run',projectId:'p',assigneeAgentId:'a'},'project-task');const run=await manager.startDurableTask(task.id,task.revision,'old-start');
 await vi.waitFor(()=>expect(manager.taskService.getRun(p,run.id).state).toBe('running'));
 native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'failed'}}});
 const failed=manager.taskService.getTask(p,task.id);const edited=manager.taskService.updateTask(p,task.id,failed.revision,{projectId},'project-edit');
 const next=await manager.startDurableTask(task.id,edited.revision,'new-start');expect(next.routing!.executionConversationId).not.toBe(run.routing!.executionConversationId);
 expect(store.getConversation(next.routing!.executionConversationId)!.projectId).toBe(projectId??'');expect(next.attempt).toBe(2);
});
test('real settled hook records Task evaluation configuration failure without changing progress',async()=>{
 system.close();system=createSystemTasks({store,home,tasks:manager.taskService,loadConfig:async()=>{throw Error('Synthetic configuration failure');},generate});
 const chat=await manager.create('p','a',undefined,undefined,{workspaceId:null}),task=createTaskWithExecutions(store,manager.taskService,{userId:'local'},{goal:'Goal'},[chat.id],'bad-profile');
 await manager.send(chat.id,'Input');native.onEvent({method:'item/completed',params:{threadId:'s',turnId:'t1',item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Final answer'}}});native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});
 await vi.waitFor(()=>expect(system.status(chat.id).history.some(e=>(e.data as any).systemTask==='taskProgress'&&(e.data as any).code==='configuration-failed')).toBe(true));
 expect(manager.taskService.getTask({userId:'local'},task.id).state).toBe('todo');expect(generate).not.toHaveBeenCalled();
});
test('bound Agent creates a disabled rule for its Task, lists history and explicitly starts/stops queued work',async()=>{const {createAutomations}=await import('../server/automations');const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});try{const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Work');const invocationToken=token;const task=await manager.callBoundTool(invocationToken,'task_create',{goal:'Daily check',projectId:'p',assigneeAgentId:'a'},'rule-task') as any;const rule=await manager.callBoundTool(invocationToken,'automation_create',{taskId:task.id,name:'Daily',instructions:'Daily check',projectId:'p',agentId:'a',cli:'codex',enabled:true,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}},'create-rule') as any;expect(rule).toMatchObject({taskId:task.id,enabled:false});expect((await manager.callBoundTool(invocationToken,'automation_list',{},'list') as any).automations).toHaveLength(1);const run=await manager.callBoundTool(invocationToken,'task_start',{taskId:task.id,expectedRevision:task.revision,conversationId:source.id},'explicit-start') as any;expect(run.state).toBe('queued');await manager.callBoundTool(invocationToken,'task_stop',{taskId:task.id,expectedRevision:task.revision+1},'explicit-stop');expect(manager.taskService.getRun({userId:'local'},run.id).state).toBe('interrupted');expect(await manager.callBoundTool(invocationToken,'task_runs',{taskId:task.id},'run-history')).toMatchObject([{id:run.id,state:'interrupted'}]);expect((await service.list()).automations[0].enabled).toBe(false);}finally{service.close();}});
test('bound Agent may save an unassigned disabled rule but blank Agent cannot bypass assignment or Task authorization',async()=>{const {createAutomations}=await import('../server/automations');const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});try{const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Rule save sample');const invocationToken=token;const task=await manager.callBoundTool(invocationToken,'task_create',{goal:'Unassigned',projectId:null,assigneeAgentId:null},'unassigned-rule-task') as any;const input={name:'Pending rule',instructions:'Unassigned',projectId:'',agentId:'',cli:'codex',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}};expect(await manager.callBoundTool(invocationToken,'automation_create',{...input,taskId:task.id},'blank-rule')).toMatchObject({taskId:task.id,enabled:false,agentId:''});expect(manager.taskService.listRuns({userId:'local'},task.id)).toEqual([]);const assigned=await manager.callBoundTool(invocationToken,'task_create',{goal:'Assigned',projectId:null,assigneeAgentId:'a'},'assigned-rule-task') as any;await expect(manager.callBoundTool(invocationToken,'automation_create',{...input,taskId:assigned.id},'blank-assigned-denied')).rejects.toMatchObject({status:403});const foreign=manager.taskService.createTask({userId:'local'},{goal:'Foreign',projectId:null,assigneeAgentId:'b'},'foreign-task');await expect(manager.callBoundTool(invocationToken,'automation_create',{...input,taskId:foreign.id},'foreign-rule-denied')).rejects.toMatchObject({status:403});expect((await service.list()).automations).toHaveLength(1);}finally{service.close();}});

test('bound Agent finishes user-created shared goals, reopens without executing, and retains permissions',async()=>{
 const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Manage shared work');const invocationToken=token;
 const task=manager.taskService.createTask({userId:'local'},{goal:'User-created shared goal',participantAgentIds:['a']},'user-shared');
 const done=await manager.callBoundTool(invocationToken,'task_mark_completed',{taskId:task.id,expectedRevision:1},'finish-shared') as any;expect(done).toMatchObject({state:'completed',completion:{completedBy:'agent',completedByAgentId:'a'}});
 expect(await manager.callBoundTool(invocationToken,'task_mark_completed',{taskId:task.id,expectedRevision:1},'finish-shared')).toEqual(done);
 const reopened=await manager.callBoundTool(invocationToken,'task_reopen',{taskId:task.id,expectedRevision:done.revision},'reopen-shared') as any;expect(reopened).toMatchObject({state:'todo',completion:null});expect(manager.taskService.listRuns({userId:'local'},task.id)).toEqual([]);
 const assigned=await manager.callBoundTool(invocationToken,'task_assign',{taskId:task.id,expectedRevision:reopened.revision,agentId:'b'},'assign-shared') as any;expect(assigned.assigneeAgentId).toBe('b');
 const review=await manager.callBoundTool(invocationToken,'task_review',{taskId:task.id,expectedRevision:assigned.revision},'review-shared') as any;expect(review.state).toBe('review');
 const todo=await manager.callBoundTool(invocationToken,'task_request_changes',{taskId:task.id,expectedRevision:review.revision,reason:'One more check'},'changes-shared') as any;expect(todo.state).toBe('todo');
 const cancelled=await manager.callBoundTool(invocationToken,'task_cancel',{taskId:task.id,expectedRevision:todo.revision},'cancel-shared') as any;expect(cancelled.status).toBe('cancelled');
 const privateTask=manager.taskService.createTask({userId:'local'},{goal:'Private b',assigneeAgentId:'b'},'private-b');await expect(manager.callBoundTool(invocationToken,'task_mark_completed',{taskId:privateTask.id,expectedRevision:1},'private-finish')).rejects.toMatchObject({status:403});
 await expect(manager.callBoundTool(invocationToken,'task_mark_completed',{taskId:task.id,expectedRevision:1,agentId:'b'},'identity-override')).rejects.toMatchObject({status:422});
});

test('executing Agent explicitly requests own Task completion and successful final turn applies it',async()=>{
 const owner={userId:'local'},task=manager.taskService.createTask(owner,{goal:'Own goal',projectId:'p',assigneeAgentId:'a'},'own-task');const run=await manager.startDurableTask(task.id,task.revision,'own-start');await vi.waitFor(()=>expect(manager.taskService.getRun(owner,run.id).state).toBe('running'));const ownToken=token,current=manager.taskService.getTask(owner,task.id);
 expect(await manager.callBoundTool(ownToken,'task_mark_completed',{taskId:task.id,expectedRevision:current.revision},'own-complete')).toMatchObject({state:'running',completionRequested:true,completion:null});
 native.onEvent({method:'item/completed',params:{threadId:'s',turnId:'t1',item:{id:'own-final',type:'agentMessage',phase:'final_answer',text:'Goal delivered and checked'}}});native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});
 await vi.waitFor(()=>expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'completed',completion:{completedBy:'agent',completedByAgentId:'a',sourceRunId:run.id}}));
 await expect(manager.callBoundTool(ownToken,'task_reopen',{taskId:task.id,expectedRevision:manager.taskService.getTask(owner,task.id).revision},'expired-reopen')).rejects.toMatchObject({status:403});
});
test('bound executor cancellation explicitly interrupts its own active Run and invalidates completion intent',async()=>{
 const owner={userId:'local'},task=manager.taskService.createTask(owner,{goal:'Cancel own run',projectId:'p',assigneeAgentId:'a'},'own-cancel-task'),run=await manager.startDurableTask(task.id,1,'own-cancel-start');await vi.waitFor(()=>expect(manager.taskService.getRun(owner,run.id).state).toBe('running'));const current=manager.taskService.getTask(owner,task.id),ownToken=token,oldNative=native;
 await manager.callBoundTool(ownToken,'task_mark_completed',{taskId:task.id,expectedRevision:current.revision},'own-intent');
 expect(await manager.callBoundTool(ownToken,'task_cancel',{taskId:task.id,expectedRevision:current.revision},'own-cancel')).toMatchObject({taskId:task.id,status:'cancelled',runId:run.id});
 expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'cancelled',futureAutoResume:false,completion:null});expect(manager.taskService.getRun(owner,run.id).state).toBe('interrupted');expect(store.database.prepare('SELECT * FROM task_completion_intents WHERE run_id=?').get(run.id)).toBeUndefined();
 oldNative.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});expect(manager.taskService.getTask(owner,task.id).state).toBe('cancelled');await expect(manager.callBoundTool(ownToken,'task_reopen',{taskId:task.id,expectedRevision:manager.taskService.getTask(owner,task.id).revision},'expired')).rejects.toMatchObject({status:403});
});
test('bound Agent cancels another authorized active executor but cannot cancel a private Task',async()=>{
 const owner={userId:'local'},task=manager.taskService.createTask(owner,{goal:'Shared active work',projectId:'p',assigneeAgentId:'b',participantAgentIds:['a']},'other-cancel-task'),run=await manager.startDurableTask(task.id,1,'other-cancel-start');await vi.waitFor(()=>expect(manager.taskService.getRun(owner,run.id).state).toBe('running'));
 const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Cancel shared work');const sourceToken=token,privateTask=manager.taskService.createTask(owner,{goal:'Private b',assigneeAgentId:'b'},'private-cancel');
 await expect(manager.callBoundTool(sourceToken,'task_cancel',{taskId:privateTask.id,expectedRevision:1},'denied-cancel')).rejects.toMatchObject({status:403});expect(manager.taskService.getTask(owner,privateTask.id).state).toBe('todo');
 const current=manager.taskService.getTask(owner,task.id);expect(await manager.callBoundTool(sourceToken,'task_cancel',{taskId:task.id,expectedRevision:current.revision},'authorized-cancel')).toMatchObject({status:'cancelled',runId:run.id});expect(manager.taskService.getRun(owner,run.id).state).toBe('interrupted');expect(store.getConversation(source.id)?.status).toBe('running');
});
test('Agent cancellation interrupts delegated execution and parks late delivery without resuming the origin',async()=>{
 const owner={userId:'local'},source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Coordinate and then cancel');const sourceToken=token;
 const delegated=await manager.callBoundTool(sourceToken,'delegate',{targetAgentId:'b',request:'Deliver later'},'cancel-delegate') as any,task=manager.taskService.getTask(owner,delegated.id);
 await vi.waitFor(()=>expect(manager.taskService.listRuns(owner,task.id)[0].state).toBe('running'));const run=manager.taskService.listRuns(owner,task.id)[0],executor=native,turn=store.getConversation(run.routing!.executionConversationId)!.turnId!;
 expect(task.originConversationId).toBe(source.id);expect(task.executions).toHaveLength(1);
 expect(await manager.callBoundTool(sourceToken,'task_cancel',{taskId:task.id,expectedRevision:manager.taskService.getTask(owner,task.id).revision},'cancel-task')).toMatchObject({status:'cancelled'});
 executor.onEvent({method:'item/completed',params:{threadId:'s',turnId:turn,item:{id:'late-final',type:'agentMessage',phase:'final_answer',text:'Late delivery'}}});executor.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:turn,status:'completed'}}});
 expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'cancelled',futureAutoResume:false});expect(manager.taskService.getRun(owner,run.id).state).toBe('interrupted');expect(manager.taskService.listReceipts(owner,task.id)).toMatchObject([{executionId:run.executionId,deliveryState:'parked'}]);expect(manager.listUserInputs(source.id).some(input=>input.state==='queued'||input.state==='running')).toBe(false);
});

test('explicit progress uses bound run, replays once, rejects forged identity and becomes historical',async()=>{
 const chat=await manager.create('','',undefined,undefined,{workspaceId:null});await manager.send(chat.id,'Long work');
 const first=await manager.callBoundTool(token,'progress_report',{text:'Checking inputs',steps:[{text:'Read inputs',status:'running'}]},'progress-1');
 expect(first).toMatchObject({kind:'progress',conversationId:chat.id,data:{text:'Checking inputs',agentId:null,source:'cli',runId:manager.executionId(chat.id)}});
 expect(await manager.callBoundTool(token,'progress_report',{text:'Checking inputs',steps:[{text:'Read inputs',status:'running'}]},'progress-1')).toEqual(first);
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='progress')).toHaveLength(1);
 await expect(manager.callBoundTool(token,'progress_report',{text:'Other'},'progress-1')).rejects.toMatchObject({status:409});
 for(const args of [{text:''},{text:'Hi',runId:'forged'},{text:'Hi',steps:[{text:'x',status:'invalid'}]}])await expect(manager.callBoundTool(token,'progress_report',args,'bad')).rejects.toMatchObject({status:422});
 const {createConversationProgress}=await import('../server/conversation-progress');const view=createConversationProgress(store,manager);
 expect(view.list()[0]).toMatchObject({latestProgress:{text:'Checking inputs',historical:false,sourceEventId:(first as any).id}});
 expect(settled).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
 const oldToken=token;native.onEvent({method:'turn/completed',params:{threadId:'s',turn:{id:'t1',status:'completed'}}});
 expect(view.list()[0]).toMatchObject({latestProgress:{historical:true}});
 await manager.send(chat.id,'New turn');expect(view.list()[0].latestProgress).toBeNull();
 await expect(manager.callBoundTool(oldToken,'progress_report',{text:'Late'},'late')).rejects.toMatchObject({status:403});
 await manager.callBoundTool(token,'progress_report',{text:'New work'},'progress-2');expect(view.list()[0]).toMatchObject({latestProgress:{text:'New work',historical:false}});
 await manager.callBoundTool(token,'progress_report',{text:'Latest received stage'},'progress-3');
 await manager.callBoundTool(token,'progress_report',{text:'New work'},'progress-2');
 expect(view.list()[0]).toMatchObject({latestProgress:{text:'Latest received stage'}});
 await manager.stop(chat.id);expect(view.list()[0]).toMatchObject({latestProgress:{historical:true}});
 await expect(manager.callBoundTool(token,'progress_report',{text:'Stopped'},'stopped')).rejects.toMatchObject({status:403});
});

test('standalone independent rules remain scoped to the bound Agent and Project without a save-time Task',async()=>{
 const {createAutomations}=await import('../server/automations');const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});
 try{
  const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Schedule my daily checks');const invocationToken=token;
  const body={name:'Own standalone',instructions:'PRIVATE_OWN_INSTRUCTIONS',projectId:'p',agentId:'a',cli:'codex',enabled:false,executionMode:'independent',schedule:{kind:'weekly',weekdays:[1,2,3,4,5],time:'09:00',timeZone:'Asia/Singapore'}};
  const own=await manager.callBoundTool(invocationToken,'automation_create',body,'standalone-own') as any;expect(own.taskId).toBeUndefined();expect(store.database.prepare('SELECT COUNT(*) n FROM work_tasks').get()!.n).toBe(0);
  const foreign=await service.create({...body,agentId:'b',instructions:'PRIVATE_FOREIGN_INSTRUCTIONS'});
  const unrelatedProject=await service.create({...body,projectId:'',instructions:'PRIVATE_OTHER_PROJECT'});
  const listed=await manager.callBoundTool(invocationToken,'automation_list',{},'standalone-list') as any;expect(listed.automations.map((a:any)=>a.id)).toEqual([own.id]);expect(JSON.stringify(listed)).not.toContain('PRIVATE_FOREIGN');expect(JSON.stringify(listed)).not.toContain('PRIVATE_OTHER_PROJECT');
  for(const rule of [foreign,unrelatedProject]){
   await expect(manager.callBoundTool(invocationToken,'automation_update',{automationId:rule.id,expectedRevision:rule.revision,name:'Taken over'},'forbidden-'+rule.id)).rejects.toMatchObject({status:403});
   await expect(manager.callBoundTool(invocationToken,'automation_run',{automationId:rule.id},'run-forbidden-'+rule.id)).rejects.toMatchObject({status:403});
  }
  await expect(manager.callBoundTool(invocationToken,'automation_create',{...body,agentId:'b'},'create-foreign')).rejects.toMatchObject({status:403});
  await expect(manager.callBoundTool(invocationToken,'automation_create',{...body,projectId:''},'create-other-project')).rejects.toMatchObject({status:403});
  const run=await manager.callBoundTool(invocationToken,'automation_run',{automationId:own.id},'own-once') as any;expect(run.taskId).toBeTruthy();
  expect((await manager.callBoundTool(invocationToken,'automation_list',{},'with-history') as any).runs.map((r:any)=>r.id)).toEqual([run.id]);
 }finally{service.close();}
});
