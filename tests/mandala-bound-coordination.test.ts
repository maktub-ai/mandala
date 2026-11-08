import {ensureConfiguredMandala} from './configured-mandala';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {readConfig,writeConfig} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createSessionManager} from '../server/sessions';
import {createAutomations} from '../server/automations';
import type {CodexClient,CodexOptions} from '../server/codex';
import {businessCliContext} from './business-cli-context';
import * as discovery from '../server/work-directory-discovery';
import * as capabilities from '../server/team-capability-discovery';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();vi.restoreAllMocks();});
async function setup(){
 const home=await mkdtemp(join(tmpdir(),'mandala-bound-')),store=openStore(home);const first=await ensureConfiguredMandala(home);
 await writeConfig(home,{...first.config,agents:[...first.config.agents,...['worker','temp'].map(id=>({id,name:id,instructions:'Execute',defaultCli:'codex' as const,models:{},mcp:[],skills:[],...(id==='temp'?{temporary:true}:{})}))]},first.revision);
 const entries:{options:CodexOptions;token:string;native:string}[]=[];
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{const entry={options,token:'',native:'native-'+entries.length};entries.push(entry);return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{entry.token=businessCliContext(p.instructions).token;return entry.native;},resumeThread:async(_id,_m,instructions)=>{entry.token=businessCliContext(instructions).token;},startTurn:async()=>entry.native+'-turn',interrupt:async()=>{},replyApproval(){},close(){}};};
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(async()=>{await manager.close();store.close();await rm(home,{recursive:true,force:true});});
 const chat=ensureMandalaConversation(store,(await readConfig(home)).config);
 const finish=(entry=entries[0])=>entry.options.onEvent({method:'turn/completed',params:{threadId:entry.native,turn:{id:entry.native+'-turn',status:'completed'}}});
 return {home,store,manager,chat,entries,finish};
}
const criteria=[{id:'ok',text:'Deliver answer',checkRef:null}];
it('records real task and automation no-ops without hiding subsequent changes',async()=>{
 const {manager,chat,entries,store,home}=await setup();
 const automations=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});cleanup.push(async()=>{automations.close();});
 await manager.send(chat.id,'Review changes');const token=entries[0].token;
 const task=await manager.callBoundTool(token,'task_create',{goal:'Keep goal',criteria,projectId:null},'noop-task-create') as import('../shared/tasks').Task;
 const updated=await manager.callBoundTool(token,'task_update',{taskId:task.id,expectedRevision:task.revision,goal:task.goal},'noop-task-update') as typeof task;
 await manager.callBoundTool(token,'task_update',{taskId:task.id,expectedRevision:updated.revision,goal:'Changed goal'},'changed-task-update');
 const rule=await manager.callBoundTool(token,'automation_create',{name:'Keep rule',instructions:'Review',projectId:'',agentId:chat.agentId,cli:'codex',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}},'noop-rule-create') as import('../shared/automations').Automation;
 const saved=await manager.callBoundTool(token,'automation_update',{automationId:rule.id,expectedRevision:rule.revision,name:rule.name},'noop-rule-update') as typeof rule;
 await manager.callBoundTool(token,'automation_update',{automationId:rule.id,expectedRevision:saved.revision,name:'Changed rule'},'changed-rule-update');
 await manager.callBoundTool(token,'automation_stop',{automationId:rule.id},'noop-rule-stop');
 const receipts=store.listEvents(chat.id,0).flatMap(event=>{const result=(event.data as {operationResult?:import('../shared/operation-results').OperationResult}).operationResult;return result?[result]:[];});
 for(const key of ['noop-task-update','noop-rule-update','noop-rule-stop'])expect(receipts.find(r=>r.id.endsWith(':'+key))?.facts).toMatchObject({unchanged:'true'});
 for(const key of ['changed-task-update','changed-rule-update'])expect(receipts.find(r=>r.id.endsWith(':'+key))?.facts.unchanged).not.toBe('true');
});
it.each([{input:'Return evidence',id:'criterion-1'},{input:['Return evidence'],id:'criterion-1'},{input:[{id:'evidence',text:'Return evidence'}],id:'evidence'}])('normalizes human-readable criteria at the bound boundary: $input',async({input,id})=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Investigate and delegate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Investigate',criteria:input,projectId:null},'readable-goal') as import('../shared/tasks').Task;
 expect(goal.criteria).toEqual([{id,text:'Return evidence',checkRef:null}]);
 const task=await manager.callBoundTool(token,'task_create',{goal:'Investigate independently',criteria:input,projectId:null},'readable-task') as import('../shared/tasks').Task;
 expect(task.criteria).toEqual(goal.criteria);
 const args={taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Find evidence',criteria:input};
 const run=await manager.callBoundTool(token,'mandala_delegate',args,'readable-delegate') as import('../shared/tasks').Run;
 expect(manager.taskService.getTask({userId:store.ownerUserId},run.taskId).criteria).toEqual(goal.criteria);
});
it('explains malformed criteria without creating a goal and points primary-chat delegation to supported routes',async()=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Investigate');const token=entries[0].token;
 await expect(manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria:[{text:42}],projectId:null},'invalid-criteria')).rejects.toThrow(/criteria/);
 expect(manager.taskService.listTasks({userId:store.ownerUserId})).toHaveLength(0);
 await expect(manager.callBoundTool(token,'delegate',{targetAgentId:'worker',request:'Find evidence'},'wrong-route')).rejects.toThrow(/mandala delegate.*messages ask/);
});
it('records a bounded operation result once after real task creation without changing execution authority',async()=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Save my task');const token=entries[0].token;
 const args={goal:'Inspect evidence',criteria:['Return evidence'],projectId:null};
 const task=await manager.callBoundTool(token,'task_create',args,'result-once') as import('../shared/tasks').Task;
 await manager.callBoundTool(token,'task_create',args,'result-once');
 const receipts=store.listEvents(chat.id,0).filter(e=>(e.data as {operationResult?:unknown}).operationResult);
 expect(receipts).toHaveLength(1);expect(receipts[0].data).toMatchObject({operationResult:{command:'task_create',state:'succeeded',kind:'task',name:'Inspect evidence',path:'/tasks/'+task.id}});
 expect(store.listConversations()).toHaveLength(1);
});
it('never replaces a successful operation outcome with a later conflicting retry after an earlier validation failure',async()=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Save my task');const token=entries[0].token;
 const args={goal:'Inspect evidence',criteria:['Return evidence'],projectId:null};
 await expect(manager.callBoundTool(token,'task_create',{...args,criteria:[42]},'corrected-result')).rejects.toThrow();
 await manager.callBoundTool(token,'task_create',args,'corrected-result');
 await manager.callBoundTool(token,'task_create',args,'corrected-result');
 await expect(manager.callBoundTool(token,'task_create',{...args,goal:'Different goal'},'corrected-result')).rejects.toThrow();
 const receipts=store.listEvents(chat.id,0).map(e=>(e.data as {operationResult?:{state:string}}).operationResult).filter(Boolean);
 expect(receipts).toHaveLength(2);expect(receipts.at(-1)?.state).toBe('succeeded');
});
it('keeps active permission denials visible without recording expired binding attempts or private target details',async()=>{
 const {manager,chat,entries,store,finish}=await setup();await manager.send(chat.id,'Update the task');const token=entries[0].token;
 const privateTask=manager.taskService.createTask({userId:store.ownerUserId,agentId:'worker'},{goal:'Private target details',assigneeAgentId:'worker'},'private-task');
 await expect(manager.callBoundTool(token,'task_update',{taskId:privateTask.id,expectedRevision:1,goal:'Update'},'denied-result')).rejects.toMatchObject({status:403});
 const receipts=()=>store.listEvents(chat.id,0).map(e=>(e.data as {operationResult?:unknown}).operationResult).filter(Boolean);
 expect(receipts()).toHaveLength(1);expect(receipts()[0]).toMatchObject({state:'failed',errorCode:'forbidden'});expect(JSON.stringify(receipts())).not.toContain('Private target details');
 finish();await expect(manager.callBoundTool(token,'task_create',{goal:'Expired',projectId:null},'expired-result')).rejects.toMatchObject({status:403});expect(receipts()).toHaveLength(1);
});
it('only current system invocation can coordinate; ordinary and temporary Agents cannot self-authorize',async()=>{
 const {manager,chat,entries,finish}=await setup();await manager.send(chat.id,'Coordinate my goal');
 const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'create') as {id:string};
 expect(manager.coordination.ownership(goal.id)?.relation).toBe('created');
 await expect(manager.callBoundTool(token,'mandala_takeover',{taskId:goal.id,expectedRevision:1,criteria,humanEventId:1},'forge')).rejects.toMatchObject({status:422});
 finish();await expect(manager.callBoundTool(token,'mandala_goals',{},'expired')).rejects.toMatchObject({status:403});
 for(const id of ['worker','temp']){const c=await manager.create('',id);await manager.send(c.id,'Coordinate');await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_goals',{},'fake')).rejects.toMatchObject({status:403});finish(entries.at(-1));}
});
it('delegates unbound work with an explicit executor using durable runs and notify receipts without completing the goal',async()=>{
 const {manager,chat,entries,finish,store}=await setup();await manager.send(chat.id,'Research my request');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Research',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Find answer',criteria},'delegate') as import('../shared/tasks').Run;
 expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id)).toMatchObject({state:'running',completion:null});
 expect((await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Find answer',criteria},'delegate') as typeof run).id).toBe(run.id);
 expect(run.continuation).toMatchObject({taskId:goal.id,conversationId:chat.id,policy:'notify'});expect(run.routing?.destinationConversationId).toBe(chat.id);
 await new Promise<void>(resolve=>setImmediate(resolve));
 for(let i=0;i<20&&entries.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
 expect(entries).toHaveLength(2);
 entries[1].options.onEvent({method:'item/completed',params:{threadId:entries[1].native,turnId:entries[1].native+'-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Evidence delivered'}}});
 finish(entries[1]);
 expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id)).toMatchObject({state:'review',completion:null});
 expect(manager.taskService.listReceipts({userId:store.ownerUserId},run.taskId).some(r=>r.taskId===goal.id&&r.destinationConversationId===chat.id)).toBe(true);
});
it('archived executors reject new sends and durable starts while historical content remains readable',async()=>{
 const {manager,home,store}=await setup();const c=await manager.create('','worker');store.appendEvent(c.id,'text',{text:'saved'});
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,agents:cfg.config.agents.map(a=>a.id==='worker'?{...a,archivedAt:new Date().toISOString()}:a)},cfg.revision);
 await expect(manager.send(c.id,'new work')).rejects.toThrow('Archived');
 const task=manager.taskService.createTask({userId:store.ownerUserId},{goal:'new task',assigneeAgentId:'worker'},'new');
 await expect(manager.startDurableTask(task.id,task.revision,'start')).rejects.toThrow('Archived');
 expect(store.listEvents(c.id,0).some(e=>(e.data as {text?:string}).text==='saved')).toBe(true);
});

it('archiving during a running turn preserves successful settlement and blocks subsequent automation',async()=>{
 const {manager,home,store,entries,finish}=await setup();const c=await manager.create('','worker');await manager.send(c.id,'Active work');
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,agents:cfg.config.agents.map(a=>a.id==='worker'?{...a,archivedAt:new Date().toISOString()}:a)},cfg.revision);
 expect(store.getConversation(c.id)?.status).toBe('running');finish(entries[0]);expect(store.getConversation(c.id)?.status).toBe('idle');
 const task=manager.taskService.createTask({userId:store.ownerUserId},{goal:'scheduled',assigneeAgentId:'worker'},'scheduled');
 await expect(manager.startAutomationTask(task.id,{id:'schedule-run',projectId:'',agentId:'worker',cli:'codex',instructions:'scheduled'} as any)).rejects.toThrow('Archived');
});

it('exposes only safe executor and project directory metadata to the bound coordinator',async()=>{
 const {manager,home,chat,entries}=await setup();const cfg=await readConfig(home);
 await writeConfig(home,{...cfg.config,projects:[{id:'p',name:'Shared',cwd:home,agentIds:['worker'],resources:[],mcp:[],skills:[]}],agents:cfg.config.agents.map(a=>a.id==='worker'?{...a,instructions:'PRIVATE INSTRUCTIONS',runtime:{codex:{env:{SECRET:'${PRIVATE_REFERENCE}'}}}}:a)},cfg.revision);
 await manager.send(chat.id,'Select an executor');
 const directory=await manager.callBoundTool(entries[0].token,'mandala_directory',{},'directory');
 expect(directory).toMatchObject({projects:[{id:'p',name:'Shared',agentIds:['worker'],available:true}],agents:expect.arrayContaining([expect.objectContaining({id:'worker',name:'worker',cli:'codex',temporary:false,available:true})])});
 expect(JSON.stringify(directory)).not.toContain('PRIVATE');expect(JSON.stringify(directory)).not.toContain('SECRET');
});

it('reads changed configuration during an active invocation and exposes actionable management fields',async()=>{
 const {manager,home,chat,entries,finish}=await setup();await manager.send(chat.id,'我的团队现在有哪些成员？');
 const token=entries[0].token, cfg=await readConfig(home);
 await writeConfig(home,{...cfg.config,agents:cfg.config.agents.map(a=>a.id==='worker'?{...a,name:'Updated worker',models:{codex:'configured-model'}}:a)},cfg.revision);
 const directory=await manager.callBoundTool(token,'mandala_directory',{},'current') as any;
 expect(directory.agents.find((a:any)=>a.id==='worker')).toMatchObject({name:'Updated worker',models:{codex:'configured-model'}});
 expect(directory.management.fields.agent).toContain('defaultCli');
 expect(directory.commands.find((c:any)=>c.name==='mandala configure').fields).toEqual(['change','mode']);
 await expect(manager.callBoundTool(token,'mandala_directory',{humanEventId:1},'forged')).rejects.toMatchObject({status:422});
 finish();await expect(manager.callBoundTool(token,'mandala_directory',{},'expired')).rejects.toMatchObject({status:403});
});

const discoveryResult:discovery.WorkDiscoveryResult={selection:{basis:'user_selected',runtimes:['omp']},generatedAt:'2026-10-30T00:00:00.000Z',windowStart:'2026-08-01T00:00:00.000Z',sources:[{runtime:'omp',status:'missing',reason:'native_store_missing',scanned:0,skipped:0,truncated:false}],candidates:[],notices:[]};
it('exposes capability discovery only to a live human coordinator and leaves configuration unchanged',async()=>{
 const discover=vi.spyOn(capabilities,'discoverTeamCapabilities').mockResolvedValue({selection:{basis:'user_selected',runtimes:['omp']},directories:[],sources:[],items:[],matched:0,truncated:false,notices:[]});
 const {manager,chat,home,entries,finish,store}=await setup();await manager.send(chat.id,'Recommend existing skills and MCP for my team');
 const token=entries[0].token,before=await readConfig(home),args={runtimes:['omp'],directories:['/work'],query:'data',limit:10};
 expect(await manager.callBoundTool(token,'mandala_discover_capabilities',args,'capabilities')).toMatchObject({items:[]});
 expect(discover).toHaveBeenCalledExactlyOnceWith(before.config,args);expect(await readConfig(home)).toEqual(before);
 await expect(manager.callBoundTool(token,'mandala_discover_capabilities',{userHome:'/secret'},'forged')).rejects.toMatchObject({status:422});
 const event=store.listEvents(chat.id,0).find(e=>e.kind==='user')!;
 store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({...event.data as object,source:{kind:'automation'}}),event.id);
 await expect(manager.callBoundTool(token,'mandala_discover_capabilities',{},'automatic')).rejects.toMatchObject({code:'human_request_required'});
 finish();await expect(manager.callBoundTool(token,'mandala_discover_capabilities',{},'expired')).rejects.toMatchObject({status:403});
 const worker=await manager.create('','worker');await manager.send(worker.id,'Discover skills');await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_discover_capabilities',{},'worker')).rejects.toMatchObject({status:403});
 finish(entries.at(-1));
 const background=store.createConversation({projectId:'',agentId:chat.agentId,cli:'codex',model:null,purpose:'mandala-background',cwd:chat.cwd});await manager.send(background.id,'Discover skills');
 await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_discover_capabilities',{},'background')).rejects.toMatchObject({status:403});
 expect(discover).toHaveBeenCalledTimes(1);
});
it('discards capability discovery when the current invocation ends during its metadata read',async()=>{
 let release!:(result:Awaited<ReturnType<typeof capabilities.discoverTeamCapabilities>>)=>void;
 const discover=vi.spyOn(capabilities,'discoverTeamCapabilities').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const {manager,chat,entries,finish}=await setup();await manager.send(chat.id,'Discover team capabilities');
 const pending=manager.callBoundTool(entries[0].token,'mandala_discover_capabilities',{},'capabilities');
 await vi.waitFor(()=>expect(discover).toHaveBeenCalledTimes(1));finish();
 release({selection:{basis:'user_selected',runtimes:['omp']},directories:[],sources:[],items:[],matched:0,truncated:false,notices:[]});
 await expect(pending).rejects.toMatchObject({status:403});
});
it('discovers only allowlisted inputs in the human main turn and adds only a bounded result without changing configuration',async()=>{
 const discover=vi.spyOn(discovery,'discoverWorkDirectories').mockResolvedValue(discoveryResult);
 const {manager,chat,home,store,entries,finish}=await setup();await manager.send(chat.id,'Plan my work using OMP');
 const before=await readConfig(home),events=store.listEvents(chat.id,0),args={runtimes:['omp'],includePaths:['/work'],excludePaths:['/work/old'],limit:10};
 expect(await manager.callBoundTool(entries[0].token,'mandala_discover_work',args,'discover')).toEqual(discoveryResult);
 expect(discover).toHaveBeenCalledExactlyOnceWith(before.config,args);
 expect(await readConfig(home)).toEqual(before);const after=store.listEvents(chat.id,0);expect(after.slice(0,events.length)).toEqual(events);expect(after).toHaveLength(events.length+1);expect(after.at(-1)?.data).toMatchObject({operationResult:{command:'mandala_discover_work',kind:'discovery',state:'succeeded'}});
 await expect(manager.callBoundTool(entries[0].token,'mandala_discover_work',{codexHome:'/forged'},'forge')).rejects.toMatchObject({status:422});
 expect(discover).toHaveBeenCalledTimes(1);
 finish();await manager.continue(chat.id,'Continue with OMP');
 expect(await manager.callBoundTool(entries.at(-1)!.token,'mandala_discover_work',{runtimes:['omp']},'continuation')).toEqual(discoveryResult);
});
it('serves a valid host planning Skill without scanning or changing the mutable Skill library',async()=>{
 const discover=vi.spyOn(discovery,'discoverWorkDirectories').mockResolvedValue(discoveryResult);
 const {manager,chat,home,store,entries,finish}=await setup();await manager.send(chat.id,'Help plan my team');
 const before=await readConfig(home),events=store.listEvents(chat.id,0);
 const guide=await manager.callBoundTool(entries[0].token,'mandala_planning_guide',{},'guide') as {name:string;description:string;content:string};
 const {parse}=await import('yaml');const frontmatter=parse(guide.content.split('---')[1]);
 expect(frontmatter).toMatchObject({name:guide.name,description:guide.description});expect(guide.name).toBeTruthy();expect(guide.description).toBeTruthy();
 expect(guide.content).toContain('business → Project/workspaces → module → Agent');
 expect(guide.content).toContain('Agent count is an outcome of module and knowledge boundaries');
 expect(guide.content).toContain('Do not claim that worker memory automatically transfers');
 expect(guide.content).not.toContain('Design the smallest useful maintained team');
 expect(discover).not.toHaveBeenCalled();expect(await readConfig(home)).toEqual(before);expect(store.listEvents(chat.id,0)).toEqual(events);
 await expect(manager.callBoundTool(entries[0].token,'mandala_planning_guide',{runtimes:['codex']},'forge')).rejects.toMatchObject({status:422});
 finish();await expect(manager.callBoundTool(entries[0].token,'mandala_planning_guide',{},'expired')).rejects.toMatchObject({status:403});
});
it('rejects ordinary, temporary, expired and background discovery callers before scanning',async()=>{
 const discover=vi.spyOn(discovery,'discoverWorkDirectories').mockResolvedValue(discoveryResult);
 const {manager,chat,entries,finish,store}=await setup();
 for(const id of ['worker','temp']){const c=await manager.create('',id);await manager.send(c.id,'Discover work');for(const tool of ['mandala_discover_work','mandala_planning_guide'])await expect(manager.callBoundTool(entries.at(-1)!.token,tool,{},'forged')).rejects.toMatchObject({status:403});finish(entries.at(-1));}
 const background=store.createConversation({projectId:'',agentId:chat.agentId,cli:'codex',model:null,purpose:'mandala-background',cwd:chat.cwd});await manager.send(background.id,'Discover work');
 await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_discover_work',{},'background')).rejects.toMatchObject({status:403});finish(entries.at(-1));
 await manager.send(chat.id,'Discover work');const token=entries.at(-1)!.token;finish(entries.at(-1));
 await expect(manager.callBoundTool(token,'mandala_discover_work',{},'expired')).rejects.toMatchObject({status:403});expect(discover).not.toHaveBeenCalled();
});
it.each([{source:{kind:'automation'}},{task:{id:'scheduled'}},{agentMessage:{id:'receipt'}},{invocationId:'old-invocation'}])('rejects automatic or mismatched current event provenance %j before scanning',async extra=>{
 const discover=vi.spyOn(discovery,'discoverWorkDirectories').mockResolvedValue(discoveryResult);
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Discover work');
 const event=store.listEvents(chat.id,0).find(e=>e.kind==='user')!;
 store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({...event.data as object,...extra}),event.id);
 await expect(manager.callBoundTool(entries[0].token,'mandala_discover_work',{},'automatic')).rejects.toMatchObject({code:'human_request_required',status:403});expect(discover).not.toHaveBeenCalled();
});
it('discards discovery results when the invocation completes during the native metadata read',async()=>{
 let release!:(result:discovery.WorkDiscoveryResult)=>void;
 const discover=vi.spyOn(discovery,'discoverWorkDirectories').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const {manager,chat,entries,finish}=await setup();await manager.send(chat.id,'Discover work');
 const pending=manager.callBoundTool(entries[0].token,'mandala_discover_work',{},'discover');
 await vi.waitFor(()=>expect(discover).toHaveBeenCalledTimes(1));finish();release(discoveryResult);
 await expect(pending).rejects.toMatchObject({status:403});
});

it('runs parallel executions on one owned task and returns both reports to its origin',async()=>{
 const {manager,chat,entries,finish,store}=await setup();await manager.send(chat.id,'Delegate two investigations');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Research',criteria,projectId:null},'parallel-goal') as import('../shared/tasks').Task;
 const args={taskId:goal.id,targetAgentId:'worker',projectId:null,request:'First investigation',criteria};
 const [first,second]=await Promise.all([manager.callBoundTool(token,'mandala_delegate',args,'first-execution'),manager.callBoundTool(token,'mandala_delegate',{...args,targetAgentId:'temp',request:'Second investigation'},'second-execution')]) as import('../shared/tasks').Run[];
 expect(first.taskId).toBe(goal.id);expect(second.taskId).toBe(goal.id);expect(first.executionId).not.toBe(second.executionId);
 expect(first.routing?.executionConversationId).not.toBe(second.routing?.executionConversationId);
 expect(manager.taskService.listTasks({userId:store.ownerUserId})).toHaveLength(1);
 await vi.waitFor(()=>expect(entries).toHaveLength(3));
 for(const entry of entries.slice(1))entry.options.onEvent({method:'item/completed',params:{threadId:entry.native,turnId:entry.native+'-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Evidence delivered'}}});
 finish(entries[1]);expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id).state).toBe('running');
 finish(entries[2]);expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id)).toMatchObject({state:'review',completion:null});
 const reports=manager.taskService.listReceipts({userId:store.ownerUserId},goal.id);
 expect(reports).toHaveLength(2);expect(reports.every(r=>r.destinationConversationId===chat.id)).toBe(true);
 await expect(manager.callBoundTool(token,'mandala_delegate',{...args,request:'Changed investigation'},'first-execution')).rejects.toMatchObject({code:'idempotency_conflict'});
});

it('retries a failed execution with its Agent and request when the task has no default executor',async()=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Investigate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Research',criteria,projectId:null},'retry-goal') as import('../shared/tasks').Task;
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Worker investigation',criteria},'retry-execution') as import('../shared/tasks').Run;
 await vi.waitFor(()=>expect(entries).toHaveLength(2));entries[1].options.onEvent({method:'turn/completed',params:{threadId:entries[1].native,turn:{id:entries[1].native+'-turn',status:'failed'}}});
 const current=manager.taskService.getTask({userId:store.ownerUserId},goal.id);expect(current.assigneeAgentId).toBeNull();
 const retry=await manager.retryTask(goal.id,current.revision,'retry-failed');
 const execution=manager.taskService.listExecutions({userId:store.ownerUserId},goal.id).find(item=>item.id===retry.executionId)!;
 expect(execution).toMatchObject({agentId:'worker',request:'Worker investigation',projectId:null});expect(retry.continuation).toEqual(run.continuation);
});

it('preserves delegation authority across repeated retries into fresh native conversations',async()=>{
 const {manager,chat,entries,store,finish}=await setup(),root={userId:store.ownerUserId};await manager.send(chat.id,'Investigate');
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Research',criteria,projectId:null},'uncertain-goal') as import('../shared/tasks').Task;
 let run=await manager.callBoundTool(entries[0].token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Worker investigation',criteria},'uncertain-worker') as import('../shared/tasks').Run;
 for(let attempt=0;attempt<2;attempt++){
  await vi.waitFor(()=>expect(entries).toHaveLength(attempt+2));manager.taskService.markUnknown(run.id);
  const previous=run;run=await manager.retryTask(goal.id,manager.taskService.getTask(root,goal.id).revision,'uncertain-retry-'+attempt);
  expect(run.routing?.executionConversationId).not.toBe(previous.routing?.executionConversationId);
  const execution=manager.taskService.getExecution(root,run.executionId);expect(execution).toMatchObject({agentId:'worker',projectId:null,request:'Worker investigation',createdByAgentId:chat.agentId});
  expect(manager.taskService.getExecution(root,previous.executionId).supersededByExecutionId).toBe(execution.id);
 }
 await vi.waitFor(()=>expect(entries).toHaveLength(4));const entry=entries[3];entry.options.onEvent({method:'item/completed',params:{threadId:entry.native,turnId:entry.native+'-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Evidence delivered'}}});finish(entry);
 expect(manager.taskService.getTask(root,goal.id)).toMatchObject({state:'review',completion:null});
 expect(store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all().length).toBeGreaterThanOrEqual(2);
});
