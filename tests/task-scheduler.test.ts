import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createTasks, type TaskResolver } from '../server/tasks';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import {createTaskResources} from '../server/task-resources';
import { createTaskScheduler } from '../server/task-scheduler';
import type { Run, TaskInput } from '../shared/tasks';
const p = { userId: 'u' };
const input: TaskInput = { goal: 'Coordinate report', criteria: [], acceptance: 'human', projectId: null, assigneeAgentId: 'coordinator' };
const stores: ReturnType<typeof openStore>[] = [], homes: string[] = [];
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach(s => s.close()); homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })); });
function setup(extra: Partial<ReturnType<TaskResolver>> = {}) {
 const home = mkdtempSync(join(tmpdir(), 'task-scheduler-')); homes.push(home);
 const store = openStore(home); stores.push(store);
 const chat = store.createConversation({ projectId: '', agentId: 'coordinator', cli: 'codex', model: 'default' });
 const tasks = createTasks(store, { authorizeConversation(){}, resolve: (_p, task) => ({ agentId: task.assigneeAgentId!, projectId: task.projectId, hostId: 'local', input: task.goal, sourceVersions: [], requiredOutputAssetIds: [], effectiveCapabilities: [], nativeVisibility: 'partial', ...extra }) });
 const routeTask = () => ({ mode: 'dedicated' as const, executionConversationId: chat.id, destinationConversationId: null });
 const scheduler = createTaskScheduler(store, tasks, { principal: p, routeTask });
 return { store, tasks, scheduler, chat, home, routeTask };
}
function finish(tasks: ReturnType<typeof createTasks>, run: Run, outcome: 'succeeded' | 'failed' = 'succeeded') {
 const identity = { runId: run.id, hostId: 'local', nativeSessionId: `session-${run.id}`, nativeTurnId: run.id };
 tasks.bindRunIdentity(identity);
 tasks.applyRunEvent({ ...identity, outcome, summary: `${outcome} result`, artifactVersions: [], eventKey: `terminal-${run.id}` });
}
function execution(f:ReturnType<typeof setup>,task:ReturnType<typeof f.tasks.getTask>,key:string,extra:Partial<ReturnType<TaskResolver>>={}){
 const chat=f.store.createConversation({projectId:'',agentId:'worker',cli:'codex',model:null});
 const selection:ReturnType<TaskResolver>={agentId:'worker',projectId:null,hostId:'local',input:key,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial',continuation:{taskId:task.id,conversationId:f.chat.id,epoch:task.continuationEpoch,policy:'resume'},...extra};
 const start=f.tasks.prepareStart(p,task.id,f.tasks.getTask(p,task.id).revision,'start-'+key,undefined,{agentId:'worker',projectId:null,request:key,selection});
 return f.store.transaction(()=>start.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:f.chat.id}));
}
const coordinatorRuns=(f:ReturnType<typeof setup>,id:string)=>f.tasks.listRuns(p,id).filter(run=>run.routing?.executionConversationId===f.chat.id);
function receipts(f:ReturnType<typeof setup>){
 const parent=f.tasks.createTask(p,{...input,originConversationId:f.chat.id},'goal');f.scheduler.enableContinuation(parent.id,1);
 const first=execution(f,parent,'first'),second=execution(f,parent,'second');finish(f.tasks,first);finish(f.tasks,second);
 return {parent,result:f.tasks.listReceipts(p,parent.id)};
}
test('persisted user inputs deduplicate and can be cancelled; another owner and agent cannot queue', () => {
 const f = setup();
 const queued = f.scheduler.enqueueUserInput(f.chat.id, 'hello', 'input1');
 expect(queued.state).toBe('queued');
 expect(f.scheduler.enqueueUserInput(f.chat.id, 'hello', 'input1').id).toBe(queued.id);
 expect(() => f.scheduler.enqueueUserInput(f.chat.id, 'changed', 'input1')).toThrow(expect.objectContaining({ status: 409 }));
 const restarted = createTaskScheduler(f.store, f.tasks, { principal: p });
 expect(restarted.listUserInputs(f.chat.id)).toEqual([queued]);
 restarted.cancelUserInput(queued.id);
 expect(restarted.listUserInputs(f.chat.id)[0].state).toBe('cancelled');
 const agent = createTaskScheduler(f.store, f.tasks, { principal: { ...p, agentId: 'coordinator' } });
 expect(() => agent.enqueueUserInput(f.chat.id, 'spoof user', 'spoof')).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => createTaskScheduler(f.store, f.tasks, { principal: { userId: 'other' } }).listUserInputs(f.chat.id)).toThrow(expect.objectContaining({ status: 403 }));
});
test('dispatch acceptance commits queued Run before execution and does not await a 20-second executor', async () => {
 vi.useFakeTimers();
 const f = setup(), task = f.tasks.createTask(p, input, 'dispatch');
 let completed = false;
 const execute = vi.fn(async () => { expect(f.store.database.isTransaction).toBe(false); await new Promise(r => setTimeout(r, 20_000)); completed = true; });
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, routeTask: f.routeTask, execute });
 const run = await scheduler.dispatchTask(task.id);
 expect(run.state).toBe('queued');
 expect(run.routing).toMatchObject({ mode: 'dedicated', executionConversationId: f.chat.id, destinationConversationId: null });
 expect(execute).not.toHaveBeenCalled();
 expect(scheduler.takeNext(f.chat.id)).toMatchObject({ kind: 'run', run: { id: run.id, state: 'starting' } });
 expect(execute).toHaveBeenCalledTimes(1);
 expect(completed).toBe(false);
 expect(scheduler.takeNext(f.chat.id)).toBeNull();
 await vi.advanceTimersByTimeAsync(20_000);
 expect(completed).toBe(true);
});
test('notify routing has destination without synthetic continuation or parent Task', async () => {
 const f = setup(), task = f.tasks.createTask(p, input, 'notify');
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, routeTask: () => ({ mode: 'existing', executionConversationId: f.chat.id, destinationConversationId: f.chat.id }) });
 const run = await scheduler.dispatchTask(task.id);
 finish(f.tasks, run);
 expect(run.continuation).toBeNull();
 expect(f.tasks.listReceipts(p, task.id)[0]).toMatchObject({ destinationConversationId: f.chat.id, policy: 'notify', deliveryState: 'pending' });
});
test('committed user input outranks two receipts; presentation is not consumption and fixed IDs claim once', () => {
 const f = setup(), { parent, result } = receipts(f);
 f.scheduler.presentReceipt(result[0].id);
 const queued = f.scheduler.enqueueUserInput(f.chat.id, 'unrelated question', 'user');
 expect(f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'coordinate-1', result.map(r => r.id))).toEqual([]);
 expect(coordinatorRuns(f,parent.id)).toEqual([]);
 expect(f.scheduler.takeNext(f.chat.id)).toMatchObject({ kind: 'input', input: { id: queued.id } });
 expect(f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'coordinate-1', result.map(r => r.id))).toEqual([]);
 f.scheduler.completeUserInput(queued.id);
 const claimed = f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'coordinate-1', result.map(r => r.id));
 expect(claimed.map(r => r.id)).toEqual(result.map(r => r.id));
 expect(claimed.map(r => r.deliveryState)).toEqual(['presented', 'pending']);
 expect(new Set(claimed.map(r => r.claimedByRunId))).toEqual(new Set(['coordinate-1']));
 expect(f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'coordinate-2', result.map(r => r.id))).toEqual([]);
 const run = f.tasks.getRun(p, 'coordinate-1');
 expect(f.tasks.getContextSnapshot(p, run.id)?.input).toContain(result[0].summary);
 finish(f.tasks, run);
 expect(f.tasks.listReceipts(p, result[0].taskId!)[0].deliveryState).toBe('consumed');
});
test('failed coordinator keeps claim/error; only explicit continue transfers to a new Run', () => {
 const f = setup(), { parent, result } = receipts(f);
 f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'coordinator-fails', result.map(r => r.id));
 finish(f.tasks, f.tasks.getRun(p, 'coordinator-fails'), 'failed');
 expect(f.tasks.listReceipts(p, result[0].taskId!)[0]).toMatchObject({ claimedByRunId: 'coordinator-fails', claimError: 'failed', deliveryState: 'pending' });
 expect(f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'silent-retry', result.map(r => r.id))).toEqual([]);
 const continued = f.scheduler.continueReceipts(parent.id, 0, f.chat.id, 'explicit-continue', result.map(r => r.id));
 expect(continued[0]).toMatchObject({ claimedByRunId: 'explicit-continue', claimError: null });
 expect(coordinatorRuns(f,parent.id)).toHaveLength(2);
});
test('epoch mismatch parks; unrelated new input does not restore old eligibility', () => {
 const f = setup(), { parent, result } = receipts(f);
 f.scheduler.stopTask(parent.id, f.tasks.getTask(p, parent.id).revision);
 expect(f.tasks.getTask(p, parent.id)).toMatchObject({ continuationEpoch: 1, futureAutoResume: false });
 expect(f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'stale', result.map(r => r.id))).toEqual([]);
 f.scheduler.enqueueUserInput(f.chat.id, 'different topic', 'new-topic');
 expect(f.tasks.listReceipts(p, result[0].taskId!)[0]).toMatchObject({ deliveryState: 'parked', capturedEpoch: 0 });
 expect(f.tasks.getTask(p, parent.id).futureAutoResume).toBe(false);
});
test('coordinator creation, claim, snapshot and outbox rollback together on storage failure', () => {
 const f = setup(), { parent, result } = receipts(f), before = f.store.listOutbox(0);
 f.store.database.exec("CREATE TRIGGER reject_claim BEFORE UPDATE OF claimed_by_run_id ON task_receipts BEGIN SELECT RAISE(ABORT,'claim failed'); END");
 expect(() => f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'atomic', result.map(r => r.id))).toThrow();
 expect(coordinatorRuns(f,parent.id)).toEqual([]);
 expect(f.tasks.listReceipts(p, result[0].taskId!)[0].claimedByRunId).toBeNull();
 expect(f.store.listOutbox(0)).toEqual(before);
});
test('stop interrupts after commit and fences late terminal; completed Run cannot be overwritten', async () => {
 const f = setup(), task = f.tasks.createTask(p, input, 'stop');
 const interrupt = vi.fn((run: Run) => { expect(f.store.database.isTransaction).toBe(false); expect(f.tasks.getRun(p, run.id).state).toBe('interrupted'); });
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, routeTask: f.routeTask, interrupt });
 const run = await scheduler.dispatchTask(task.id);
 const identity = { runId: run.id, hostId: 'local', nativeSessionId: 's', nativeTurnId: 't' };
 f.tasks.bindRunIdentity(identity);
 expect(scheduler.stopTask(task.id, 2).status).toBe('stopped');
 expect(interrupt).toHaveBeenCalledTimes(1);
 expect(f.tasks.applyRunEvent({ ...identity, eventKey: 'late', outcome: 'succeeded', summary: 'late', artifactVersions: [] })).toBe('duplicate');
 expect(f.tasks.listReceipts(p, task.id)).toHaveLength(1);
 const done = f.tasks.createTask(p, input, 'done');
 const doneScheduler=createTaskScheduler(f.store,f.tasks,{principal:p,routeTask:()=>({mode:'dedicated',executionConversationId:f.store.createConversation({projectId:'',agentId:'coordinator',cli:'codex',model:null}).id,destinationConversationId:null})});
 const doneRun=await doneScheduler.dispatchTask(done.id);
 finish(f.tasks, doneRun);
 expect(scheduler.stopTask(done.id, f.tasks.getTask(p, done.id).revision).status).toBe('already_finished');
 expect(f.tasks.getRun(p, doneRun.id).state).toBe('succeeded');
});
test('trusted route creation rolls back with queued Run and replay does not create another conversation', async () => {
 const f = setup(), task = f.tasks.createTask(p, input, 'route');
 const before = f.store.listConversations().length;
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, routeTask: () => {
  const chat = f.store.createConversation({ projectId: '', agentId: 'coordinator', cli: 'codex', model: 'default' });
  return { mode: 'dedicated', executionConversationId: chat.id, destinationConversationId: null };
 } });
 f.store.database.exec("CREATE TRIGGER fail_queue AFTER INSERT ON task_runs BEGIN SELECT RAISE(ABORT,'queue failed'); END");
 await expect(scheduler.dispatchTask(task.id)).rejects.toThrow();
 expect(f.store.listConversations()).toHaveLength(before);
 f.store.database.exec('DROP TRIGGER fail_queue');
 const first = await scheduler.dispatchTask(task.id);
 expect((await scheduler.dispatchTask(task.id)).id).toBe(first.id);
 expect(f.store.listConversations()).toHaveLength(before + 1);
});
test('agent-bound scheduler cannot claim another goal or stop/cancel it', () => {
 const f = setup(), { parent, result } = receipts(f);
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: { ...p, agentId: 'coordinator' } });
 expect(() => scheduler.claimReceipts(parent.id, 0, f.chat.id, 'agent-spoof', result.map(r => r.id))).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => scheduler.stopTask(parent.id, 2)).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => scheduler.cancelTask(parent.id, 2)).toThrow(expect.objectContaining({ status: 403 }));
 expect(coordinatorRuns(f,parent.id)).toEqual([]);
});
test('cancel revokes parent continuation without cascading to child and explicit adoption records new epoch', () => {
 const f = setup(), { parent, result } = receipts(f);
 f.scheduler.stopTask(parent.id, f.tasks.getTask(p,parent.id).revision);
 const adopted = f.scheduler.continueReceipts(parent.id, 1, f.chat.id, 'adopt-old', result.map(r => r.id));
 expect(adopted[0]).toMatchObject({ capturedEpoch: 0, claimEpoch: 1, claimedByRunId: 'adopt-old' });
 f.scheduler.cancelTask(parent.id, f.tasks.getTask(p, parent.id).revision);
 expect(f.tasks.getTask(p, parent.id)).toMatchObject({ state: 'cancelled', continuationEpoch: 2, futureAutoResume: false });
 expect(f.tasks.getTask(p, result[0].taskId!).state).toBe('cancelled');
 expect(f.tasks.getRun(p, 'adopt-old').state).toBe('interrupted');
});
test('active native turn gates queued input without steering, and queued input cannot be cancelled after claim', () => {
 const f = setup(); let occupied = true;
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, isConversationBusy: () => occupied });
 const input = scheduler.enqueueUserInput(f.chat.id, 'later', 'later');
 expect(scheduler.takeNext(f.chat.id)).toBeNull();
 occupied = false;
 expect(scheduler.takeNext(f.chat.id)).toMatchObject({ kind: 'input', input: { id: input.id } });
 expect(() => scheduler.cancelUserInput(input.id)).toThrow(expect.objectContaining({ status: 409 }));
});
test('epoch recheck after resolver prevents coordinator Run creation and parks late receipts', () => {
 const f = setup(), { parent, result } = receipts(f);
 const tasks = createTasks(f.store, { authorizeConversation(){}, resolve: (_p, task) => {
  f.scheduler.stopTask(parent.id, f.tasks.getTask(p, parent.id).revision);
  return { agentId: task.assigneeAgentId!, projectId: null, hostId: 'local', input: task.goal, sourceVersions: [], requiredOutputAssetIds: [], effectiveCapabilities: [], nativeVisibility: 'partial' };
 } });
 const scheduler = createTaskScheduler(f.store, tasks, { principal: p });
 expect(scheduler.claimReceipts(parent.id, 0, f.chat.id, 'racing', result.map(r => r.id))).toEqual([]);
 expect(coordinatorRuns(f,parent.id)).toEqual([]);
 expect(tasks.listReceipts(p, result[0].taskId!)[0].deliveryState).toBe('parked');
});
async function privateReceipt() {
 const f = setup(), files = createAssetFiles(f.home), assets = createAssets(f.store, files);
 const owner = { ...p, agentId: 'worker' };
 writeFileSync(join(f.home, 'source.txt'), 'private fixture');
 const staged = await files.stageFiles(owner, null, [{ allowedRoot: f.home, relativePath: 'source.txt', manifestPath: 'source.txt' }]);
 const asset = assets.createAsset(owner, { kind: 'document', title: 'private', owner });
 const version = assets.publishAssetVersion(owner, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { sourceVersions: [] } }, 'private');
 const ref = { assetId: asset.id, versionId: version.id };
 const parent = f.tasks.createTask(p, {...input,originConversationId:f.chat.id}, 'private-parent');
 f.scheduler.enableContinuation(parent.id, 1);
 const tasks=createTasks(f.store,{assets,authorizeConversation(){},resolve:(_p,task)=>({agentId:task.assigneeAgentId!,projectId:null,hostId:'local',input:task.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const child=parent;
 const run=execution({...f,tasks},parent,'private',{sourceVersions:[ref]});finish(tasks,run);
 const receipt=tasks.listReceipts(p,parent.id)[0];
 const scheduler = createTaskScheduler(f.store, tasks, { principal: p });
 return { ...f, tasks, scheduler, assets, ref, parent, child, receipt };
}
test('receipt adoption checks actual coordinator source access rather than root or executor', async () => {
 const f = await privateReceipt();
 expect(f.scheduler.claimReceipts(f.parent.id, 0, f.chat.id, 'denied-coordinator', [f.receipt.id])).toEqual([]);
 expect(coordinatorRuns(f,f.parent.id)).toEqual([]);
 expect(f.tasks.listReceipts(p, f.child.id)[0]).toMatchObject({ deliveryState: 'parked', claimError: 'forbidden', claimedByRunId: null });
 f.assets.setAccess(p, f.ref.assetId, { mode: 'selected', agentIds: ['worker', 'coordinator'] }, 2);
 const adopted = f.scheduler.continueReceipts(f.parent.id, 0, f.chat.id, 'allowed-coordinator', [f.receipt.id]);
 expect(adopted).toHaveLength(1);
 expect(f.tasks.getContextSnapshot({ ...p, agentId: 'coordinator', runId: 'allowed-coordinator' }, 'allowed-coordinator')?.sourceVersions).toEqual([expect.objectContaining(f.ref)]);
 // Receipt input lineage now protects coordinator input/result readers too.
 f.assets.setAccess(p, f.ref.assetId, { mode: 'owner' }, 3);
 expect(() => f.tasks.getContextSnapshot({ ...p, agentId: 'coordinator' }, 'allowed-coordinator')).toThrow(expect.objectContaining({ status: 403 }));
});
test('access revoked after claim parks receipt and interrupts queued coordinator without sending native work', async () => {
 const f = await privateReceipt();
 f.assets.setAccess(p, f.ref.assetId, { mode: 'selected', agentIds: ['worker', 'coordinator'] }, 2);
 f.scheduler.claimReceipts(f.parent.id, 0, f.chat.id, 'revoke-before-injection', [f.receipt.id]);
 f.assets.setAccess(p, f.ref.assetId, { mode: 'owner' }, 3);
 const execute = vi.fn(), scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, execute });
 expect(scheduler.takeNext(f.chat.id)).toBeNull();
 expect(execute).not.toHaveBeenCalled();
 expect(f.tasks.listReceipts(p, f.child.id)[0]).toMatchObject({ deliveryState: 'parked', claimError: 'forbidden', claimedByRunId: 'revoke-before-injection' });
 expect(f.tasks.getRun(p, 'revoke-before-injection').state).toBe('interrupted');
});
test('queued coordinator cannot complete consumption if goal epoch is revoked before injection', () => {
 const f = setup(), { parent, result } = receipts(f);
 f.scheduler.claimReceipts(parent.id, 0, f.chat.id, 'queued-old-epoch', result.map(r => r.id));
 f.scheduler.stopTask(parent.id, f.tasks.getTask(p, parent.id).revision);
 expect(f.scheduler.takeNext(f.chat.id)).toBeNull();
 expect(f.tasks.getRun(p, 'queued-old-epoch').state).toBe('interrupted');
 expect(f.tasks.listReceipts(p, result[0].taskId!)[0].deliveryState).toBe('parked');
});
test('rejected executor leaves unknown durable state and is not automatically reexecuted', async () => {
 const f = setup(), task = f.tasks.createTask(p, input, 'reject-execute');
 const scheduler = createTaskScheduler(f.store, f.tasks, { principal: p, routeTask: f.routeTask, execute: async () => { throw new Error('startup failed'); } });
 const run = await scheduler.dispatchTask(task.id);
 scheduler.takeNext(f.chat.id);
 await Promise.resolve();
 expect(f.tasks.getRun(p, run.id).state).toBe('unknown');
 expect(scheduler.takeNext(f.chat.id)).toBeNull();
 expect(f.store.listOutbox(0).filter(e => e.type === 'task.execution_error')).toHaveLength(1);
});
test('presentation emits durable outbox without consuming the result', () => {
 const f = setup(), { result } = receipts(f);
 f.scheduler.presentReceipt(result[0].id);
 f.scheduler.presentReceipt(result[0].id);
 expect(f.store.listOutbox(0).filter(e => e.type === 'task.receipt_presented')).toHaveLength(1);
 expect(f.tasks.listReceipts(p, result[0].taskId!)[0]).toMatchObject({ deliveryState: 'presented', claimedByRunId: null });
});
test('stopping a task revokes late reports from every execution',()=>{
 const f=setup(),{parent,result}=receipts(f),lateRun=execution(f,f.tasks.getTask(p,parent.id),'late');
 f.scheduler.stopTask(parent.id,f.tasks.getTask(p,parent.id).revision);
 expect(f.tasks.getRun(p,lateRun.id).state).toBe('interrupted');
 expect(f.tasks.listReceipts(p,parent.id).filter(r=>result.some(old=>old.id===r.id)).every(r=>r.deliveryState==='parked')).toBe(true);
 finish(f.tasks,lateRun);expect(f.tasks.getTask(p,parent.id)).toMatchObject({state:'waiting',futureAutoResume:false,continuationEpoch:1});
});

test.each(['claimReceipts','continueReceipts'] as const)('a succeeded coordinator with Task still running can %s a later authorized receipt',method=>{
 const f=setup(),parent=f.tasks.createTask(p,{...input,originConversationId:f.chat.id},'late-parent');f.scheduler.enableContinuation(parent.id,1);
 const deliver=(key:string)=>{const run=execution(f,f.tasks.getTask(p,parent.id),key);finish(f.tasks,run);return f.tasks.listReceipts(p,parent.id).find(r=>r.sourceRunId===run.id)!;};
 const firstReceipt=deliver('first-child');
 const first=f.scheduler.claimReceipts(parent.id,0,f.chat.id,'first-coordinator',[firstReceipt.id]);expect(first).toHaveLength(1);
 finish(f.tasks,f.tasks.getRun(p,'first-coordinator'));
 expect(f.tasks.getTask(p,parent.id)).toMatchObject({state:'review',futureAutoResume:true,continuationEpoch:0});
 expect(coordinatorRuns(f,parent.id).map(run=>run.state)).toEqual(['succeeded']);
 const lateReceipt=deliver('late-child');
 const claimed=f.scheduler[method](parent.id,0,f.chat.id,'next-coordinator',[lateReceipt.id]);
 expect(claimed).toHaveLength(1);expect(claimed[0]).toMatchObject({claimedByRunId:'next-coordinator',claimEpoch:0});
 expect(coordinatorRuns(f,parent.id).map(run=>run.state)).toEqual(['succeeded','queued']);
 expect(f.scheduler.claimReceipts(parent.id,0,f.chat.id,'duplicate-coordinator',[lateReceipt.id])).toEqual([]);
});

test.each(['queued','starting','running','approval','unknown'] as const)('parallel %s execution in another chat does not block an origin receipt claim',state=>{
 const f=setup(),{parent,result}=receipts(f),other=f.store.createConversation({projectId:'',agentId:'coordinator',cli:'codex',model:null});
 const current=f.tasks.getTask(p,parent.id),prepared=f.tasks.prepareStart(p,parent.id,current.revision,'parallel-active',undefined,{});
 const active=f.store.transaction(()=>prepared.commit({executionConversationId:other.id,mode:'dedicated',destinationConversationId:null}));
 f.store.database.prepare('UPDATE task_runs SET state=? WHERE id=?').run(state,active.id);
 const claimed=f.scheduler.claimReceipts(parent.id,0,f.chat.id,'origin-resume',result.map(receipt=>receipt.id));
 expect(claimed).toHaveLength(2);expect(f.tasks.getRun(p,active.id).state).toBe(state);
 expect(f.tasks.getRun(p,'origin-resume').routing?.executionConversationId).toBe(f.chat.id);
});
test('receipt input merges once across restart, prioritizes humans, consumes only after native acceptance',()=>{
 const f=setup(),{result}=receipts(f);
 const queued=f.scheduler.enqueueReceiptInput(f.chat.id,result)!;
 expect(queued.source).toEqual({kind:'coordination',receiptIds:result.map(r=>r.id)});
 const restarted=createTaskScheduler(f.store,f.tasks,{principal:p});
 expect(restarted.enqueueReceiptInput(f.chat.id,result)).toBeNull();
 const human=restarted.enqueueUserInput(f.chat.id,'Human priority','human');
 expect(restarted.takeNext(f.chat.id)).toMatchObject({kind:'input',input:{id:human.id}});restarted.completeUserInput(human.id);
 expect(restarted.takeNext(f.chat.id)).toMatchObject({kind:'input',input:{id:queued.id,source:queued.source}});
 restarted.bindInputInvocation(queued.id,'invocation','native',null);
 expect(f.tasks.listReceipts(p,result[0].taskId!)[0].deliveryState).toBe('pending');
 restarted.bindInputInvocation(queued.id,'invocation','native','turn');
 expect(f.tasks.listReceipts(p,result[0].taskId!)[0].deliveryState).toBe('consumed');
 restarted.reconcileInput(queued.id,false);
 expect(()=>restarted.resolveUnknownInput(queued.id,'retry','retry')).toThrow(expect.objectContaining({code:'system_input_retry_unavailable'}));
 expect(restarted.enqueueReceiptInput(f.chat.id,result)).toBeNull();
});
test('system input provenance cannot overwrite an existing human input or be cleared by replay',()=>{
 const f=setup();f.scheduler.enqueueUserInput(f.chat.id,'Human','human');
 expect(()=>f.scheduler.enqueueSystemInput(f.chat.id,'Human','human',{kind:'idle'})).toThrow(expect.objectContaining({code:'idempotency_conflict'}));
 const automatic=f.scheduler.enqueueSystemInput(f.chat.id,'Automatic','automatic',{kind:'idle'});
 expect(f.scheduler.enqueueUserInput(f.chat.id,'Automatic','automatic')).toEqual(automatic);
});

test.each(['identity','occupancy','submitted'] as const)('never requeues uncertain receipt submission proved by %s',proof=>{
 const f=setup(),{result}=receipts(f),input=f.scheduler.enqueueReceiptInput(f.chat.id,result)!;
 f.scheduler.takeNext(f.chat.id);f.scheduler.bindInputInvocation(input.id,'invocation','native',null);
 if(proof==='identity')f.scheduler.bindInputInvocation(input.id,'invocation','native','turn');
 if(proof==='occupancy')f.store.database.prepare("INSERT INTO task_native_uncertainty VALUES ('input',?,?)").run(input.id,f.chat.id);
 if(proof==='submitted'){const resources=createTaskResources(f.store);resources.claim({kind:'input',id:input.id,conversationId:f.chat.id},[f.home],'write');resources.submitted('input',input.id,'invocation','native');}
 expect(f.scheduler.requeueUnsubmittedInput(input.id)).toBe(false);
 expect(f.scheduler.listUserInputs(f.chat.id)[0].state).toBe('running');
 expect(f.scheduler.enqueueReceiptInput(f.chat.id,result)).toBeNull();
});

test.each(['identity','occupancy','submitted','unknown'] as const)('receipt splitting retains every claim and event when %s proves uncertain submission',proof=>{
 const f=setup(),{parent,result}=receipts(f),input=f.scheduler.enqueueReceiptInput(f.chat.id,result)!;
 f.scheduler.takeNext(f.chat.id);f.scheduler.bindInputInvocation(input.id,'invocation','native',null);
 const event=f.store.appendEvent(f.chat.id,'user',{text:input.text,queuedInputId:input.id,invocationId:'invocation',source:input.source});
 if(proof==='identity')f.scheduler.bindInputInvocation(input.id,'invocation','native','turn');
 if(proof==='occupancy')f.store.database.prepare("INSERT INTO task_native_uncertainty VALUES ('input',?,?)").run(input.id,f.chat.id);
 if(proof==='submitted'){const resources=createTaskResources(f.store);resources.claim({kind:'input',id:input.id,conversationId:f.chat.id},[f.home],'write');resources.submitted('input',input.id,'invocation','native');}
 if(proof==='unknown')f.scheduler.reconcileInput(input.id,false);
 f.store.database.prepare("UPDATE work_tasks SET state='cancelled' WHERE id=?").run(parent.id);
 expect(f.scheduler.recoverReceiptInput(input.id,'invocation')).toBe(false);
 expect(f.store.listEvents(f.chat.id,0).some(item=>item.id===event.id)).toBe(true);
 expect(f.store.database.prepare('SELECT input_id FROM task_receipt_inputs WHERE input_id=?').all(input.id)).toHaveLength(2);
 expect(f.scheduler.enqueueReceiptInput(f.chat.id,result)).toBeNull();
});
