import {ensureConfiguredMandala} from './configured-mandala';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {readConfig} from '../server/config';
import {ensureMandalaConversation,mandalaContextBoundary} from '../server/mandala';
import {createSessionManager} from '../server/sessions';
import type {CodexClient,CodexOptions} from '../server/codex';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const c of cleanup.splice(0).reverse())await c();});
async function setup(mode:'started'|'completed'|'noop'|'unsupported'|'error'='started'){
 const home=await mkdtemp(join(tmpdir(),'mandala-continuity-')),store=openStore(home),config=(await ensureConfiguredMandala(home)).config;
 const entries:{options:CodexOptions;native:string;turn:number;text:string;compacts:number;settled:boolean;check?:()=>Promise<void>}[]=[];
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{const e={options,native:'native-'+entries.length,turn:0,text:'',compacts:0,settled:true} as typeof entries[number];entries.push(e);return {
  getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=>e.native,resumeThread:async id=>{e.native=id;},
  inspectContext:async()=>{await e.check?.();return {settled:e.settled};},compactThread:async()=>{e.compacts++;if(mode==='error')throw Error('transport failed');return mode;},
  startTurn:async(_id,text)=>{e.text=text;return 'turn-'+(++e.turn);},interrupt:async()=>{},replyApproval(){},close(){},
 };};
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory,factory,home),chat=ensureMandalaConversation(store,config);
 cleanup.push(async()=>{await manager.close();store.close();await rm(home,{recursive:true,force:true});});
 const finish=(e=entries[0])=>e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'turn-'+e.turn,status:'completed'}}});
 const age=()=>{store.database.prepare("UPDATE events SET createdAt=? WHERE conversationId=? AND kind='user'").run(new Date(Date.now()-6*3600000).toISOString(),chat.id);};
 return {home,store,config,manager,chat,entries,finish,age,factory};
}
it('maintains at six hours, waits for native terminal and preserves logical history and ACL boundary',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup();await manager.send(chat.id,'Keep this goal');finish();age();
 const before=store.listEvents(chat.id,0).filter(e=>e.kind==='user');
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entries[0].compacts).toBe(1);
 expect(store.getConversation(chat.id)?.nativeId).toBe('native-0');
 const e=entries[0];e.options.onEvent({method:'turn/started',params:{threadId:e.native,turn:{id:'compact-1'}}});
 e.options.onEvent({method:'item/completed',params:{threadId:e.native,turnId:'compact-1',item:{type:'contextCompaction'}}});
 expect(store.listEvents(chat.id,0).filter(e=>(e.data as any).contextMaintenance?.status==='completed')).toHaveLength(0);
 e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'compact-1',status:'completed'}}});await maintenance;
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user')).toEqual(before);
 expect(mandalaContextBoundary(store,chat.id)).toBe(0);
 expect(store.listEvents(chat.id,0).find(e=>(e.data as any).contextMaintenance?.status==='completed')?.data).not.toHaveProperty('runId');
 await manager.maintainMandalaContext();expect(e.compacts).toBe(1);
});
it('does not use system input as human activity and accepts queued human activity before processing',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup('completed');await manager.send(chat.id,'Hello');finish();
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(0);age();
 store.appendEvent(chat.id,'user',{text:'background receipt',source:{kind:'schedule',automationId:'rule'}});
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(1);
 // A queued send is activity even if it has not reached the native runtime.
 const input=manager.enqueueUserInput(chat.id,'New user request','human');
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(1);expect(input.createdAt).toBeTruthy();
});
it('queues racing human text and references until native maintenance settles',async()=>{
 const {manager,chat,entries,finish,age}=await setup();await manager.send(chat.id,'Hello');finish();age();
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entries[0].compacts).toBe(1);
 await manager.send(chat.id,'Do not lose me');expect(manager.listUserInputs(chat.id)).toMatchObject([{text:'Do not lose me',state:'queued'}]);
 const e=entries[0];e.options.onEvent({method:'turn/started',params:{threadId:e.native,turn:{id:'compact'}}});
 e.options.onEvent({method:'item/completed',params:{threadId:e.native,turnId:'compact',item:{type:'contextCompaction'}}});
 e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'compact',status:'completed'}}});await maintenance;
 await expect.poll(()=>entries.at(-1)?.text).toBe('Do not lose me');
});
it('falls back on unsupported compression with a bounded public excerpt, preserving the security cutoff',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup('unsupported');await manager.send(chat.id,'Old secret');finish();
 const cutoff=store.appendEvent(chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}}).id;
 store.appendEvent(chat.id,'user',{text:'Current public request'});store.appendEvent(chat.id,'text',{text:'PRIVATE_REASONING',phase:'analysis'});age();
 await manager.maintainMandalaContext();expect(store.getConversation(chat.id)).toMatchObject({nativeId:null,continuityPending:true});
 expect(mandalaContextBoundary(store,chat.id)).toBe(cutoff);
 await manager.send(chat.id,'Next');expect(entries.at(-1)?.text).toContain('Current public request');expect(entries.at(-1)?.text).not.toContain('Old secret');expect(entries.at(-1)?.text).not.toContain('PRIVATE_REASONING');
});
it('native automatic compaction satisfies the watermark and does not trigger a duplicate request',async()=>{
 const {manager,chat,entries,finish,age}=await setup();await manager.send(chat.id,'Hello');
 entries[0].options.onEvent({method:'item/completed',params:{threadId:'native-0',turnId:'turn-1',item:{type:'contextCompaction'}}});finish();age();
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(0);
});
it('known context-window exhaustion triggers maintenance without waiting six hours',async()=>{
 const {manager,chat,entries,finish}=await setup('noop');await manager.send(chat.id,'Hello');
 entries[0].options.onEvent({method:'thread/tokenUsage/updated',params:{threadId:'native-0',turnId:'turn-1',tokenUsage:{last:{totalTokens:100},modelContextWindow:100}}});finish();
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(1);expect(entries[0].native).toBe('native-0');
});
it('native asynchronous work and durable unknown occupancy prevent maintenance',async()=>{
 const {manager,chat,entries,finish,age}=await setup('unsupported');await manager.send(chat.id,'Hello');finish();age();entries[0].settled=false;
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(0);
});
it('uses a fake clock for the exact six-hour boundary and persists the watermark over restart',async()=>{
 const {manager,chat,entries,finish,store,home,factory}=await setup('noop');
 const now=Date.now();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);await manager.send(chat.id,'Remember continuity');finish();
 vi.setSystemTime(now+6*3600000-1);await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(0);
 vi.setSystemTime(now+6*3600000);await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(1);
 await manager.close();const recovered=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(()=>recovered.close());
 await recovered.maintainMandalaContext();expect(entries.reduce((n,e)=>n+e.compacts,0)).toBe(1);
 await recovered.send(chat.id,'Continue');expect(entries.at(-1)?.native).toBe('native-0');
});
it('queues a user send that races the asynchronous idle check and yields before compacting',async()=>{
 const {manager,chat,entries,finish,age}=await setup('noop');await manager.send(chat.id,'Hello');finish();age();
 let entered=false,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});entries[0].check=async()=>{entered=true;await gate;};
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entered).toBe(true);await manager.send(chat.id,'Won the race');release();await maintenance;
 expect(entries[0].compacts).toBe(0);await expect.poll(()=>entries.at(-1)?.text).toBe('Won the race');
});
it('preserves unknown maintenance across restart and holds human input until native idle is proven',async()=>{
 const {manager,chat,entries,finish,age,store,home,factory}=await setup();await manager.send(chat.id,'Hello');finish();age();
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entries[0].compacts).toBe(1);entries[0].settled=false;
 entries[0].options.onEvent({method:'turn/started',params:{threadId:'native-0',turn:{id:'compact-pending'}}});
 await manager.close();await maintenance;expect(store.getConversation(chat.id)?.nativeId).toBe('native-0');
 const recovered=createSessionManager(store,async()=>(await readConfig(home)).config,async options=>{const client=await factory(options);entries.at(-1)!.settled=false;return client;},undefined,home);cleanup.push(()=>recovered.close());
 await recovered.send(chat.id,'Preserve on restart');await expect(recovered.sendQueuedInput(chat.id,recovered.listUserInputs(chat.id).at(-1)!.id)).rejects.toMatchObject({code:'conversation_busy'});await recovered.maintainMandalaContext();
 expect(store.getConversation(chat.id)?.nativeId).toBe('native-0');expect(recovered.listUserInputs(chat.id).at(-1)?.state).toBe('queued');
 await recovered.close();
 const settled=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(()=>settled.close());
 await settled.maintainMandalaContext();await expect.poll(()=>entries.at(-1)?.text).toContain('Preserve on restart');
 expect(store.getConversation(chat.id)?.nativeId).not.toBe('native-0');expect(entries.at(-1)?.text).toContain('Hello');
});
it('keeps pending attachments and references and applies a runtime switch only after maintenance',async()=>{
 const {manager,chat,entries,finish,age,home,store,factory}=await setup();await manager.send(chat.id,'Remember');finish();age();
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entries[0].compacts).toBe(1);
 const {updateMandalaSettings}=await import('../server/config');const current=await readConfig(home);await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'omp',maxParallel:3},current.revision);
 const {saveAttachment,loadAttachments}=await import('../server/attachments');
 const attachment=await saveAttachment(home,chat.id,'evidence.txt',Buffer.from('durable evidence'));
 manager.taskService.createTask({userId:store.ownerUserId},{goal:'Authorized reference',participantAgentIds:[chat.agentId]},'reference');
 const reference=(await manager.listComposerReferences(chat.id)).find(item=>item.kind==='task')!;
 await manager.send(chat.id,'Read my evidence',await loadAttachments(home,chat.id,[attachment.id]),[{id:reference.id}]);
 expect(manager.listUserInputs(chat.id).at(-1)?.attachments).toEqual([attachment.id]);expect(manager.listUserInputs(chat.id).at(-1)?.references).toEqual([{id:reference.id}]);
 const e=entries[0];e.options.onEvent({method:'turn/started',params:{threadId:e.native,turn:{id:'maintenance'}}});
 e.options.onEvent({method:'item/completed',params:{threadId:e.native,turnId:'maintenance',item:{type:'contextCompaction'}}});
 e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'maintenance',status:'completed'}}});await maintenance;
 await expect.poll(()=>entries.at(-1)?.text).toContain('evidence.txt');expect(store.getConversation(chat.id)?.cli).toBe('omp');
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user'&&(e.data as any).text?.includes('Read my evidence'))).toHaveLength(1);
});
it('retains separate native maintenance lifecycle and never changes preceding usage or progress',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup();await manager.send(chat.id,'Hello');finish();age();
 const usageBefore=store.database.prepare('SELECT data FROM usage_executions').all();
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entries[0].compacts).toBe(1);const e=entries[0];
 e.options.onEvent({method:'turn/started',params:{threadId:e.native,turn:{id:'maintenance'}}});
 e.options.onEvent({method:'thread/tokenUsage/updated',params:{threadId:e.native,turnId:'maintenance',tokenUsage:{total:{inputTokens:100,outputTokens:10},last:{totalTokens:110},modelContextWindow:200}}});
 e.options.onEvent({method:'item/completed',params:{threadId:e.native,turnId:'maintenance',item:{type:'contextCompaction'}}});
 e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'maintenance',status:'completed'}}});await maintenance;
 expect(store.database.prepare('SELECT data FROM usage_executions').all()).toEqual(usageBefore);
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='tool'&&(e.data as any).params?.turn?.id==='maintenance')).toEqual([]);
 expect(store.listEvents(chat.id,0).filter(e=>(e.data as any).contextMaintenance).every(e=>!(e.data as any).runId)).toBe(true);
});
it('records authorized goal associations and preserves independent background work',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup('noop');const root={userId:store.ownerUserId};
 const goal=manager.taskService.createTask(root,{goal:'Public goal',participantAgentIds:[chat.agentId]},'public');
 const privateGoal=manager.taskService.createTask(root,{goal:'PRIVATE_GOAL',originConversationId:chat.id},'private');
 store.database.prepare('INSERT INTO mandala_ownership VALUES (?,?)').run(goal.id,JSON.stringify({taskId:goal.id,agentId:chat.agentId,relation:'taken-over',conversationId:chat.id,sourceEventId:null,invocationId:'historical',createdAt:new Date().toISOString(),blockedReason:null}));
 const background=await manager.create('',chat.agentId);await manager.send(background.id,'Keep working');
 await manager.send(chat.id,'Coordinate');finish(entries[1]);age();await manager.maintainMandalaContext();
 const record=(store.listEvents(chat.id,0).filter(e=>(e.data as any).contextMaintenance).at(-1)!.data as any).contextMaintenance;
 expect(record.handoff).toContain('Public goal');expect(record.handoff).not.toContain('PRIVATE_GOAL');expect(record.goalIds).toContain(goal.id);
 expect(store.getConversation(background.id)?.status).toBe('running');expect(store.getConversation(chat.id)?.id).toBe(chat.id);
});
it('defers transport failure until native idle is proven, then falls back without retrying the request',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup('error');await manager.send(chat.id,'Remember');finish();age();
 await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(1);expect(store.getConversation(chat.id)?.nativeId).toBe('native-0');
 entries[0].settled=false;await manager.send(chat.id,'Queued safely');await manager.maintainMandalaContext();expect(entries[0].compacts).toBe(1);expect(manager.listUserInputs(chat.id).at(-1)?.state).toBe('queued');
 entries[0].settled=true;await manager.maintainMandalaContext();await expect.poll(()=>entries.at(-1)?.text).toContain('Queued safely');expect(store.getConversation(chat.id)?.nativeId).not.toBe('native-0');
});
it('late compaction item completion after disconnect still waits for its native terminal',async()=>{
 const {manager,chat,entries,finish,age,store}=await setup();await manager.send(chat.id,'Hello');finish();age();
 const maintenance=manager.maintainMandalaContext();await expect.poll(()=>entries[0].compacts).toBe(1);const e=entries[0];
 e.options.onEvent({method:'turn/started',params:{threadId:e.native,turn:{id:'late'}}});e.settled=false;e.options.onExit('disconnected');await maintenance;
 await manager.send(chat.id,'Wait for late terminal');
 e.options.onEvent({method:'item/completed',params:{threadId:e.native,turnId:'late',item:{type:'contextCompaction'}}});
 expect(manager.listUserInputs(chat.id).at(-1)?.state).toBe('queued');expect(store.getConversation(chat.id)?.nativeId).toBe(e.native);
 e.options.onEvent({method:'turn/completed',params:{threadId:e.native,turn:{id:'late',status:'completed'}}});
 await expect.poll(()=>entries.at(-1)?.text).toBe('Wait for late terminal');
});
it('handles a new real context overflow after automatic compaction in the same input without repeating the old signal',async()=>{
 const {manager,chat,entries,finish}=await setup('noop');await manager.send(chat.id,'Long work');const e=entries[0];
 e.options.onEvent({method:'item/completed',params:{threadId:e.native,turnId:'turn-1',item:{type:'contextCompaction'}}});
 e.options.onEvent({method:'error',params:{threadId:e.native,turnId:'turn-1',error:{codexErrorInfo:'contextWindowExceeded'}}});finish();
 await manager.maintainMandalaContext();expect(e.compacts).toBe(1);
 await manager.maintainMandalaContext();expect(e.compacts).toBe(1);
});
