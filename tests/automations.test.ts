import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAutomations,nextScheduledTime} from '../server/automations';
import {openStore,type Store} from '../server/store';
import {createSessionManager,type SessionManager} from '../server/sessions';
import type {CodexOptions,CodexClient} from '../server/codex';
import type {Config} from '../shared/types';
let home:string,store:Store,service:ReturnType<typeof createAutomations>,now:Date,manager:SessionManager,config:Config;
let clients:{options:CodexOptions;texts:string[];session:string}[];
const definition=()=>({name:'Reading review',instructions:'Review personal reading notes',projectId:'reading',agentId:'reader',cli:'codex' as const,enabled:true,schedule:{kind:'daily' as const,time:'09:00',timeZone:'Asia/Singapore'}});
// Compatibility tests load the persisted shape written before explicit execution modes.
const legacyCreate=async(value:import('../shared/automations').AutomationInput)=>{
 await service.list();const id=crypto.randomUUID();
 const taskId=value.taskId??(!value.goalId?manager.taskService.createTask({userId:'local'},{goal:value.instructions,projectId:value.projectId||null,assigneeAgentId:value.agentId||null},'legacy-task:'+id).id:undefined);
 const a:import('../shared/automations').Automation={...value,...(taskId?{taskId}:{}),...(value.overlapPolicy==='coalesce'&&value.missedPolicy===undefined?{missedPolicy:'latest'}:{}),enabled:false,id,revision:1,createdAt:now.toISOString(),updatedAt:now.toISOString(),nextRunAt:nextScheduledTime(value.schedule,now)};
 store.database.prepare('INSERT INTO automation_rules VALUES (?,1,0,?)').run(id,JSON.stringify(a));return a;
};
const enable=async(a:{id:string;revision:number})=>service.update(a.id,{expectedRevision:a.revision,enabled:true});
const restart=()=>{service.close();service=createAutomations({home,store,manager,loadConfig:async()=>config,now:()=>now});};
const terminal=(index:number,status='completed',text='Done')=>{const c=clients[index],turn=c.texts.length>1?`turn${c.texts.length}`:'turn';c.options.onEvent({method:'item/completed',params:{threadId:c.session,turnId:turn,item:{id:'reply',type:'agentMessage',phase:'final_answer',text}}});c.options.onEvent({method:'turn/completed',params:{threadId:c.session,turn:{id:turn,status}}});};
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'mana-automations-'));store=openStore(home);now=new Date('2026-10-01T00:00:00Z');clients=[];
 config={runtimes:['codex','omp'],version:2,projects:[{id:'reading',name:'Reading',cwd:home,agentIds:['reader'],resources:[],mcp:[],skills:[]}],agents:[{id:'reader',name:'Reader',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]};
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{const c={options,texts:[] as string[],session:`s${clients.length}`};clients.push(c);return{getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=>c.session,resumeThread:async()=>{},startTurn:async(_,text)=>{c.texts.push(text);return c.texts.length>1?`turn${c.texts.length}`:'turn';},interrupt:async()=>{terminal(clients.indexOf(c),'interrupted','');},replyApproval(){},close(){}};};
 manager=createSessionManager(store,async()=>config,factory,factory,home);service=createAutomations({home,store,manager,loadConfig:async()=>config,now:()=>now});
});
afterEach(async()=>{service.close();await manager.close();store.close();rmSync(home,{recursive:true,force:true});});
it('dispatches current UTC minute despite jitter, deduplicates concurrent scans and restart',async()=>{
 const a=await enable(await legacyCreate(definition()));now=new Date('2026-10-01T01:00:45Z');await Promise.all([service.tick(),service.tick()]);await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
 const first=(await service.list()).runs[0];expect(first).toMatchObject({automationId:a.id,status:'running',ruleRevision:2});expect(first.taskId).toBeTruthy();restart();await service.tick();expect((await service.list()).runs).toHaveLength(1);expect(clients).toHaveLength(1);
});
it('older due minutes become missed without automatic catch-up; explicit catchup is once',async()=>{
 await enable(await legacyCreate(definition()));now=new Date('2026-10-04T01:01:00Z');await service.tick();const state=await service.list();expect(state.runs).toHaveLength(4);expect(state.runs.every(r=>r.status==='missed'&&!r.taskId)).toBe(true);expect(clients).toEqual([]);
 const one=await service.catchUp(state.runs[0].id,'explicit-catchup');const two=await service.catchUp(state.runs[0].id,'explicit-catchup');expect(one.taskId).toBe(two.taskId);await service.tick();await vi.waitFor(()=>expect(clients).toHaveLength(1));
});
it('pause and archive keep accepted tasks and frozen rule inputs',async()=>{
 const a=await legacyCreate(definition());const first=await service.runNow(a.id,'manual-1');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));const second=await service.runNow(a.id,'manual-2');
 const updated=await service.update(a.id,{expectedRevision:a.revision,enabled:false,instructions:'New instructions',cli:'omp'});await service.remove(a.id,updated.revision);terminal(0);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toEqual([definition().instructions]));
 const state=await service.list();expect(state.automations).toEqual([]);expect(state.runs.map(r=>r.taskId)).toEqual([first.taskId,second.taskId]);expect(state.runs[1].instructions).toBe(definition().instructions);
});
it('canonical native terminal is independent of conversation idle and missing delivery',async()=>{
 const a=await legacyCreate(definition());await service.runNow(a.id);await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));const r=(await service.list()).runs[0];store.updateConversation(r.conversationId!,{status:'idle'});await service.tick();expect((await service.list()).runs[0].status).toBe('running');terminal(0,'completed','');expect((await service.list()).runs[0]).toMatchObject({status:'succeeded',taskState:'waiting',waitingReason:'delivery_missing'});
});
it('failed native attempt is never automatically retried and stop targets one task',async()=>{
 const a=await legacyCreate(definition());await service.runNow(a.id);await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0,'failed','');await service.tick();restart();await service.tick();expect(clients).toHaveLength(1);expect((await service.list()).runs[0].status).toBe('failed');
 await service.runNow(a.id);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));const r=(await service.list()).runs[1];await service.stopRun(r.id);expect((await service.list()).runs[1].status).toBe('interrupted');
});
it('stale rule edit/remove conflicts and manual command keys are separate from UTC occurrence identity',async()=>{
 const a=await legacyCreate(definition());const b=await service.update(a.id,{expectedRevision:1,name:'Renamed'});await expect(service.update(a.id,{expectedRevision:1,name:'Stale'})).rejects.toMatchObject({status:409});await expect(service.remove(a.id,1)).rejects.toMatchObject({status:409});
 const one=await service.runNow(a.id,'click-1'),again=await service.runNow(a.id,'click-1'),two=await service.runNow(a.id,'click-2');expect(one.taskId).toBe(again.taskId);expect(two.taskId).toBe(one.taskId);expect(two.id).not.toBe(one.id);expect(b.revision).toBe(2);
});
it('imports legacy raw/history once as unverified and never replays former queued work',async()=>{
 await service.list();service.close();store.database.prepare("DELETE FROM schema_migrations WHERE key='durable_tasks_005_automations'").run();
 const legacy={version:1,automations:[{...definition(),id:'legacy',createdAt:now.toISOString(),updatedAt:now.toISOString(),nextRunAt:'2026-10-01T01:00:00.000Z'}],runs:[{id:'old-run',automationId:'legacy',name:'Old',status:'queued',instructions:'Never resend',scheduledAt:now.toISOString(),createdAt:now.toISOString()}]};const raw=JSON.stringify(legacy);writeFileSync(join(home,'automations.json'),raw);restart();const state=await service.list();expect(state.runs[0]).toMatchObject({id:'old-run',status:'legacy_unverified',legacyStatus:'queued'});await service.tick();expect(clients).toEqual([]);writeFileSync(join(home,'automations.json'),'changed by legacy editor');restart();expect((await service.list()).runs).toHaveLength(1);expect(store.database.prepare('SELECT raw FROM automation_legacy_import').get()!.raw).toBe(raw);expect(readFileSync(join(home,'automations.json'),'utf8')).toBe('changed by legacy editor');
});
it('recurrence skips spring missing slot and uses first autumn fold once',()=>{
 expect(nextScheduledTime({kind:'daily',time:'02:30',timeZone:'America/New_York'},new Date('2026-03-08T06:00:00Z'))).toBe('2026-03-09T06:30:00.000Z');
 const schedule={kind:'daily' as const,time:'01:30',timeZone:'America/New_York'};const first=nextScheduledTime(schedule,new Date('2026-11-01T00:00:00Z'));expect(first).toBe('2026-11-01T05:30:00.000Z');expect(nextScheduledTime(schedule,new Date(first!),first!)).toBe('2026-11-02T06:30:00.000Z');
 expect(nextScheduledTime({kind:'weekly',time:'09:00',timeZone:'Asia/Singapore',weekday:1},now)).toBe('2026-10-05T01:00:00.000Z');
});
it('rejects invalid bindings, schedules and disabled runtimes without a rule',async()=>{
 for(const patch of [{agentId:'missing'},{projectId:'missing'},{cli:'unknown'},{schedule:{kind:'daily',time:'25:00',timeZone:'Asia/Singapore'}}])await expect(service.create({...definition(),...patch})).rejects.toThrow();config.runtimes=['omp'];await expect(service.create(definition())).rejects.toThrow();expect((await service.list()).automations).toEqual([]);
});
it('preparation failure is exposed without repeated native preparation',async()=>{
 const a=await legacyCreate(definition());await service.runNow(a.id);const spy=vi.spyOn(manager,'startAutomationTask').mockRejectedValue(new Error('hidden sensitive context'));await service.tick();await service.tick();expect(spy).toHaveBeenCalledTimes(1);expect((await service.list()).runs[0].status).toBe('unknown');
});
it('stopping an accepted occurrence before Run creation prevents later dispatch',async()=>{const a=await legacyCreate(definition());const pending=await service.runNow(a.id);await service.stopRun(pending.id);await service.tick();expect(clients).toEqual([]);expect((await service.list()).runs[0].status).toBe('interrupted');});
it('consecutive DST scans and restart retain one actual UTC occurrence',async()=>{now=new Date('2026-11-01T04:00:00Z');await enable(await legacyCreate({...definition(),schedule:{kind:'daily',time:'01:30',timeZone:'America/New_York'}}));now=new Date('2026-11-01T05:30:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);now=new Date('2026-11-01T06:30:00Z');restart();await service.tick();expect((await service.list()).runs).toHaveLength(1);expect((await service.list()).automations[0].nextRunAt).toBe('2026-11-02T06:30:00.000Z');});
it('Task and occurrence commit or roll back together',async()=>{const a=await legacyCreate(definition());store.database.exec("CREATE TRIGGER reject_occurrence BEFORE INSERT ON automation_occurrences BEGIN SELECT RAISE(ABORT,'crash transaction'); END");await expect(service.runNow(a.id)).rejects.toThrow();expect(store.database.prepare('SELECT COUNT(*) n FROM work_tasks').get()!.n).toBe(1);expect(store.database.prepare("SELECT COUNT(*) n FROM outbox WHERE type='task.created'").get()!.n).toBe(1);});
it('real HTTP revision commands update once and return409 on stale PATCH and DELETE',async()=>{
 const {createHttpServer}=await import('../server/http');const server=createHttpServer({requireIdentity:false,home,store,manager,automations:service});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}/api/automations`;
 try{const a=await legacyCreate(definition());const request=(method:string,body:unknown)=>fetch(`${base}/${a.id}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});expect((await request('PATCH',{expectedRevision:1,name:'Updated'})).status).toBe(200);expect((await request('PATCH',{expectedRevision:1,name:'Stale'})).status).toBe(409);expect((await request('DELETE',{expectedRevision:1})).status).toBe(409);expect((await request('DELETE',{expectedRevision:2})).status).toBe(200);expect((await service.list()).automations).toEqual([]);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('manual run while paused executes once without re-enabling future scheduling',async()=>{const a=await enable(await legacyCreate(definition()));now=new Date('2026-10-01T01:01:00Z');await service.tick();const missed=(await service.list()).runs[0];const paused=await service.update(a.id,{expectedRevision:a.revision,enabled:false});const manual=await service.runNow(a.id,'paused-manual-command');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toEqual([definition().instructions]));terminal(0);now=new Date('2026-10-02T01:00:00Z');await service.tick();const state=await service.list();expect(state.automations[0]).toMatchObject({enabled:false,revision:paused.revision,nextRunAt:paused.nextRunAt});expect(state.runs).toHaveLength(2);expect(state.runs[0]).toEqual(missed);expect(state.runs[1].taskId).toBe(manual.taskId);expect(clients).toHaveLength(1);});
it.each(['source','output'] as const)('F1 Asset-backed %s history retains metadata and controls after source withdrawal',async(kind)=>{
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files'),{createTasks}=await import('../server/tasks');const files=createAssetFiles(home),assets=createAssets(store,files),root={userId:'local'},agent={...root,agentId:'reader'};
 writeFileSync(join(home,'evidence.txt'),'restricted evidence');const source=assets.createAsset(root,{kind:'file',title:'Source',owner:root});const staged=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'evidence.txt',manifestPath:'evidence.txt'}]);const v=assets.publishAssetVersion(root,{assetId:source.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{sourceVersions:[]}},'evidence');assets.setAccess(root,source.id,{mode:'all'},2);
 const a=await legacyCreate(definition()),occurrence=await service.runNow(a.id);const destination=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null});
 const tasks=createTasks(store,{assets,resolve:()=>({agentId:'reader',projectId:'reading',hostId:'local',input:'input',sourceVersions:kind==='source'?[{assetId:source.id,versionId:v.id}]:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});const task=tasks.getTask(root,occurrence.taskId!),prepared=tasks.prepareStart(root,task.id,task.revision,'asset-run'),run=store.transaction(()=>prepared.commit({executionConversationId:destination.id,mode:'dedicated',destinationConversationId:null}));
 const occurrenceData=JSON.parse(store.database.prepare('SELECT data FROM automation_occurrences WHERE id=?').get(occurrence.id)!.data as string);store.database.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify({...occurrenceData,runId:run.id}),occurrence.id);
 let outputs:{assetId:string;versionId:string}[]=[];
 if(kind==='output'){const stagedOutput=await files.stageFiles({...agent,runId:run.id},run.id,[{allowedRoot:home,relativePath:'evidence.txt',manifestPath:'evidence.txt'}]);const result=assets.importAsset({...agent,runId:run.id},{kind:'file',title:'Output',agentId:'reader',submissionId:stagedOutput.submissionId,sourceVersions:[{assetId:source.id,versionId:v.id}]},'output');outputs=[{assetId:result.asset.id,versionId:result.version.id}];}
 const identity={runId:run.id,hostId:'local',nativeSessionId:'history-session',nativeTurnId:'history-turn'};tasks.bindRunIdentity(identity);tasks.applyRunEvent({...identity,eventKey:'terminal:history',outcome:'succeeded',summary:'restricted terminal body',artifactVersions:outputs});
 expect((await service.list()).runs[0]).toMatchObject({status:'succeeded',taskId:task.id});
 const current=assets.getAuthorizedAsset(root,source.id);assets.setAccess(root,source.id,{mode:'private'},current.revision);
 expect(()=>tasks.getRun({...agent,runId:run.id},run.id)).toThrow();expect(()=>tasks.listReceipts({...agent,runId:run.id},task.id)).toThrow();
 restart();const projected=(await service.list()).runs[0];expect(projected).toMatchObject({status:'succeeded',taskId:task.id});expect(JSON.stringify(projected)).not.toContain('restricted terminal body');expect(projected).not.toHaveProperty('artifactVersions');await expect(service.stopRun(occurrence.id)).resolves.toMatchObject({status:'succeeded'});await service.update(a.id,{expectedRevision:1,enabled:false});await service.remove(a.id,2);expect((await service.list()).runs).toHaveLength(1);
});

it('saving a rule is disabled and two manual occurrences retain one goal with exact run history',async()=>{
 const a=await legacyCreate(definition());expect(a.enabled).toBe(false);expect(a.taskId).toBeTruthy();await service.tick();expect(clients).toEqual([]);
 const one=await service.runNow(a.id,'stable-one');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 const two=await service.runNow(a.id,'stable-two');expect(two.taskId).toBe(one.taskId);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));
 const runs=(await service.list()).runs;expect(runs[0].runId).not.toBe(runs[1].runId);expect(runs[0].status).toBe('succeeded');expect(runs[1].status).toBe('running');
});
it('disabled rule can be saved without bindings and cannot start until assigned',async()=>{const a=await legacyCreate({...definition(),projectId:'',agentId:''});expect(a).toMatchObject({enabled:false});expect(clients).toEqual([]);await expect(service.update(a.id,{expectedRevision:a.revision,enabled:true})).rejects.toMatchObject({code:'assignee_required'});await expect(service.runNow(a.id)).rejects.toMatchObject({code:'assignee_required'});});
it('two scheduled dates retain one Task and exact immutable goal/rule snapshots',async()=>{const a=await enable(await legacyCreate(definition()));now=new Date('2026-10-01T01:00:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);const first=(await service.list()).runs[0];const original=manager.taskService.getRun({userId:'local'},first.runId!);expect(original.snapshot).toMatchObject({goal:definition().instructions,rule:{automationId:a.id,revision:2}});await service.update(a.id,{expectedRevision:a.revision,name:'Revised rule'});now=new Date('2026-10-02T01:00:00Z');await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));const runs=(await service.list()).runs;expect(runs.map(r=>r.taskId)).toEqual([a.taskId,a.taskId]);const executions=manager.taskService.getTask({userId:'local'},a.taskId!).executions;expect(executions).toHaveLength(2);expect(new Set(executions.map(e=>e.conversationId)).size).toBe(2);expect(new Set(executions.map(e=>e.latestRun?.id)).size).toBe(2);expect(runs[0].status).toBe('succeeded');expect(manager.taskService.getRun({userId:'local'},first.runId!).snapshot).toEqual(original.snapshot);expect(manager.taskService.getRun({userId:'local'},runs[1].runId!).snapshot?.rule?.revision).toBe(3);});
it('a busy selected conversation stays untouched while a fresh execution waits for workspace admission',async()=>{const c=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null});await manager.send(c.id,'User work');await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));const a=await legacyCreate({...definition(),conversationId:c.id});const occurrence=await service.runNow(a.id);await service.tick();await new Promise<void>(resolve=>setImmediate(resolve));expect(clients[0].texts).toEqual(['User work']);const pending=(await service.list()).runs[0];expect(pending).toMatchObject({status:'queued'});expect(pending.conversationId).not.toBe(c.id);await service.stopRun(occurrence.id);terminal(0);await service.tick();expect(clients[0].texts).toHaveLength(1);expect((await service.list()).automations[0].enabled).toBe(false);});
it('human acceptance completes only the current periodic execution and next date remains enabled',async()=>{const a=await enable(await legacyCreate(definition()));now=new Date('2026-10-01T01:00:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);const t=manager.taskService.getTask({userId:'local'},a.taskId!),run=(await service.list()).runs[0];expect(t.state).toBe('review');const accepted=manager.taskService.userCommand({userId:'local'},t.id,t.revision,'accept');expect(accepted.state).toBe('todo');expect(manager.taskService.getRun({userId:'local'},run.runId!).completion?.completedBy).toBe('user');expect((await service.list()).automations[0]).toMatchObject({enabled:true,nextRunAt:'2026-10-02T01:00:00.000Z'});});
it('upgrade binds an already-dispatched legacy occurrence to its exact Run and never replays it',async()=>{const a=await legacyCreate(definition());await service.runNow(a.id);await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);const old=(await service.list()).runs[0];const row=store.database.prepare('SELECT data FROM automation_occurrences WHERE id=?').get(old.id)!;const data=JSON.parse(row.data as string);delete data.runId;store.database.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify(data),old.id);const ruleData={...a};delete ruleData.taskId;store.database.prepare('UPDATE automation_rules SET data=? WHERE id=?').run(JSON.stringify(ruleData),a.id);store.database.prepare('UPDATE task_command_dedup SET command_key=? WHERE run_id=?').run(`dispatch:${old.taskId}`,old.runId!);store.database.prepare("DELETE FROM schema_migrations WHERE key='task_execution_003_legacy_run_links'").run();restart();expect(JSON.parse(store.database.prepare('SELECT data FROM automation_occurrences WHERE id=?').get(old.id)!.data as string).runId).toBe(old.runId);await service.tick();expect(clients).toHaveLength(1);expect((await service.list()).runs[0]).toMatchObject({runId:old.runId,status:'succeeded'});});
it('Task goal is authoritative after editing and occurrence input matches its frozen goal',async()=>{const a=await legacyCreate(definition());const task=manager.taskService.getTask({userId:'local'},a.taskId!);manager.taskService.updateTask({userId:'local'},task.id,task.revision,{goal:'New authoritative goal'},'edit-goal');await service.runNow(a.id);await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toEqual(['New authoritative goal']));const occurrence=(await service.list()).runs[0];expect(occurrence.instructions).toBe('New authoritative goal');expect(manager.taskService.getRun({userId:'local'},occurrence.runId!).snapshot?.goal).toBe('New authoritative goal');});
it('binding drift pauses future scheduling without running under an obsolete assignee',async()=>{const a=await enable(await legacyCreate(definition()));const task=manager.taskService.getTask({userId:'local'},a.taskId!);manager.taskService.updateTask({userId:'local'},task.id,task.revision,{assigneeAgentId:null},'unassign');now=new Date('2026-10-01T01:00:00Z');await service.tick();expect((await service.list()).automations[0].enabled).toBe(false);expect(clients).toEqual([]);await expect(service.runNow(a.id)).rejects.toMatchObject({code:'rule_task_binding_conflict'});});
it('replays a keyed create after lost acknowledgement and restart without another task or rule',async()=>{
 const body=definition(),first=await service.create(body,'create-receipt');
 restart();const replay=await service.create(body,'create-receipt');
 expect(replay).toEqual(first);expect(first.enabled).toBe(false);
 expect((await service.list()).automations).toHaveLength(1);
 expect(store.database.prepare('SELECT count(*) AS count FROM work_tasks').get()?.count).toBe(0);
 await expect(service.create({...body,name:'Different'},'create-receipt')).rejects.toMatchObject({status:409,code:'idempotency_conflict'});
});
it('keeps keyed manual Run occurrence stable across retry and restart',async()=>{
 const a=await legacyCreate(definition()),first=await service.runNow(a.id,'run-receipt');
 restart();expect(await service.runNow(a.id,'run-receipt')).toEqual(first);
 expect((await service.list()).runs).toHaveLength(1);
 const b=await legacyCreate({...definition(),name:'Another'});
 await expect(service.runNow(b.id,'run-receipt')).rejects.toMatchObject({status:409,code:'idempotency_conflict'});
});
it('rejects invalid optional creation and Run command keys before mutation',async()=>{
 await expect(service.create(definition(),'')).rejects.toMatchObject({status:422});
 await expect(service.create(definition(),'x'.repeat(201))).rejects.toMatchObject({status:422});
 const a=await service.create(definition());
 await expect(service.runNow(a.id,'bad key')).rejects.toMatchObject({status:422});
 expect((await service.list()).runs).toHaveLength(0);
});

it('interval recurrence stays anchored across restarts and rejects invalid cadence',()=>{
 const schedule={kind:'interval' as const,minutes:15,anchor:'2026-10-01T00:00:00.000Z'};
 expect(nextScheduledTime(schedule,new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01T00:15:00.000Z');
 expect(nextScheduledTime(schedule,new Date('2026-10-03T02:07:21Z'))).toBe('2026-10-03T02:15:00.000Z');
 expect(nextScheduledTime(schedule,new Date('2026-09-30T23:50:00Z'))).toBe(schedule.anchor);
 for(const minutes of [0,-1,0.5,NaN,525601])expect(()=>nextScheduledTime({...schedule,minutes},now)).toThrow('invalid schedule');
 expect(()=>nextScheduledTime({...schedule,anchor:'tomorrow'},now)).toThrow('invalid schedule');
});

it('cancelled scheduled goals do not mint later occurrences or restart queued work',async()=>{
 const a=await enable(await legacyCreate({...definition(),schedule:{kind:'interval',minutes:5,anchor:now.toISOString()}}));
 const pending=await service.runNow(a.id,'before-cancel');
 const task=manager.taskService.getTask({userId:'local'},a.taskId!);
 await manager.stopDurableTask(task.id,task.revision,true);
 now=new Date('2026-10-01T01:00:00Z');restart();await service.tick();
 const state=await service.list();expect(state.runs).toHaveLength(1);expect(state.runs[0].id).toBe(pending.id);expect(state.automations[0].enabled).toBe(false);expect(clients).toHaveLength(0);
 await expect(service.runNow(a.id,'after-cancel')).rejects.toMatchObject({code:'goal_not_active'});
});
it('scheduled durable input remains visibly nonhuman',async()=>{
 const a=await legacyCreate(definition());await service.runNow(a.id,'origin');await service.tick();
 await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
 const run=(await service.list()).runs[0],event=store.listEvents(run.conversationId!,0).find(e=>e.kind==='user');
 expect(event?.data).toMatchObject({source:{kind:'schedule',automationId:a.id},task:{kind:'dispatch'}});
});
const interval=()=>({kind:'interval' as const,minutes:5,anchor:now.toISOString()});
it('latest missed policy jumps long downtime to one latest due occurrence',async()=>{
 await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'latest'}));
 now=new Date('2030-10-01T01:02:00Z');restart();await service.tick();
 const state=await service.list();expect(state.runs).toHaveLength(1);expect(state.runs[0].scheduledAt).toBe('2030-10-01T01:00:00.000Z');expect(state.automations[0].nextRunAt).toBe('2030-10-01T01:05:00.000Z');
 await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
});
it('each missed policy materializes bounded batches without dropping the durable cursor',async()=>{
 await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'each'}));
 now=new Date('2026-10-02T00:00:00Z');await service.tick();let state=await service.list();
 expect(state.runs).toHaveLength(100);expect(state.automations[0].nextRunAt).toBe('2026-10-01T08:25:00.000Z');expect(state.automations[0].catchingUp).toBe(true);
 restart();await service.tick();state=await service.list();expect(state.runs).toHaveLength(200);expect(state.runs.filter(r=>r.status==='missed')).toHaveLength(0);
 await service.tick();state=await service.list();expect(state.runs).toHaveLength(288);expect(state.automations[0].catchingUp).toBe(false);
});
it('coalesced monitors retain one pending coverage range through restart and pause',async()=>{
 const a=await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'latest',overlapPolicy:'coalesce'}));
 now=new Date('2026-10-01T00:05:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
 now=new Date('2026-10-01T01:00:00Z');await service.tick();now=new Date('2026-10-01T02:00:00Z');restart();await service.tick();
 let state=await service.list();expect(state.runs).toHaveLength(2);expect(state.runs[1]).toMatchObject({scheduledAt:'2026-10-01T01:00:00.000Z',coverage:{firstDueAt:'2026-10-01T00:10:00.000Z',latestDueAt:'2026-10-01T02:00:00.000Z',count:23}});
 await service.update(a.id,{expectedRevision:a.revision,enabled:false});terminal(0);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));
 now=new Date('2026-10-02T00:00:00Z');await service.tick();expect((await service.list()).runs).toHaveLength(2);
});
it('manual coalescing retains one missed range and contradictory each policy is rejected',async()=>{
 await expect(service.create({...definition(),schedule:interval(),missedPolicy:'each',overlapPolicy:'coalesce'})).rejects.toThrow();
 await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'manual',overlapPolicy:'coalesce'}));
 now=new Date('2026-10-02T00:01:00Z');await service.tick();restart();now=new Date('2026-10-03T00:01:00Z');await service.tick();
 const state=await service.list();expect(state.runs).toHaveLength(1);expect(state.runs[0]).toMatchObject({status:'missed',coverage:{count:576}});expect(clients).toHaveLength(0);
 await service.catchUp(state.runs[0].id,'catch-range');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
});
it('calendar latest policy skips offline history and preserves first DST fold',async()=>{
 now=new Date('2020-01-01T00:00:00Z');await enable(await legacyCreate({...definition(),schedule:{kind:'daily',time:'01:30',timeZone:'America/New_York'},missedPolicy:'latest'}));
 now=new Date('2026-11-01T06:45:00Z');await service.tick();const state=await service.list();expect(state.runs).toHaveLength(1);expect(state.runs[0].scheduledAt).toBe('2026-11-01T05:30:00.000Z');expect(state.automations[0].nextRunAt).toBe('2026-11-02T06:30:00.000Z');
});
it('coalescing never mutates a frozen Run and pending check uses the current goal at dispatch',async()=>{
 await enable(await legacyCreate({...definition(),schedule:interval(),overlapPolicy:'coalesce'}));
 now=new Date('2026-10-01T00:05:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
 const first=(await service.list()).runs[0],snapshot=manager.taskService.getRun({userId:'local'},first.runId!).snapshot;
 now=new Date('2026-10-01T00:10:00Z');await service.tick();now=new Date('2026-10-01T00:20:00Z');await service.tick();
 const task=manager.taskService.getTask({userId:'local'},first.taskId!);manager.taskService.updateTask({userId:'local'},task.id,task.revision,{goal:'Check the current state'},'fresh-monitor');
 expect(manager.taskService.getRun({userId:'local'},first.runId!).snapshot).toEqual(snapshot);terminal(0);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toEqual(['Check the current state']));
});
it('manual missed catch-up rejects a cancelled target without another Task or Run',async()=>{
 const a=await enable(await legacyCreate(definition()));now=new Date('2026-10-01T01:01:00Z');await service.tick();
 const missed=(await service.list()).runs[0],task=manager.taskService.getTask({userId:'local'},a.taskId!);await manager.stopDurableTask(task.id,task.revision,true);
 await expect(service.catchUp(missed.id,'cancelled-catch-up')).rejects.toMatchObject({code:'goal_not_active'});expect(clients).toHaveLength(0);
});
it('pause restart and resume preserve more than one bounded batch of pre-pause work without accepting the paused window',async()=>{
 const a=await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'each'}));
 now=new Date('2026-10-02T00:00:00Z');await service.tick();await service.update(a.id,{expectedRevision:a.revision,enabled:false});
 now=new Date('2026-10-03T00:00:00Z');restart();await service.tick();let state=await service.list();expect(state.runs).toHaveLength(200);expect(state.automations[0]).toMatchObject({enabled:false,catchingUp:true,pendingThroughAt:'2026-10-02T00:00:00.000Z'});
 await service.update(a.id,{expectedRevision:state.automations[0].revision,enabled:true});await service.tick();state=await service.list();expect(state.runs).toHaveLength(288);expect(state.automations[0].nextRunAt).toBe('2026-10-03T00:05:00.000Z');expect(state.automations[0].catchingUp).toBe(false);
 expect(state.runs.every(r=>Date.parse(r.scheduledAt)<=Date.parse('2026-10-02T00:00:00Z'))).toBe(true);
 await expect(service.update(a.id,{expectedRevision:state.automations[0].revision,pendingThroughAt:now.toISOString()})).rejects.toThrow('invalid automation');
});
it('rapid pause resume windows preserve every enabled occurrence while old backlog is still draining',async()=>{
 let rule=await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'each'}));
 now=new Date('2026-10-02T00:00:00Z');await service.tick();rule=await service.update(rule.id,{expectedRevision:rule.revision,enabled:false});
 now=new Date('2026-10-03T00:00:00Z');rule=await service.update(rule.id,{expectedRevision:rule.revision,enabled:true});
 now=new Date('2026-10-03T01:00:00Z');rule=await service.update(rule.id,{expectedRevision:rule.revision,enabled:false});
 now=new Date('2026-10-04T00:00:00Z');restart();rule=await service.update(rule.id,{expectedRevision:rule.revision,enabled:true});
 await service.tick();expect((await service.list()).runs).toHaveLength(200);await service.tick();const state=await service.list();expect(state.runs).toHaveLength(300);
 expect(state.runs.filter(r=>r.scheduledAt>'2026-10-02T00:00:00.000Z').map(r=>r.scheduledAt)).toEqual(Array.from({length:12},(_,i)=>new Date(Date.parse('2026-10-03T00:00:00Z')+(i+1)*300000).toISOString()));
 expect(state.automations[0]).toMatchObject({enabled:true,catchingUp:false,nextRunAt:'2026-10-04T00:05:00.000Z'});
});
it('cancellation wins over frozen backlog windows after restart',async()=>{
 const rule=await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'each'}));now=new Date('2026-10-02T00:00:00Z');await service.tick();await service.update(rule.id,{expectedRevision:rule.revision,enabled:false});
 await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));const task=manager.taskService.getTask({userId:'local'},rule.taskId!);await manager.stopDurableTask(task.id,task.revision,true);
 restart();await service.tick();const state=await service.list();expect(state.runs).toHaveLength(100);expect(state.automations[0]).toMatchObject({enabled:false,catchingUp:false});expect(clients).toHaveLength(1);
});
it('latest policy across paused backlog windows runs only the newest enabled occurrence',async()=>{
 let rule=await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'latest'}));now=new Date('2026-10-02T00:00:00Z');rule=await service.update(rule.id,{expectedRevision:rule.revision,enabled:false});
 now=new Date('2026-10-03T00:00:00Z');rule=await service.update(rule.id,{expectedRevision:rule.revision,enabled:true});now=new Date('2026-10-03T01:00:00Z');await service.update(rule.id,{expectedRevision:rule.revision,enabled:false});restart();await service.tick();
 const state=await service.list();expect(state.runs).toHaveLength(1);expect(state.runs[0].scheduledAt).toBe('2026-10-03T01:00:00.000Z');
});
it('an existing manually running Task keeps its scheduled occurrence queued until its Run settles',async()=>{
 const a=await legacyCreate(definition()),task=manager.taskService.getTask({userId:'local'},a.taskId!);
 await manager.startDurableTask(task.id,task.revision,'manual-task-start');await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
 await service.runNow(a.id,'schedule-after-manual');await service.tick();expect((await service.list()).runs[0].status).toBe('queued');
 terminal(0);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));
});
it.each(['conversation','workspace'] as const)('coalesces a real queued Run behind busy %s admission without changing its snapshot',async(admission)=>{
 const busy=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null});
 await manager.send(busy.id,'User work');await vi.waitFor(()=>expect(clients[0]?.texts).toEqual(['User work']));
 await enable(await legacyCreate({...definition(),...(admission==='conversation'?{conversationId:busy.id}:{}),schedule:interval(),missedPolicy:'latest',overlapPolicy:'coalesce'}));
 now=new Date('2026-10-01T00:05:00Z');await service.tick();
 const first=(await service.list()).runs[0],run=manager.taskService.getRun({userId:'local'},first.runId!);
 expect(run.state).toBe('queued');expect(clients.flatMap(c=>c.texts)).toEqual(['User work']);
 const snapshot=structuredClone(run.snapshot),context=structuredClone(manager.taskService.getContextSnapshot({userId:'local'},run.id));
 now=new Date('2026-10-01T00:20:00Z');await service.tick();restart();now=new Date('2026-10-01T00:30:00Z');await service.tick();
 const pending=(await service.list()).runs;expect(pending).toHaveLength(1);expect(pending[0]).toMatchObject({id:first.id,runId:run.id,status:'queued',scheduledAt:'2026-10-01T00:05:00.000Z',coverage:{firstDueAt:'2026-10-01T00:05:00.000Z',latestDueAt:'2026-10-01T00:30:00.000Z',count:6}});
 expect(manager.taskService.listRuns({userId:'local'},first.taskId!)).toHaveLength(1);expect(manager.taskService.getRun({userId:'local'},run.id).snapshot).toEqual(snapshot);expect(manager.taskService.getContextSnapshot({userId:'local'},run.id)).toEqual(context);
 terminal(0);await vi.waitFor(()=>expect(clients.flatMap(c=>c.texts).filter(text=>text===definition().instructions)).toHaveLength(1),{timeout:5000});
 await service.tick();expect((await service.list()).runs).toHaveLength(1);expect(clients.flatMap(c=>c.texts)).toHaveLength(2);
});
it.each(['starting','running','approval','unknown'] as const)('coalescing keeps at most one follow-up behind a %s Run',async(state)=>{
 await enable(await legacyCreate({...definition(),schedule:interval(),missedPolicy:'latest',overlapPolicy:'coalesce'}));
 now=new Date('2026-10-01T00:05:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1),{timeout:5000});
 const first=(await service.list()).runs[0],snapshot=structuredClone(manager.taskService.getRun({userId:'local'},first.runId!).snapshot);
 // Persist the lifecycle fixture on the real Run; native transport remains held.
 store.database.prepare('UPDATE task_runs SET state=? WHERE id=?').run(state,first.runId!);
 now=new Date('2026-10-01T00:10:00Z');await service.tick();restart();now=new Date('2026-10-01T00:30:00Z');await service.tick();
 const runs=(await service.list()).runs;expect(runs).toHaveLength(2);expect(runs[0]).toMatchObject({id:first.id,runId:first.runId,status:state,coverage:{count:1}});expect(runs[1]).toMatchObject({status:'queued',coverage:{firstDueAt:'2026-10-01T00:10:00.000Z',latestDueAt:'2026-10-01T00:30:00.000Z',count:5}});expect(runs[1].runId).toBeUndefined();
 expect(manager.taskService.getRun({userId:'local'},first.runId!).snapshot).toEqual(snapshot);expect(manager.taskService.listRuns({userId:'local'},first.taskId!)).toHaveLength(1);expect(clients.flatMap(c=>c.texts)).toHaveLength(1);
});

it('new standalone schedules retain one target Task with fresh execution conversations',async()=>{
 const a=await enable(await service.create(definition()));
 expect(a).toMatchObject({executionMode:'independent',missedPolicy:'latest',overlapPolicy:'coalesce'});
 expect(a.taskId).toBeUndefined();expect(store.database.prepare('SELECT COUNT(*) n FROM work_tasks').get()!.n).toBe(0);
 const first=await service.runNow(a.id,'new-first');const replay=await service.runNow(a.id,'new-first');expect(replay.id).toBe(first.id);
 await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 const task=manager.taskService.getTask({userId:'local'},first.taskId!);expect(task.state).toBe('review');
 restart();const second=await service.runNow(a.id,'new-second');await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));
 const state=await service.list();expect(second.taskId).toBe(first.taskId);expect(manager.taskService.getTask({userId:'local'},first.taskId!).executions).toHaveLength(2);expect(store.database.prepare('SELECT COUNT(*) n FROM work_tasks').get()!.n).toBe(1);expect(state.runs[1].conversationId).not.toBe(state.runs[0].conversationId);expect(state.automations[0].enabled).toBe(true);
 expect(manager.taskService.getRun({userId:'local'},state.runs[0].runId!).snapshot?.rule).toMatchObject({executionMode:'independent'});
});
it.each(['continuous','independent'] as const)('%s rules retain a Task and create fresh chats before pausing on explicit acceptance',async(executionMode)=>{
 const a=await enable(await service.create({...definition(),executionMode}));expect(a.taskId).toBeUndefined();
 const first=await service.runNow(a.id,'continuous-first');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 const persisted=(await service.list()).automations[0];expect(persisted).toMatchObject({executionTaskId:first.taskId});expect(persisted.executionConversationId).toBeUndefined();
 restart();const second=await service.runNow(a.id,'continuous-second');await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));expect(second.taskId).toBe(first.taskId);expect(clients).toHaveLength(2);expect((await service.list()).runs[1].conversationId).not.toBe((await service.list()).runs[0].conversationId);terminal(1);
 const task=manager.taskService.getTask({userId:'local'},first.taskId!);expect(manager.taskService.userCommand({userId:'local'},task.id,task.revision,'accept').state).toBe('completed');
 now=new Date('2026-10-02T01:00:00Z');await service.tick();expect((await service.list()).automations[0].enabled).toBe(false);expect((await service.list()).runs).toHaveLength(2);
});
it('task-origin rules use the same target Task in both modes without creating tasks',async()=>{
 const source=manager.taskService.createTask({userId:'local'},{goal:'Source goal',projectId:'reading',assigneeAgentId:'reader'},'source-mode');
 const continuous=await service.create({...definition(),taskId:source.id});expect(continuous.executionMode).toBe('continuous');const occurrence=await service.runNow(continuous.id);expect(occurrence.taskId).toBe(source.id);
 await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);await service.remove(continuous.id,continuous.revision);
 const independent=await service.create({...definition(),taskId:source.id,executionMode:'independent'});const next=await service.runNow(independent.id);
 expect(next.taskId).toBe(source.id);await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));const executions=manager.taskService.getTask({userId:'local'},source.id).executions;expect(executions).toHaveLength(2);expect(new Set(executions.map(e=>e.conversationId)).size).toBe(2);expect(store.database.prepare('SELECT COUNT(*) n FROM work_tasks').get()!.n).toBe(1);
 await manager.stopDurableTask(source.id,manager.taskService.getTask({userId:'local'},source.id).revision,true);await expect(service.runNow(independent.id,'after-source-cancel')).rejects.toMatchObject({code:'goal_not_active'});
});
it('scope changes reject accepted work and future mode changes preserve occurrence snapshots',async()=>{
 const c=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null});
 await expect(service.create({...definition(),executionMode:'independent',conversationId:c.id})).rejects.toThrow();
 await expect(service.create({...definition(),executionMode:'other'})).rejects.toThrow();
 for(const internal of ['executionTaskId','executionConversationId'])await expect(service.create({...definition(),[internal]:'forged'})).rejects.toThrow();
 const a=await service.create({...definition(),executionMode:'continuous',conversationId:c.id,workspaceId:null});const accepted=await service.runNow(a.id,'frozen-mode');
 await expect(service.update(a.id,{expectedRevision:a.revision,executionMode:'independent',conversationId:null})).rejects.toMatchObject({code:'automation_work_pending'});
 await expect(service.update(a.id,{expectedRevision:a.revision,cli:'omp',conversationId:null})).rejects.toMatchObject({code:'automation_work_pending'});
 await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 const before=manager.taskService.getRun({userId:'local'},(await service.list()).runs[0].runId!).snapshot;
 const updated=await service.update(a.id,{expectedRevision:a.revision,executionMode:'independent',conversationId:null});expect(updated.executionConversationId).toBeUndefined();
 const next=await service.runNow(a.id,'after-mode-change');expect(next.taskId).not.toBe(accepted.taskId);expect(manager.taskService.getRun({userId:'local'},(await service.list()).runs[0].runId!).snapshot).toEqual(before);
});
it('continuous generated Task and occurrence roll back together on enqueue failure',async()=>{
 const a=await service.create({...definition(),executionMode:'continuous'});store.database.exec("CREATE TRIGGER reject_new_occurrence BEFORE INSERT ON automation_occurrences BEGIN SELECT RAISE(ABORT,'enqueue failed'); END");
 await expect(service.runNow(a.id)).rejects.toThrow();expect(store.database.prepare('SELECT COUNT(*) n FROM work_tasks').get()!.n).toBe(0);expect((await service.list()).automations[0].executionTaskId).toBeUndefined();
});
it('multiple weekdays skip weekends and retain named timezone DST semantics',()=>{
 const workdays={kind:'weekly' as const,weekdays:[1,2,3,4,5],time:'09:00',timeZone:'Asia/Singapore'};
 expect(nextScheduledTime(workdays,new Date('2026-10-02T01:00:00Z'))).toBe('2026-10-05T01:00:00.000Z');
 const dst={kind:'weekly' as const,weekdays:[0,1],time:'01:30',timeZone:'America/New_York'};
 const first=nextScheduledTime(dst,new Date('2026-11-01T00:00:00Z'));expect(first).toBe('2026-11-01T05:30:00.000Z');expect(nextScheduledTime(dst,new Date(first!),first!)).toBe('2026-11-02T06:30:00.000Z');
 expect(nextScheduledTime({...dst,time:'02:30'},new Date('2026-03-08T06:00:00Z'))).toBe('2026-03-09T06:30:00.000Z');
 for(const weekdays of [[],[1,1],[-1],[7],[1.5]])expect(()=>nextScheduledTime({...workdays,weekdays},now)).toThrow('invalid schedule');
 expect(()=>nextScheduledTime({...workdays,weekday:1},now)).toThrow('invalid schedule');
 expect(nextScheduledTime({...workdays,weekdays:[1],weekday:1},now)).toBe('2026-10-05T01:00:00.000Z');
});

it('new-mode missed catch-up retains its frozen instructions and routing after rule edits',async()=>{
 const a=await enable(await service.create({...definition(),executionMode:'independent',missedPolicy:'manual',overlapPolicy:'queue'}));now=new Date('2026-10-01T01:01:00Z');await service.tick();const missed=(await service.list()).runs[0];expect(missed.status).toBe('missed');
 await service.update(a.id,{expectedRevision:a.revision,instructions:'Later instructions',cli:'omp'});
 const caught=await service.catchUp(missed.id,'frozen-catchup');expect(caught).toMatchObject({id:missed.id,instructions:definition().instructions,cli:'codex',executionMode:'independent'});
 restart();expect((await service.catchUp(missed.id,'frozen-catchup')).taskId).toBe(caught.taskId);await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toEqual([definition().instructions]));expect(store.getConversation((await service.list()).runs[0].conversationId!)?.cli).toBe('codex');
});
it('dispatch transaction rolls back generated continuous chat and its binding on Run failure',async()=>{
 const a=await service.create({...definition(),executionMode:'continuous'});await service.runNow(a.id);const count=store.listConversations().length;
 store.database.exec("CREATE TRIGGER reject_new_run BEFORE INSERT ON task_runs BEGIN SELECT RAISE(ABORT,'dispatch failed'); END");await service.tick();
 expect(store.listConversations()).toHaveLength(count);expect((await service.list()).automations[0].executionConversationId).toBeUndefined();expect((await service.list()).runs[0].status).toBe('unknown');
});
it('explicit modes reject primary and mismatching runtime or workspace bindings',async()=>{
 const main=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,purpose:'mandala-main'});
 await expect(service.create({...definition(),executionMode:'continuous',workspaceId:null,conversationId:main.id})).rejects.toMatchObject({code:'primary_conversation'});
 const c=store.createConversation({projectId:'reading',agentId:'reader',cli:'omp',model:null,workspaceId:null});
 await expect(service.create({...definition(),executionMode:'continuous',conversationId:c.id,workspaceId:null})).rejects.toMatchObject({code:'invalid_conversation_scope'});
 await expect(service.create({...definition(),executionMode:'continuous',cli:'omp',conversationId:c.id,workspaceId:'default'})).rejects.toMatchObject({code:'invalid_conversation_scope'});
});
it('manual receipt replay survives later rule archival and never advances recurrence',async()=>{
 const a=await service.create(definition()),first=await service.runNow(a.id,'archived-receipt');expect((await service.list()).automations[0].nextRunAt).toBe(a.nextRunAt);await service.remove(a.id,a.revision);restart();expect(await service.runNow(a.id,'archived-receipt')).toEqual(first);
});
it('new explicit continuous instructions edits affect only future occurrence prompts',async()=>{
 const a=await service.create({...definition(),executionMode:'continuous'}),first=await service.runNow(a.id,'old-prompt');
 await service.update(a.id,{expectedRevision:a.revision,instructions:'Updated work instructions'});await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toEqual([definition().instructions]));terminal(0);
 await service.runNow(a.id,'new-prompt');await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toEqual(['Updated work instructions']));expect((await service.list()).runs[1].taskId).toBe(first.taskId);expect((await service.list()).runs[1].conversationId).not.toBe((await service.list()).runs[0].conversationId);expect((await service.list()).runs[0].id).toBe(first.id);expect(manager.taskService.getTask({userId:'local'},first.taskId!).goal).toBe(definition().instructions);
});

it('task-origin queued occurrences keep one Task and receive distinct execution chats',async()=>{
 const task=manager.taskService.createTask({userId:'local'},{goal:'Task contract',projectId:'reading',assigneeAgentId:'reader'},'prequeued-source');
 const a=await service.create({...definition(),taskId:task.id});await service.runNow(a.id,'prequeued-1');await service.runNow(a.id,'prequeued-2');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 restart();await service.tick();await vi.waitFor(()=>expect(clients.flatMap(c=>c.texts)).toHaveLength(2));const runs=(await service.list()).runs;expect(runs.map(r=>r.taskId)).toEqual([task.id,task.id]);expect(runs[1].conversationId).not.toBe(runs[0].conversationId);expect(manager.taskService.getTask({userId:'local'},task.id).executions).toHaveLength(2);expect(clients).toHaveLength(2);
});
it.each(['continuous','independent'] as const)('new %s defaults coalesce scheduled followups without changing active snapshots',async(executionMode)=>{
 const a=await enable(await service.create({...definition(),executionMode,schedule:interval()}));now=new Date('2026-10-01T00:05:00Z');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));const first=(await service.list()).runs[0],snapshot=structuredClone(manager.taskService.getRun({userId:'local'},first.runId!).snapshot);
 now=new Date('2026-10-01T00:10:00Z');await service.tick();restart();now=new Date('2026-10-01T00:30:00Z');await service.tick();const state=await service.list();expect(state.runs).toHaveLength(2);expect(state.runs[1]).toMatchObject({status:'queued',coverage:{count:5,latestDueAt:'2026-10-01T00:30:00.000Z'}});expect(manager.taskService.getRun({userId:'local'},first.runId!).snapshot).toEqual(snapshot);expect(state.automations[0].id).toBe(a.id);
});
it('explicit each policy defaults queue while other new rules default latest and coalesce',async()=>{
 expect(await service.create({...definition(),missedPolicy:'each'})).toMatchObject({executionMode:'independent',missedPolicy:'each',overlapPolicy:'queue'});
});

it.each(['primary','runtime','workspace'] as const)('continuous deferred binding rejects %s scope drift before dispatch',async(change)=>{
 const task=manager.taskService.createTask({userId:'local'},{goal:'Contract',projectId:'reading',assigneeAgentId:'reader'},'deferred-source'),selected=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home});const a=await service.create({...definition(),taskId:task.id,conversationId:selected.id});
 await service.runNow(a.id,'deferred-first');await service.runNow(a.id,'deferred-second');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);const c=store.getConversation(selected.id)!;
 store.database.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify({...c,...(change==='primary'?{purpose:'mandala-main'}:change==='runtime'?{cli:'omp'}:{workspaceId:null})}),c.id);
 await service.tick();expect((await service.list()).runs[1].status).toBe('unknown');expect(clients.flatMap(c=>c.texts)).toHaveLength(1);expect(store.listConversations()).toHaveLength(2);
});

it('scheduled coalescing preserves separate queued manual request receipts',async()=>{
 const a=await enable(await service.create({...definition(),schedule:interval()}));await service.runNow(a.id,'manual-active');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));
 const manual=await service.runNow(a.id,'manual-pending');now=new Date('2026-10-01T00:05:00Z');await service.tick();now=new Date('2026-10-01T00:15:00Z');await service.tick();
 const state=await service.list();expect(state.runs).toHaveLength(3);expect(state.runs[1]).toMatchObject({id:manual.id,status:'queued'});expect(state.runs[1].coverage).toBeUndefined();expect(state.runs[2]).toMatchObject({coverage:{firstDueAt:'2026-10-01T00:05:00.000Z',latestDueAt:'2026-10-01T00:15:00.000Z',count:3}});expect((await service.runNow(a.id,'manual-pending')).id).toBe(manual.id);
});

it.each(['task','selected chat'] as const)('continuous %s binding drift pauses future work before accepting another occurrence',async(kind)=>{
 const selected=kind==='selected chat'?store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home}):undefined;const a=await enable(await service.create({...definition(),executionMode:'continuous',...(selected?{conversationId:selected.id}:{})}));await service.runNow(a.id,'generated-bound');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);await expect.poll(async()=>(await service.list()).runs[0]?.taskId).toBeTruthy();const r=(await service.list()).runs[0];
 if(kind==='task'){const task=manager.taskService.getTask({userId:'local'},r.taskId!);manager.taskService.updateTask({userId:'local'},task.id,task.revision,{assigneeAgentId:null},'generated-unassign');}else store.updateConversation(selected!.id,{cli:'omp'});
 now=new Date('2026-10-01T01:00:00Z');await service.tick();expect((await service.list()).automations[0].enabled).toBe(false);expect((await service.list()).runs).toHaveLength(1);await expect(service.runNow(a.id,'after-generated-drift')).rejects.toMatchObject({status:422});
});

it.each(['continuous','independent'] as const)('accepted %s occurrence rejects execution Task Project drift before creating a Chat',async(executionMode)=>{
 config.projects.push({...config.projects[0],id:'other',name:'Other'});const a=await service.create({...definition(),executionMode}),accepted=await service.runNow(a.id,'accepted-project-drift');
 const task=manager.taskService.getTask({userId:'local'},accepted.taskId!);manager.taskService.updateTask({userId:'local'},task.id,task.revision,{projectId:'other'},'move-accepted-task');
 await service.tick();const r=(await service.list()).runs[0];expect(r).toMatchObject({id:accepted.id,projectId:'reading',status:'unknown'});expect(clients).toHaveLength(0);expect(store.listConversations()).toHaveLength(0);
});
it('old missed continuous catch-up cannot replace a later selected Chat binding generation',async()=>{
 const a=await enable(await service.create({...definition(),executionMode:'continuous',missedPolicy:'manual',overlapPolicy:'queue'}));const old=await service.runNow(a.id,'old-generation');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 now=new Date('2026-10-01T01:01:00Z');await service.tick();const missed=(await service.list()).runs.find(r=>r.status==='missed')!;
 const c=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home});await service.update(a.id,{expectedRevision:a.revision,conversationId:c.id});
 const newer=await service.runNow(a.id,'new-generation');await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));terminal(1);
 expect(newer.taskId).not.toBe(old.taskId);const caught=await service.catchUp(missed.id,'old-generation-catchup');expect(caught.taskId).toBe(old.taskId);expect((await service.list()).automations[0].executionTaskId).toBe(newer.taskId);
 await service.tick();await vi.waitFor(()=>expect(clients[2]?.texts).toHaveLength(1));terminal(2);const future=await service.runNow(a.id,'future-generation');expect(future.taskId).toBe(newer.taskId);await service.tick();await vi.waitFor(()=>expect(clients[3]?.texts).toHaveLength(1));const all=(await service.list()).runs;expect(all.at(-1)?.conversationId).not.toBe(c.id);expect(new Set(all.map(r=>r.conversationId)).size).toBe(all.length);
});
it('prebinding missed continuous catch-up survives repeated Chat edits without claiming the latest generation',async()=>{
 const a=await enable(await service.create({...definition(),executionMode:'continuous',missedPolicy:'manual',overlapPolicy:'queue'}));now=new Date('2026-10-01T01:01:00Z');await service.tick();const missed=(await service.list()).runs[0];expect(missed.taskId).toBeUndefined();
 const c=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home});let updated=await service.update(a.id,{expectedRevision:a.revision,conversationId:c.id});updated=await service.update(a.id,{expectedRevision:updated.revision,conversationId:null});
 const newer=await service.runNow(a.id,'repeated-edit-new');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 const caught=await service.catchUp(missed.id,'prebinding-old');expect(caught.taskId).not.toBe(newer.taskId);expect((await service.list()).automations[0]).toMatchObject({executionTaskId:newer.taskId});expect((await service.list()).automations[0].executionConversationId).toBeUndefined();await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));expect((await service.list()).runs[0].conversationId).not.toBe((await service.list()).runs[1].conversationId);
});

it('multiple prebinding missed occurrences retain one historical Task with distinct execution chats after scope edits',async()=>{
 const a=await enable(await service.create({...definition(),executionMode:'continuous',missedPolicy:'manual',overlapPolicy:'queue'}));now=new Date('2026-10-02T01:01:00Z');await service.tick();const missed=(await service.list()).runs;expect(missed).toHaveLength(2);
 const c=store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home});await service.update(a.id,{expectedRevision:a.revision,conversationId:c.id});const newer=await service.runNow(a.id,'new-multicatch');await service.tick();await vi.waitFor(()=>expect(clients[0]?.texts).toHaveLength(1));terminal(0);
 const first=await service.catchUp(missed[0].id,'old-multi-1'),second=await service.catchUp(missed[1].id,'old-multi-2');expect(first.taskId).not.toBe(newer.taskId);expect(second.taskId).toBe(first.taskId);restart();await service.tick();await vi.waitFor(()=>expect(clients[1]?.texts).toHaveLength(1));terminal(1);await service.tick();await vi.waitFor(()=>expect(clients[2]?.texts).toHaveLength(1));
 const state=await service.list();expect(state.runs[0].conversationId).not.toBe(state.runs[1].conversationId);expect(state.runs[0].conversationId).not.toBe(c.id);expect(state.automations[0]).toMatchObject({executionTaskId:newer.taskId,conversationId:c.id});expect(state.automations[0].executionConversationId).toBeUndefined();expect(clients).toHaveLength(3);
});

it.each(['mode','instructions','destination'] as const)('explicit coalescing separates missed %s contracts and catches up frozen records after restart',async(change)=>{
 const a=await enable(await service.create({...definition(),executionMode:'continuous',missedPolicy:'manual',overlapPolicy:'coalesce'}));
 now=new Date('2026-10-01T01:01:00Z');await service.tick();const original=(await service.list()).runs[0];
 const destination=change==='destination'?store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home}):undefined;
 const updated=await service.update(a.id,{expectedRevision:a.revision,...(change==='mode'?{executionMode:'independent'}:change==='instructions'?{instructions:'Updated frozen work'}:{conversationId:destination!.id})});
 now=new Date('2026-10-02T01:01:00Z');await service.tick();restart();now=new Date('2026-10-03T01:01:00Z');await service.tick();
 const missed=(await service.list()).runs;expect(missed).toHaveLength(2);expect(missed[0]).toEqual(original);
 expect(missed[1]).toMatchObject({status:'missed',executionMode:updated.executionMode,instructions:updated.instructions,bindingGeneration:updated.bindingGeneration,ruleRevision:updated.revision,coverage:{firstDueAt:'2026-10-02T01:00:00.000Z',latestDueAt:'2026-10-03T01:00:00.000Z',count:2}});
 expect(missed[1].id).not.toBe(original.id);expect(updated.bindingGeneration===a.bindingGeneration).toBe(change==='instructions');
 const first=await service.catchUp(original.id,'old-contract');restart();await service.tick();await vi.waitFor(()=>expect(clients.flatMap(c=>c.texts)).toEqual([original.instructions]));terminal(0);
 const second=await service.catchUp(missed[1].id,'new-contract');restart();expect((await service.catchUp(missed[1].id,'new-contract')).taskId).toBe(second.taskId);
 await service.tick();await vi.waitFor(()=>expect(clients.flatMap(c=>c.texts)).toEqual([original.instructions,updated.instructions]));
 const runs=(await service.list()).runs;expect(runs[0]).toMatchObject({id:original.id,instructions:original.instructions,coverage:original.coverage});expect(runs[1]).toMatchObject({id:missed[1].id,instructions:updated.instructions,coverage:missed[1].coverage});
 if(change==='instructions')expect(second.taskId).toBe(first.taskId);else expect(second.taskId).not.toBe(first.taskId);
 if(destination)expect(runs[1].conversationId).not.toBe(destination.id);expect(runs[0].conversationId).not.toBe(runs[1].conversationId);
});

it.each(['cli','conversationId','schedule'] as const)('generation-less explicit coalescing still separates a changed %s contract',async(field)=>{
 const a=await enable(await service.create({...definition(),executionMode:'continuous',missedPolicy:'manual',overlapPolicy:'coalesce'}));
 // Simulate explicit persisted rules written before binding generations were available.
 const saved={...a};delete saved.bindingGeneration;store.database.prepare('UPDATE automation_rules SET data=? WHERE id=?').run(JSON.stringify(saved),a.id);
 now=new Date('2026-10-01T01:01:00Z');await service.tick();const original=(await service.list()).runs[0];
 const destination=field==='conversationId'?store.createConversation({projectId:'reading',agentId:'reader',cli:'codex',model:null,workspaceId:'default',cwd:home}):undefined;
 const changed={...(await service.list()).automations[0],...(field==='cli'?{cli:'omp'}:field==='schedule'?{schedule:{...a.schedule,time:'09:30'}}:{conversationId:destination!.id})};
 store.database.prepare('UPDATE automation_rules SET data=? WHERE id=?').run(JSON.stringify(changed),a.id);
 restart();now=new Date('2026-10-02T01:31:00Z');await service.tick();const runs=(await service.list()).runs;
 expect(runs).toHaveLength(2);expect(runs[0]).toEqual(original);expect(runs[1][field]).toEqual(changed[field]);expect(runs.every(run=>run.bindingGeneration===undefined)).toBe(true);
});

it.each(['goal','criteria'] as const)('explicit coalescing separates a changed source Task %s snapshot',async(field)=>{
 const source=manager.taskService.createTask({userId:'local'},{goal:'Source contract',criteria:[],acceptance:'human',projectId:'reading',assigneeAgentId:'reader'},'coalesce-source');
 const a=await enable(await service.create({...definition(),taskId:source.id,executionMode:'independent',missedPolicy:'manual',overlapPolicy:'coalesce'}));
 now=new Date('2026-10-01T01:01:00Z');await service.tick();const original=(await service.list()).runs[0];
 const patch=field==='goal'?{goal:'Revised source goal'}:{criteria:[{id:'new',text:'Revised criterion',checkRef:null}]};
 const updated=manager.taskService.updateTask({userId:'local'},source.id,source.revision,patch,'changed-source-contract');
 restart();now=new Date('2026-10-02T01:01:00Z');await service.tick();const runs=(await service.list()).runs;
 expect(runs).toHaveLength(2);expect(runs[0]).toEqual(original);expect(runs[1][field]).toEqual(updated[field]);
 now=new Date('2026-10-03T01:01:00Z');await service.tick();expect((await service.list()).runs[1].coverage?.count).toBe(2);
});
