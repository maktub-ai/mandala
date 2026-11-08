import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks, type TaskResolver } from '../server/tasks';
import type { TaskInput, TerminalRunEvent } from '../shared/tasks';
const p = { userId: 'u' };
const input: TaskInput = { goal: 'Prepare report', criteria: [], acceptance: 'delivery', projectId: null, assigneeAgentId: 'a' };
const homes: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
function setup(resolve: TaskResolver = (_p, task) => ({ agentId: task.assigneeAgentId!, projectId: task.projectId, hostId: 'local', input: task.goal, sourceVersions: [], requiredOutputAssetIds: [], effectiveCapabilities: [], nativeVisibility: 'partial' })) {
 const home = mkdtempSync(join(tmpdir(), 'durable-tasks-')); homes.push(home);
 const store = openStore(home); stores.push(store);
 const files = createAssetFiles(home), assets = createAssets(store, files), tasks = createTasks(store, { resolve, assets });
 return { home, store, files, assets, tasks };
}
function running(tasks: ReturnType<typeof createTasks>, acceptance: TaskInput['acceptance'] = 'delivery') {
 const task = tasks.createTask(p, { ...input, acceptance }, `create-${acceptance}`);
 const run = tasks.startTask(p, task.id, task.revision, `start-${acceptance}`);
 const identity = { runId: run.id, hostId: 'local', nativeSessionId: 'session', nativeTurnId: run.id };
 expect(tasks.bindRunIdentity(identity)).toBe('applied');
 const event: TerminalRunEvent = { ...identity, eventKey: `terminal-${run.id}`, outcome: 'succeeded', summary: 'Report delivered', artifactVersions: [] };
 return { task, run, event };
}
test('unassigned todo persists without Run; invalid start, revision and command reuse are rejected', () => {
 const { store, tasks } = setup();
 const todo = tasks.createTask(p, { ...input, assigneeAgentId: null }, 'todo');
 expect(todo).toMatchObject({ state: 'todo', projectId: null, assigneeAgentId: null, revision: 1 });
 expect(tasks.listRuns(p, todo.id)).toEqual([]);
 expect(tasks.createTask(p, { ...input, assigneeAgentId: null }, 'todo').id).toBe(todo.id);
 expect(() => tasks.createTask(p, { ...input, goal: 'Changed' }, 'todo')).toThrow(expect.objectContaining({ status: 409 }));
 expect(() => tasks.startTask(p, todo.id, 1, 'start')).toThrow(expect.objectContaining({ code: 'assignee_required' }));
 expect(() => tasks.createTask(p, { ...input, goal: ' ' }, 'invalid')).toThrow(expect.objectContaining({ status: 422 }));
 const task = tasks.createTask(p, input, 'assigned');
 expect(() => tasks.startTask(p, task.id, 0, 'stale')).toThrow(expect.objectContaining({ status: 409 }));
 const run = tasks.startTask(p, task.id, 1, 'start');
 expect(tasks.startTask(p, task.id, 1, 'start').id).toBe(run.id);
 expect(() => tasks.startTask(p, task.id, 2, 'start')).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM command_dedup').get()!.n).toBe(0);
 expect(() => tasks.getTask({ userId: 'other' }, task.id)).toThrow(expect.objectContaining({ status: 403 }));
});
test.each(['human', 'checks'] as const)('succeeded %s Run does not infer goal progress or acceptance', acceptance => {
 const { tasks } = setup(), { task, run, event } = running(tasks, acceptance);
 expect(tasks.applyRunEvent(event)).toBe('applied');
 expect(tasks.getRun(p, run.id).state).toBe('succeeded');
 expect(tasks.getTask(p, task.id)).toMatchObject({ state: 'review', completion: null });
 expect(tasks.listReceipts(p, task.id)).toHaveLength(1);
});
test('an ongoing goal may explicitly start another Run after success without resetting its progress',()=>{
 const {tasks}=setup(),{task,run,event}=running(tasks);tasks.applyRunEvent(event);
 const ongoing=tasks.updateTask(p,task.id,tasks.getTask(p,task.id).revision,{state:'running'},'continue-goal'),next=tasks.startTask(p,task.id,ongoing.revision,'explicit-next');
 expect(next).toMatchObject({taskId:task.id,attempt:2,state:'queued'});expect(tasks.getRun(p,run.id).state).toBe('succeeded');
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'running',completion:null,revision:ongoing.revision+1});
 expect(tasks.startTask(p,task.id,ongoing.revision,'explicit-next').id).toBe(next.id);
 expect(()=>tasks.startTask(p,task.id,ongoing.revision+1,'third-active')).toThrow(expect.objectContaining({code:'task_not_startable'}));
 expect(tasks.listRuns(p,task.id)).toHaveLength(2);
});
test.each(['queued','starting','running','approval','unknown'] as const)('an active %s Run prevents a second attempt even if Task progress changes to todo',state=>{
 const {tasks,store}=setup(),task=tasks.createTask(p,input,'create'),run=tasks.startTask(p,task.id,1,'first');
 store.database.prepare('UPDATE task_runs SET state=? WHERE id=?').run(state,run.id);
 const edited=tasks.updateTask(p,task.id,2,{state:'todo'},'progress');
 expect(()=>tasks.startTask(p,task.id,edited.revision,'second')).toThrow(expect.objectContaining({code:'task_not_startable'}));
 expect(tasks.listRuns(p,task.id)).toHaveLength(1);
});
test.each(['review','completed','cancelled'] as const)('%s goal cannot start a new Run after native success',state=>{
 const {tasks}=setup(),{task,event}=running(tasks);tasks.applyRunEvent(event);
 let current=tasks.getTask(p,task.id);
 if(state==='cancelled'){tasks.stopTask(p,task.id,current.revision,true);current=tasks.getTask(p,task.id);}
 else{current=tasks.userCommand(p,task.id,current.revision,'complete');if(state==='completed')current=tasks.userCommand(p,task.id,current.revision,'accept');}
 expect(()=>tasks.startTask(p,task.id,current.revision,'blocked')).toThrow(expect.objectContaining({code:'task_not_startable'}));expect(tasks.listRuns(p,task.id)).toHaveLength(1);
});
test('terminal requires exact native identity; replay never completes a successor and emits one receipt', () => {
 const { tasks, store } = setup(), { task, run, event } = running(tasks);
 expect(tasks.applyRunEvent({ ...event, nativeTurnId: 'wrong' })).toBe('unmatched');
 expect(tasks.getTask(p, task.id).state).toBe('running');
 expect(tasks.applyRunEvent(event)).toBe('applied');
 expect(tasks.getTask(p, task.id)).toMatchObject({ state: 'review', completion: null });
 expect(tasks.applyRunEvent(event)).toBe('duplicate');
 expect(tasks.applyRunEvent({ ...event, eventKey: 'different-terminal-key' })).toBe('duplicate');
 const other = tasks.createTask(p, input, 'other');
 const successor = tasks.startTask(p, other.id, 1, 'other-start');
 tasks.bindRunIdentity({ runId: successor.id, hostId: 'local', nativeSessionId: 'session', nativeTurnId: 'turn2' });
 expect(tasks.applyRunEvent({ ...event, runId: successor.id })).toBe('unmatched');
 expect(tasks.getRun(p, successor.id).state).toBe('running');
 expect(tasks.listReceipts(p, task.id)).toHaveLength(1);
 expect(store.listOutbox(0).filter(e => e.type === 'task.run_terminal')).toHaveLength(1);
});
test('resolver must confirm configured assignee/project and valid selected input', () => {
 const { tasks } = setup(() => ({ agentId: 'spoofed', projectId: null, hostId: 'local', input: ' ', sourceVersions: [], requiredOutputAssetIds: [], effectiveCapabilities: [], nativeVisibility: 'partial' }));
 const task = tasks.createTask(p, input, 'create');
 expect(() => tasks.startTask(p, task.id, 1, 'start')).toThrow(expect.objectContaining({ status: 422 }));
 expect(tasks.listRuns(p, task.id)).toEqual([]);
});
test('terminal transaction rolls back Run, disposition, Receipt and outbox together', () => {
 const { tasks, store } = setup(), { task, run, event } = running(tasks);
 const before = store.listOutbox(0);
 store.database.exec("CREATE TRIGGER fail_receipt AFTER INSERT ON task_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect(() => tasks.applyRunEvent(event)).toThrow(expect.objectContaining({ code: 'storage_failure' }));
 expect(tasks.getRun(p, run.id).state).toBe('running');
 expect(tasks.getTask(p, task.id).state).toBe('running');
 expect(tasks.listReceipts(p, task.id)).toEqual([]);
 expect(store.listOutbox(0)).toEqual(before);
 store.database.exec('DROP TRIGGER fail_receipt');
 expect(tasks.applyRunEvent(event)).toBe('applied');
});
test('fixed input versions and their hashes stay distinct from explicitly produced outputs', async () => {
 let sourceVersions: { assetId: string; versionId: string }[] = [];
 let outputAssetId = '';
 const { tasks, assets, files, home, store } = setup((_p, task) => ({ agentId: 'a', projectId: null, hostId: 'local', input: task.goal, sourceVersions, requiredOutputAssetIds: [outputAssetId], effectiveCapabilities: [{ name: 'native', state: 'unverified' }], nativeVisibility: 'partial' }));
 const agent = { ...p, agentId: 'a' };
 writeFileSync(join(home, 'source.txt'), 'source content');
 const stage = await files.stageFiles(agent, null, [{ allowedRoot: home, relativePath: 'source.txt', manifestPath: 'source.md' }]);
 const asset = assets.createAsset(agent, { kind: 'document', title: 'Source', owner: agent });
 const version = assets.publishAssetVersion(agent, { assetId: asset.id, expectedHeadVersionId: null, submissionId: stage.submissionId, files: stage.files, provenance: { sourceVersions: [] } }, 'source');
 sourceVersions = [{ assetId: asset.id, versionId: version.id }]; outputAssetId = asset.id;
 const { task, run, event } = running(tasks);
 const snap = tasks.getContextSnapshot(p, run.id)!;
 expect(snap).toMatchObject({ input: input.goal, inputHash: createHash('sha256').update(input.goal).digest('hex'), nativeVisibility: 'partial', sourceVersions: [{ ...sourceVersions[0], files: stage.files }] });
 expect(store.database.prepare('SELECT count(*) AS n FROM artifact_links WHERE run_id=?').get(run.id)!.n).toBe(1);
 expect(tasks.applyRunEvent({ ...event, artifactVersions: sourceVersions })).toBe('applied');
 expect(tasks.getTask(p, task.id)).toMatchObject({ state: 'waiting', waitingReason: 'delivery_missing', completion: null });
 expect(tasks.getContextSnapshot(p, run.id)).toEqual(snap);
});
test('old JSON dispatch records are retained as history and never re-imported into the new task model',()=>{
 const {store,tasks}=setup(),chat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null});
 const old=store.createTask({projectId:'',sourceConversationId:chat.id,targetConversationId:chat.id,kind:'dispatch',request:'Historical work'});
 expect(createTasks(store).listTasks({userId:'local'})).toEqual([]);expect(store.getTask(old.id)).toBeDefined();expect(tasks.listTasks(p)).toEqual([]);
});
test('source authorization uses the assignee, and denied start leaves no Run/snapshot/outbox', async () => {
 let refs: { assetId: string; versionId: string }[] = [];
 const { tasks, store, assets, files, home } = setup((_p, task) => {
  expect(store.database.isTransaction).toBe(false);
  return { agentId: 'a', projectId: null, hostId: 'local', input: task.goal, sourceVersions: refs, requiredOutputAssetIds: [], effectiveCapabilities: [], nativeVisibility: 'partial' };
 });
 writeFileSync(join(home, 'private.txt'), 'owner only');
 const owner = { ...p, agentId: 'owner' };
 const staged = await files.stageFiles(owner, null, [{ allowedRoot: home, relativePath: 'private.txt', manifestPath: 'private.txt' }]);
 const asset = assets.createAsset(owner, { kind: 'file', title: 'Private', owner });
 const version = assets.publishAssetVersion(owner, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { sourceVersions: [] } }, 'publish-private');
 refs = [{ assetId: asset.id, versionId: version.id }];
 const task = tasks.createTask(p, input, 'denied'), before = store.listOutbox(0);
 expect(() => tasks.startTask(p, task.id, 1, 'start-denied')).toThrow(expect.objectContaining({ status: 403 }));
 expect(tasks.getTask(p, task.id).state).toBe('todo');
 expect(tasks.listRuns(p, task.id)).toEqual([]);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM context_snapshots').get()!.n).toBe(0);
 expect(store.listOutbox(0)).toEqual(before);
});
test.each(['succeeded', 'failed'] as const)('explicit publication by this Run retains outputs on %s', async outcome => {
 let requiredOutputAssetIds: string[] = [];
 const { tasks, assets, files, home, store } = setup((_p, task) => ({ agentId: 'a', projectId: null, hostId: 'local', input: task.goal, sourceVersions: [], requiredOutputAssetIds, effectiveCapabilities: [], nativeVisibility: 'partial' }));
 const agent = { ...p, agentId: 'a' };
 const asset = assets.createAsset(agent, { kind: 'file', title: 'Result', owner: agent });
 requiredOutputAssetIds = [asset.id];
 const { task, run, event } = running(tasks);
 const producer = { ...agent, runId: run.id };
 writeFileSync(join(home, 'result.txt'), 'result');
 const staged = await files.stageFiles(producer, run.id, [{ allowedRoot: home, relativePath: 'result.txt', manifestPath: 'result.txt' }]);
 const version = assets.publishAssetVersion(producer, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { sourceVersions: [], runId: run.id } }, 'result');
 const outputs = [{ assetId: asset.id, versionId: version.id }];
 expect(tasks.applyRunEvent({ ...event, outcome, artifactVersions: outputs })).toBe('applied');
 expect(tasks.getTask(p, task.id).state).toBe(outcome === 'succeeded' ? 'review' : 'waiting');
 expect(tasks.getRun(p, run.id).artifactVersions).toEqual(outputs);
 expect(tasks.listReceipts(p, task.id)[0].artifactVersions).toEqual(outputs);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM task_output_versions').get()!.n).toBe(1);
});
test('empty successful result is delivery_missing; interrupted Run preserves distinct failure disposition', () => {
 const { tasks } = setup(), first = running(tasks);
 tasks.applyRunEvent({ ...first.event, summary: ' ' });
 expect(tasks.getTask(p, first.task.id)).toMatchObject({ state: 'waiting', waitingReason: 'delivery_missing' });
 const second = tasks.startTask(p, first.task.id, tasks.getTask(p, first.task.id).revision, 'retry');
 const identity = { runId: second.id, hostId: 'local', nativeSessionId: 'session', nativeTurnId: second.id };
 tasks.bindRunIdentity(identity);
 tasks.applyRunEvent({ ...first.event, ...identity, eventKey: 'interrupted', outcome: 'interrupted' });
 expect(tasks.getTask(p, first.task.id)).toMatchObject({ state: 'waiting', waitingReason: 'interrupted', completion: null });
 expect(tasks.listRuns(p, first.task.id).map(r => r.attempt)).toEqual([1, 2]);
});
test('late execution receipt retains dispatch epoch and is parked after task revocation',()=>{
 let continuation:import('../shared/tasks').Continuation|undefined;
 const {tasks,store}=setup((_p,task)=>({agentId:'a',projectId:null,hostId:'local',input:task.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial',continuation}));
 const origin=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),principal={userId:store.ownerUserId};
 const task=tasks.createTask(principal,{...input,originConversationId:origin.id},'task');continuation={taskId:task.id,conversationId:origin.id,epoch:0,policy:'resume'};
 const run=tasks.startTask(principal,task.id,1,'start'),identity={runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'};tasks.bindRunIdentity(identity);
 store.database.prepare('UPDATE work_tasks SET continuation_epoch=1,future_auto_resume=0 WHERE id=?').run(task.id);
 tasks.applyRunEvent({...identity,eventKey:'done',outcome:'succeeded',summary:'Result',artifactVersions:[]});
 expect(tasks.listReceipts(principal,task.id)[0]).toMatchObject({executionId:run.executionId,capturedEpoch:0,deliveryState:'parked',policy:'resume'});expect(tasks.getRun(principal,run.id).continuation?.epoch).toBe(0);
});
test('native identity cannot be rebound or copied to a different Run', () => {
 const { tasks } = setup(), { event } = running(tasks);
 expect(tasks.bindRunIdentity(event)).toBe('duplicate');
 expect(tasks.bindRunIdentity({ ...event, nativeTurnId: 'changed' })).toBe('unmatched');
 const task = tasks.createTask(p, input, 'another'), run = tasks.startTask(p, task.id, 1, 'another-start');
 expect(tasks.bindRunIdentity({ ...event, runId: run.id })).toBe('unmatched');
 expect(tasks.getRun(p, run.id).state).toBe('queued');
});
async function scopedSnapshot() {
 let sourceVersions: { assetId: string; versionId: string }[] = [];
 const preparedInput = 'Private executor fixture content';
 const fixture = setup((_p, task) => ({ agentId: task.assigneeAgentId!, projectId: null, hostId: 'local', input: preparedInput, sourceVersions, requiredOutputAssetIds: [], effectiveCapabilities: [], nativeVisibility: 'partial' }));
 const { tasks, assets, files, home } = fixture;
 const executor = { ...p, agentId: 'executor' }, coordinator = { ...p, agentId: 'coordinator' };
 writeFileSync(join(home, 'private-source.txt'), preparedInput);
 const staged = await files.stageFiles(executor, null, [{ allowedRoot: home, relativePath: 'private-source.txt', manifestPath: 'source.txt' }]);
 const asset = assets.createAsset(executor, { kind: 'document', title: 'Executor-only source', owner: executor });
 const version = assets.publishAssetVersion(executor, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { sourceVersions: [] } }, 'private-source');
 const ref = { assetId: asset.id, versionId: version.id };
 sourceVersions = [ref];
 const task = tasks.createTask(coordinator, { ...input, assigneeAgentId: executor.agentId }, 'delegated');
 const run = tasks.startTask(coordinator, task.id, task.revision, 'delegated-start');
 return { ...fixture, executor, coordinator, ref, run, preparedInput };
}
test('Task creator cannot read snapshot body or manifest without its fixed source permission', async () => {
 const { tasks, assets, coordinator, executor, ref, run, preparedInput } = await scopedSnapshot();
 expect(() => assets.getAuthorizedVersion(coordinator, ref)).toThrow(expect.objectContaining({ status: 403 }));
 expect(tasks.getContextSnapshot(executor, run.id)?.input).toBe(preparedInput);
 expect(tasks.getContextSnapshot(p, run.id)?.sourceVersions[0]).toMatchObject(ref);
 expect(() => tasks.getContextSnapshot(coordinator, run.id)).toThrow(expect.objectContaining({ status: 403 }));
});
test.each(['retracted', 'narrowed'] as const)('snapshot read rechecks a %s source without changing historical input', async change => {
 const { tasks, assets, store, executor, ref, run, preparedInput } = await scopedSnapshot();
 expect(tasks.getContextSnapshot(executor, run.id)?.input).toBe(preparedInput);
 const before = store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id);
 if (change === 'retracted') assets.setLifecycle(p, ref.assetId, 'retracted', 2);
 else assets.setAccess(p, ref.assetId, { mode: 'private' }, 2);
 expect(() => assets.getAuthorizedVersion(executor, ref)).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => tasks.getContextSnapshot(executor, run.id)).toThrow(expect.objectContaining({ status: 403 }));
 expect(store.database.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(run.id)).toEqual(before);
});
test('source-free snapshot remains readable by the authorized Task reader', () => {
 const { tasks, store } = setup(), { run } = running(tasks);
 const snapshot = createTasks(store).getContextSnapshot(p, run.id);
 expect(snapshot).toMatchObject({ input: input.goal, sourceVersions: [] });
});
function finishScopedRun(fixture: Awaited<ReturnType<typeof scopedSnapshot>>) {
 const { tasks, run, preparedInput } = fixture;
 const identity = { runId: run.id, hostId: 'local', nativeSessionId: 'private-session', nativeTurnId: run.id };
 tasks.bindRunIdentity(identity);
 tasks.applyRunEvent({ ...identity, eventKey: `finished-${run.id}`, outcome: 'succeeded', summary: preparedInput, artifactVersions: [] });
}
function readResultBodies(fixture: Awaited<ReturnType<typeof scopedSnapshot>>, principal: typeof p) {
 const { tasks, run } = fixture;
 return [
  () => tasks.getRun(principal, run.id),
  () => tasks.listRuns(principal, run.taskId),
  () => tasks.listReceipts(principal, run.taskId),
 ];
}
test('Run and Receipt readers deny private summaries to creator while preserving authorized reads', async () => {
 const fixture = await scopedSnapshot(), { tasks, executor, coordinator, run, preparedInput } = fixture;
 // Queued metadata and the existing start command remain available without exposing input.
 expect(tasks.getRun(coordinator, run.id).summary).toBeNull();
 expect(tasks.startTask(coordinator, run.taskId, 1, 'delegated-start').id).toBe(run.id);
 finishScopedRun(fixture);
 expect(tasks.getRun(executor, run.id).summary).toBe(preparedInput);
 expect(tasks.listRuns(executor, run.taskId)[0].summary).toBe(preparedInput);
 expect(tasks.listReceipts(executor, run.taskId)[0].summary).toBe(preparedInput);
 for (const read of readResultBodies(fixture, coordinator)) expect(read).toThrow(expect.objectContaining({ status: 403 }));
});
test.each(['retracted', 'narrowed'] as const)('result bodies and idempotent start replay recheck %s sources without replacing Run', async change => {
 const fixture = await scopedSnapshot(), { tasks, store, assets, executor, coordinator, ref, run } = fixture;
 finishScopedRun(fixture);
 // Grant creator access so the exact same command replay first succeeds.
 assets.setAccess(p, ref.assetId, { mode: 'selected', agentIds: [executor.agentId, coordinator.agentId] }, 2);
 expect(tasks.startTask(coordinator, run.taskId, 1, 'delegated-start').id).toBe(run.id);
 for (const read of readResultBodies(fixture, executor)) expect(read).not.toThrow();
 const before = store.database.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id);
 if (change === 'retracted') assets.setLifecycle(p, ref.assetId, 'retracted', 3);
 else assets.setAccess(p, ref.assetId, { mode: 'private' }, 3);
 for (const principal of [executor, coordinator]) {
  for (const read of readResultBodies(fixture, principal)) expect(read).toThrow(expect.objectContaining({ status: 403 }));
 }
 expect(() => tasks.startTask(coordinator, run.taskId, 1, 'delegated-start')).toThrow(expect.objectContaining({ status: 403 }));
 expect(store.database.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id)).toEqual(before);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id=?').get(run.taskId)!.n).toBe(1);
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM task_receipts WHERE task_id=?').get(run.taskId)!.n).toBe(1);
});
test('result readers and command replay check output permission even with no input source', async () => {
 const { tasks, assets, files, home, store } = setup();
 const { task, run, event } = running(tasks), executor = { ...p, agentId: 'a', runId: run.id };
 writeFileSync(join(home, 'private-output.txt'), 'private output');
 const staged = await files.stageFiles(executor, run.id, [{ allowedRoot: home, relativePath: 'private-output.txt', manifestPath: 'result.txt' }]);
 const asset = assets.createAsset(executor, { kind: 'file', title: 'Output', owner: executor });
 const version = assets.publishAssetVersion(executor, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { runId: run.id, sourceVersions: [] } }, 'private-output');
 tasks.applyRunEvent({ ...event, artifactVersions: [{ assetId: asset.id, versionId: version.id }] });
 expect(tasks.getRun(executor, run.id).artifactVersions[0].versionId).toBe(version.id);
 expect(tasks.listReceipts(executor, task.id)).toHaveLength(1);
 expect(tasks.startTask(p, task.id, 1, 'start-delivery').id).toBe(run.id);
 const before = store.database.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id);
 assets.setLifecycle(p, asset.id, 'retracted', 2);
 expect(() => tasks.getRun(executor, run.id)).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => tasks.listRuns(executor, task.id)).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => tasks.listReceipts(executor, task.id)).toThrow(expect.objectContaining({ status: 403 }));
 expect(() => tasks.startTask(p, task.id, 1, 'start-delivery')).toThrow(expect.objectContaining({ status: 403 }));
 expect(store.database.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id)).toEqual(before);
});
test('stop preserves outputs already published by the Run and emits exactly one terminal Receipt', async () => {
 const { tasks, assets, files, home } = setup(), { task, run, event } = running(tasks);
 const producer = { ...p, agentId: 'a', runId: run.id };
 writeFileSync(join(home, 'before-stop.txt'), 'partial result');
 const staged = await files.stageFiles(producer, run.id, [{ allowedRoot: home, relativePath: 'before-stop.txt', manifestPath: 'partial.txt' }]);
 const asset = assets.createAsset(producer, { kind: 'file', title: 'Partial result', owner: producer });
 const version = assets.publishAssetVersion(producer, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { runId: run.id, sourceVersions: [] } }, 'partial-output');
 expect(tasks.stopTask(p, task.id, 2).status).toBe('stopped');
 const output = [{ assetId: asset.id, versionId: version.id }];
 expect(tasks.getRun(p, run.id)).toMatchObject({ state: 'interrupted', artifactVersions: output });
 expect(tasks.listReceipts(p, task.id)[0].artifactVersions).toEqual(output);
 expect(tasks.applyRunEvent(event)).toBe('duplicate');
 expect(tasks.listReceipts(p, task.id)).toHaveLength(1);
});
test('stop/cancel never implicitly reopen a cancelled goal or erase completed acceptance', () => {
 const { tasks } = setup();
 const todo = tasks.createTask(p, input, 'cancel-todo');
 tasks.stopTask(p, todo.id, 1, true);
 const cancelled = tasks.getTask(p, todo.id);
 expect(tasks.stopTask(p, todo.id, cancelled.revision).status).toBe('already_finished');
 expect(tasks.getTask(p, todo.id)).toEqual(cancelled);
 const { task, event } = running(tasks);
 tasks.applyRunEvent(event);
 const review=tasks.userCommand(p,task.id,tasks.getTask(p,task.id).revision,'complete');tasks.userCommand(p,task.id,review.revision,'accept');
 const completed = tasks.getTask(p, task.id);
 expect(tasks.stopTask(p, task.id, completed.revision, true).status).toBe('already_finished');
 expect(tasks.getTask(p, task.id)).toEqual(completed);
});
test('late successful Run never reopens user acceptance or replaces its completion evidence',()=>{
 const {store,tasks}=setup(),{task,event}=running(tasks);
 // A pre-existing terminal record may still receive a delayed native event; new completion commands reject active Runs.
 const completion={completedBy:'user',sourceRunId:null,artifactVersions:[],acceptedAt:'2026-01-01T00:00:00Z'};store.database.prepare("UPDATE work_tasks SET state='completed',waiting_reason=NULL,completion=? WHERE id=?").run(JSON.stringify(completion),task.id);const accepted=tasks.getTask(p,task.id);
 expect(accepted).toMatchObject({state:'completed',completion:{completedBy:'user',sourceRunId:null,artifactVersions:[]}});
 expect(tasks.applyRunEvent(event)).toBe('applied');expect(tasks.getTask(p,task.id)).toMatchObject({state:'completed',completion:accepted.completion});
 expect(tasks.listReceipts(p,task.id)).toHaveLength(1);
});
test('unlinked historical return is retained without creating a live receipt',()=>{
 const {store}=setup(),chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:'default'}),legacy=store.createTask({projectId:'',sourceConversationId:chat.id,targetConversationId:chat.id,kind:'return',request:'Historical return'}),tasks=createTasks(store);
 expect(store.getTask(legacy.id)).toBeDefined();expect(()=>tasks.authorizeReceipt({userId:'local'},legacy.id)).toThrow(expect.objectContaining({code:'receipt_not_found'}));
});
test.each(['human', 'delivery'] as const)('stop accepts original running revision after native success (%s) and revokes continuation', acceptance => {
 const { tasks, store } = setup(), { task, run, event } = running(tasks, acceptance);
 // Model an already enabled goal before the in-flight stop request was issued.
 store.transaction(() => { store.database.prepare('UPDATE work_tasks SET future_auto_resume=1,revision=revision+1 WHERE id=?').run(task.id); });
 const runningRevision = tasks.getTask(p, task.id).revision;
 tasks.applyRunEvent(event);
 const terminal = tasks.getRun(p, run.id), goal = tasks.getTask(p, task.id);
 expect(tasks.stopTask(p, task.id, runningRevision)).toEqual({ status: 'already_finished', run: null });
 expect(tasks.getRun(p, run.id)).toEqual(terminal);
 expect(tasks.getTask(p, task.id)).toMatchObject({ state: goal.state, completion: goal.completion, continuationEpoch: 1, futureAutoResume: false });
 expect(tasks.listReceipts(p, task.id)).toHaveLength(1);
 expect(tasks.applyRunEvent(event)).toBe('duplicate');
 expect(store.listOutbox(0).filter(e => e.type === 'task.run_terminal')).toHaveLength(1);
});
test.each(['human', 'delivery'] as const)('cancel with pre-terminal revision cancels still-open goal regardless legacy acceptance (%s)', acceptance => {
 const { tasks, store } = setup(), { task, run, event } = running(tasks, acceptance);
 const runningRevision = tasks.getTask(p, task.id).revision;
 tasks.applyRunEvent(event);
 const goal = tasks.getTask(p, task.id), terminal = tasks.getRun(p, run.id);
 expect(tasks.stopTask(p, task.id, runningRevision, true)).toEqual({ status: 'cancelled', run: null });
 expect(tasks.getTask(p, task.id)).toMatchObject({ state: 'cancelled', completion: goal.completion, continuationEpoch: 1, futureAutoResume: false });
 expect(tasks.getRun(p, run.id)).toEqual(terminal);
 expect(tasks.listReceipts(p, task.id)).toHaveLength(1);
 expect(store.listOutbox(0).filter(e => e.type === 'task.cancelled')).toHaveLength(1);
});
test('cancel with pre-terminal revision cancels a failed still-open goal without rewriting Run', () => {
 const { tasks } = setup(), { task, run, event } = running(tasks);
 tasks.applyRunEvent({ ...event, outcome: 'failed' });
 expect(tasks.stopTask(p, task.id, 2, true)).toEqual({ status: 'cancelled', run: null });
 expect(tasks.getTask(p, task.id)).toMatchObject({ state: 'cancelled', continuationEpoch: 1, futureAutoResume: false });
 expect(tasks.getRun(p, run.id).state).toBe('failed');
 expect(tasks.listReceipts(p, task.id)).toHaveLength(1);
});
test.each([false, true])('old stop/cancel revision cannot cross a new active attempt (cancel=%s)', cancel => {
 const { tasks } = setup(), { task, event } = running(tasks);
 tasks.applyRunEvent({ ...event, outcome: 'failed' });
 const successor = tasks.startTask(p, task.id, 3, 'explicit-next-attempt'), before = tasks.getTask(p, task.id);
 expect(() => tasks.stopTask(p, task.id, 2, cancel)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
 expect(tasks.getTask(p, task.id)).toEqual(before);
 expect(tasks.getRun(p, successor.id).state).toBe('queued');
});
test.each(['before', 'after'] as const)('unrelated revision edit %s terminal still conflicts with old stop request', when => {
 const { tasks, store } = setup(), { task, event } = running(tasks, 'human');
 const edit = () => store.transaction(() => { store.database.prepare('UPDATE work_tasks SET goal=?,revision=revision+1 WHERE id=?').run('User edited goal', task.id); });
 if (when === 'before') edit();
 tasks.applyRunEvent(event);
 const stopRevision = when === 'before' ? 2 : tasks.getTask(p, task.id).revision;
 if (when === 'after') edit();
 const before = tasks.getTask(p, task.id);
 expect(() => tasks.stopTask(p, task.id, stopRevision)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
 expect(tasks.getTask(p, task.id)).toEqual(before);
});

test.each([false,true])('a task aggregates each execution latest run, second execution finishes first=%s',secondFirst=>{
 const {tasks,store}=setup(),{task,run,event}=running(tasks),chat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),execution=tasks.createExecution(p,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:'Second part'},'second');
 const prepared=tasks.prepareStart(p,task.id,tasks.getTask(p,task.id).revision,'second-start',undefined,{executionId:execution.id}),next=store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null})),identity={runId:next.id,hostId:'local',nativeSessionId:'second',nativeTurnId:'turn'};tasks.bindRunIdentity(identity);
 const terminal={...identity,eventKey:'second-done',outcome:'succeeded' as const,summary:'Second delivered',artifactVersions:[]};
 if(secondFirst)tasks.applyRunEvent(terminal);else tasks.applyRunEvent(event);
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'running',waitingReason:null,completion:null});
 if(secondFirst)tasks.applyRunEvent(event);else tasks.applyRunEvent(terminal);
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'review',waitingReason:null,completion:null});expect(tasks.getRun(p,run.id).state).toBe('succeeded');
});
test('native history rejection atomically parks its terminal receipt and retained coordinator claims',()=>{
 const {tasks,store}=setup(),previous=running(tasks);tasks.applyRunEvent(previous.event);
 const retained=tasks.listReceipts(p,previous.task.id)[0];
 const task=tasks.createTask(p,input,'new'),run=tasks.startTask(p,task.id,1,'new-run');
 store.database.prepare("UPDATE task_runs SET state='starting' WHERE id=?").run(run.id);
 store.database.prepare('UPDATE task_receipts SET claimed_by_run_id=? WHERE id=?').run(run.id,retained.id);
 const snapshot=tasks.getContextSnapshot(p,run.id);
 store.transaction(()=>tasks.rejectQueuedRun(p,run.id,'native_history_changed'));
 expect(tasks.getRun(p,run.id)).toMatchObject({state:'interrupted',nativeSessionId:null,nativeTurnId:null});
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'waiting',waitingReason:'interrupted'});
 expect(tasks.getContextSnapshot(p,run.id)).toEqual(snapshot);
 expect(tasks.listReceipts(p,task.id)[0]).toMatchObject({deliveryState:'parked',claimError:'native_history_changed'});
 expect(tasks.listReceipts(p,previous.task.id)[0]).toMatchObject({deliveryState:'parked',claimError:'native_history_changed',claimedByRunId:run.id});
 expect(store.listOutbox(0).filter(e=>e.type==='task.run_terminal' && e.aggregateId===task.id)[0].payload).toMatchObject({deliveryState:'parked'});
 expect(()=>store.transaction(()=>tasks.rejectQueuedRun(p,run.id,'native_history_changed'))).toThrow(expect.objectContaining({code:'run_not_queued'}));
 expect(tasks.listReceipts(p,task.id)).toHaveLength(1);
});
test('native history rejection cannot cross a mapped native start or relax the forbidden queued fence',()=>{
 const {tasks,store}=setup(),task=tasks.createTask(p,input,'new'),run=tasks.startTask(p,task.id,1,'new-run');
 store.database.prepare("UPDATE task_runs SET state='starting' WHERE id=?").run(run.id);
 expect(()=>store.transaction(()=>tasks.rejectQueuedRun(p,run.id,'forbidden'))).toThrow(expect.objectContaining({code:'run_not_queued'}));
 store.database.prepare("UPDATE task_runs SET native_session_id='observed-session' WHERE id=?").run(run.id);
 expect(()=>store.transaction(()=>tasks.rejectQueuedRun(p,run.id,'native_history_changed'))).toThrow(expect.objectContaining({code:'run_already_submitted'}));
 expect(tasks.getRun(p,run.id).state).toBe('starting');expect(tasks.listReceipts(p,task.id)).toEqual([]);
});
test('F1 Run control reads are body-free and ownership checked independently of content readers',()=>{
 const {store,tasks}=setup(),{task,run,event}=running(tasks);tasks.applyRunEvent(event);const controls=createTasks(store);
 const expected={monitor:{lastProgressAt:null,reason:null,attention:false},id:run.id,waitingForDirectory:false,taskId:task.id,executionId:run.executionId,attempt:1,state:'succeeded',hostId:'local',nativeSessionId:'session',nativeTurnId:run.id,routing:tasks.getRun(p,run.id).routing,continuation:null,createdAt:run.createdAt};
 expect(controls.getRunControl(p,run.id)).toEqual(expected);expect(controls.listRunControls(p,task.id)).toEqual([expected]);expect(controls.getRunControl({...p,agentId:'a'},run.id)).toEqual(expected);
 for(const stranger of [{userId:'other'},{...p,agentId:'unrelated'}]){expect(()=>controls.getRunControl(stranger,run.id)).toThrow('forbidden');expect(()=>controls.listRunControls(stranger,task.id)).toThrow('forbidden');}
 expect(()=>controls.getRunControl(p,'absent')).toThrow('run_not_found');
});

test.each(['missing','revoked'] as const)('native success with %s published output stays waiting for delivery', async failure => {
 const {tasks,assets,files,home}=setup();const {task,run,event}=running(tasks),agent={...p,agentId:'a',runId:run.id};
 writeFileSync(join(home,'result.txt'),'actual delivered bytes');
 const staged=await files.stageFiles(agent,run.id,[{allowedRoot:home,relativePath:'result.txt',manifestPath:'result.txt'}]);
 const output=assets.importAsset(agent,{kind:'file',title:'Result',agentId:'a',submissionId:staged.submissionId},'output');
 if(failure==='missing')rmSync(files.blobPath(output.version.files[0].blobHash));
 else assets.setAccess(p,output.asset.id,{mode:'private'},output.asset.revision);
 expect(tasks.applyRunEvent({...event,artifactVersions:[{assetId:output.asset.id,versionId:output.version.id}]})).toBe('applied');
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'waiting',waitingReason:'delivery_missing',completion:null});
 expect(tasks.getRun(p,run.id).state).toBe('succeeded');
});

test.each([false,true])('selected artifact integrity checks actual immutable bytes (corrupt=%s)',async corrupt=>{
 const {tasks,assets,files,home}=setup();
 const task=tasks.createTask(p,{...input,acceptance:'checks',criteria:[{id:'integrity',text:'Delivered bytes match their immutable manifest',checkRef:'artifact:integrity'}]},'integrity');
 const run=tasks.startTask(p,task.id,1,'integrity-start'),identity={runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'integrity-turn'};tasks.bindRunIdentity(identity);
 const agent={...p,agentId:'a',runId:run.id};writeFileSync(join(home,'result.txt'),'verified bytes');
 const staged=await files.stageFiles(agent,run.id,[{allowedRoot:home,relativePath:'result.txt',manifestPath:'result.txt'}]);
 const output=assets.importAsset(agent,{kind:'file',title:'Result',agentId:'a',submissionId:staged.submissionId},'integrity-output');
 if(corrupt)writeFileSync(files.blobPath(output.version.files[0].blobHash),'corrupt! bytes');
 tasks.applyRunEvent({...identity,eventKey:'terminal-integrity',outcome:'succeeded',summary:'Model says passed',artifactVersions:[{assetId:output.asset.id,versionId:output.version.id}]});
 expect(tasks.getRun(p,run.id).state).toBe('succeeded');
 expect(tasks.getTask(p,task.id)).toMatchObject(corrupt?{state:'waiting',waitingReason:'check_failed',completion:null}:{state:'completed',completion:{completedBy:'checks',sourceRunId:run.id}});
});

test.each(['missing','source_revoked','old_turn'] as const)('integrity never certifies %s output evidence',async failure=>{
 let refs:{assetId:string;versionId:string}[]=[];
 const {tasks,assets,files,home}=setup((_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:refs,requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'}));
 writeFileSync(join(home,'source.txt'),'source');const inputBytes=await files.stageFiles(p,null,[{allowedRoot:home,relativePath:'source.txt',manifestPath:'source.txt'}]);
 const source=assets.importAsset(p,{kind:'file',title:'Source',submissionId:inputBytes.submissionId},'source');assets.setAccess(p,source.asset.id,{mode:'all'},source.asset.revision);refs=[{assetId:source.asset.id,versionId:source.version.id}];
 const task=tasks.createTask(p,{...input,acceptance:'checks',criteria:[{id:'hash',text:'Check delivered bytes',checkRef:'artifact:integrity'}]},'checked');
 const run=tasks.startTask(p,task.id,task.revision,'start'),identity={runId:run.id,hostId:'local',nativeSessionId:'native',nativeTurnId:'current'};tasks.bindRunIdentity(identity);
 const actor={...p,agentId:'a',runId:run.id};writeFileSync(join(home,'output.txt'),'output');const staged=await files.stageFiles(actor,run.id,[{allowedRoot:home,relativePath:'output.txt',manifestPath:'output.txt'}]);
 const output=assets.importAsset(actor,{kind:'file',title:'Output',agentId:'a',submissionId:staged.submissionId,sourceVersions:refs},'out');
 if(failure==='missing')rmSync(files.blobPath(output.version.files[0].blobHash));
 if(failure==='source_revoked'){const current=assets.getAuthorizedAsset(p,source.asset.id);assets.setAccess(p,current.id,{mode:'private'},current.revision);expect(()=>assets.getAuthorizedVersion(actor,refs[0])).toThrow();}
 tasks.applyRunEvent({...identity,nativeTurnId:failure==='old_turn'?'previous':'current',outcome:'succeeded',eventKey:'terminal',summary:'Model reports checked',artifactVersions:[{assetId:output.asset.id,versionId:output.version.id}]});
 expect(tasks.getTask(p,task.id)).toMatchObject(failure==='old_turn'?{state:'running',completion:null}:{state:'waiting',waitingReason:'delivery_missing',completion:null});
});
test('execution monitor uses actual output events, distinguishes waiting, and never retries quiet work',()=>{const {tasks,store}=setup(),{run}=running(tasks);const at='2020-01-01T00:00:00.000Z';const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});store.appendEvent(chat.id,'text',{runId:run.id,text:'Real progress'},at);expect(tasks.getRunControl(p,run.id).monitor).toMatchObject({lastProgressAt:at,reason:null,attention:false});store.database.prepare("UPDATE task_runs SET state='approval' WHERE id=?").run(run.id);expect(tasks.getRunControl(p,run.id).monitor).toMatchObject({reason:'approval',attention:true});store.database.prepare("UPDATE task_runs SET state='unknown' WHERE id=?").run(run.id);expect(tasks.getRunControl(p,run.id).monitor).toMatchObject({reason:'unknown',attention:true});expect(tasks.listRuns(p,run.taskId)).toHaveLength(1);});
test('quiet monitor checks native state without killing or retrying work and deduplicates attention',async()=>{const {createTaskMonitor}=await import('../server/task-monitor');const {tasks,store}=setup(),{run}=running(tasks);let checked=0,time=Date.parse('2026-10-17T10:00:00Z');const monitor=createTaskMonitor({store,now:()=>time,listRuns:()=>[{...tasks.getRunControl(p,run.id),createdAt:'2026-10-17T09:00:00Z',routing:{mode:'existing',executionConversationId:'fixture',destinationConversationId:null}}],inspect:async()=>{checked++;return 'unreachable';}});await monitor.tick();expect(checked).toBe(1);expect(tasks.getRunControl(p,run.id).monitor).toMatchObject({reason:'host_offline',nativeState:'unreachable',attention:true});await monitor.tick();expect(checked).toBe(1);time+=60000;await monitor.tick();expect(checked).toBe(2);expect(store.listOutbox(0).filter(e=>e.type==='task.execution_attention')).toHaveLength(1);expect(tasks.getRun(p,run.id).state).toBe('running');expect(tasks.listRuns(p,run.taskId)).toHaveLength(1);monitor.close();});
test('verified old Run records its checks without completing an edited goal',async()=>{const {tasks,assets,files,home}=setup();const task=tasks.createTask(p,{...input,acceptance:'checks',criteria:[{id:'hash',text:'Verify immutable bytes',checkRef:'artifact:integrity'}]},'old-goal'),run=tasks.startTask(p,task.id,1,'old-goal-start'),identity={runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:run.id};tasks.bindRunIdentity(identity);const agent={...p,agentId:'a',runId:run.id};writeFileSync(join(home,'old-result.txt'),'old goal output');const staged=await files.stageFiles(agent,run.id,[{allowedRoot:home,relativePath:'old-result.txt',manifestPath:'old-result.txt'}]);const output=assets.importAsset(agent,{kind:'file',title:'Old result',agentId:'a',submissionId:staged.submissionId},'old-output');const current=tasks.getTask(p,task.id);tasks.updateTask(p,task.id,current.revision,{goal:'New goal requiring more work'},'new-goal');tasks.applyRunEvent({...identity,eventKey:'old-terminal',outcome:'succeeded',summary:'Old output',artifactVersions:[{assetId:output.asset.id,versionId:output.version.id}]});expect(tasks.getTask(p,task.id)).toMatchObject({state:'review',completion:null});expect(tasks.getRun(p,run.id).completion).toMatchObject({completedBy:'checks',sourceRunId:run.id});expect(tasks.getRun(p,run.id).snapshot?.goal).toBe(task.goal);});
test('approval and later unknown are distinct bounded attention events',async()=>{const {createTaskMonitor}=await import('../server/task-monitor');const {tasks,store}=setup(),{run,event}=running(tasks);tasks.setRunApproval(event,true);tasks.setRunApproval(event,true);tasks.setRunApproval(event,false);tasks.setRunApproval(event,true);tasks.setRunApproval(event,false);const monitor=createTaskMonitor({store,now:()=>Date.parse('2026-10-17T10:00:00Z'),listRuns:()=>[{...tasks.getRunControl(p,run.id),createdAt:'2026-10-17T09:00:00Z',routing:{mode:'existing',executionConversationId:'fixture',destinationConversationId:null}}],inspect:async()=>'unknown'});await monitor.tick();await monitor.tick();expect(store.listOutbox(0).filter(e=>e.type==='task.execution_attention').map(e=>(e.payload as {reason:string}).reason)).toEqual(['approval','unknown']);monitor.close();});

test('run progress looks up its indexed events without scanning unrelated conversation history', () => {
 const {store,tasks}=setup(),{run}=running(tasks);
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 store.appendEvent(chat.id,'text',{runId:run.id,text:'Progress'});
 const at=store.database.prepare('SELECT createdAt FROM events WHERE conversationId=? ORDER BY id DESC LIMIT 1').get(chat.id)!.createdAt;
 for(let i=0;i<100;i++)store.appendEvent(chat.id,'text',{text:'Unrelated later history'});
 expect(tasks.getRun(p,run.id).monitor!.lastProgressAt).toBe(at);
 const plan=store.database.prepare("EXPLAIN QUERY PLAN SELECT createdAt FROM events WHERE json_extract(data,'$.runId')=? AND kind IN ('text','tool','approval','error') ORDER BY id DESC LIMIT 1").all(run.id).map(row=>row.detail).join(' ');
 expect(plan).toContain('SEARCH events');
});

test('task and execution projections never expose a peer private execution instruction or title',async()=>{
 const {store,tasks,coordinator,executor,run}=await scopedSnapshot();
 store.renameConversation(run.routing!.executionConversationId,'Private executor title');
 store.database.prepare('UPDATE task_executions SET request=? WHERE id=?').run('Private executor instructions',run.executionId);
 expect(tasks.getTask(executor,run.taskId).executions[0]).toMatchObject({request:'Private executor instructions',title:'Private executor title'});
 expect(tasks.getTask(coordinator,run.taskId).executions).toEqual([]);expect(tasks.listTasks(coordinator)[0].executions).toEqual([]);expect(tasks.listExecutions(coordinator,run.taskId)).toEqual([]);
 expect(()=>tasks.getExecution(coordinator,run.executionId)).toThrow(expect.objectContaining({status:403}));
 expect(tasks.getRunControl(coordinator,run.id)).toMatchObject({id:run.id,executionId:run.executionId});
});

test.each([false,true])('all contributing checks retain evidence and notify origin after automatic completion (reverse=%s)',async reverse=>{
 const {store,tasks,assets,files,home}=setup(),owner={userId:store.ownerUserId},origin=store.createConversation({agentId:'coordinator',projectId:'',cli:'codex',model:null}),task=tasks.createTask(owner,{goal:'Verified files',criteria:[{id:'integrity',text:'Verify bytes',checkRef:'artifact:integrity'}],acceptance:'checks',originConversationId:origin.id,participantAgentIds:['coordinator']},'checked-task');
 const runs=['first','second'].map(key=>{const chat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),execution=tasks.createExecution(owner,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:key},key),prepared=tasks.prepareStart(owner,task.id,tasks.getTask(owner,task.id).revision,'start-'+key,undefined,{executionId:execution.id}),run=store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:origin.id}));tasks.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:run.id,nativeTurnId:'turn'});return run;});
 const finishing=reverse?[...runs].reverse():runs,outputs:{assetId:string;versionId:string}[]=[];
 for(const [index,run] of finishing.entries()){
  const actor={...owner,agentId:'a',runId:run.id},path='result-'+index+'.txt';writeFileSync(join(home,path),'Verified result '+index);const staged=await files.stageFiles(actor,run.id,[{allowedRoot:home,relativePath:path,manifestPath:path}]),asset=assets.createAsset(actor,{kind:'file',title:path,owner:actor}),version=assets.publishAssetVersion(actor,{assetId:asset.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:run.id,sourceVersions:[]}},'publish-'+index);assets.setAccess(owner,asset.id,{mode:'all'},assets.getAuthorizedAsset(owner,asset.id).revision);
  const output={assetId:asset.id,versionId:version.id};outputs.push(output);
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-04T00:00:0'+index+'Z'));
  try{tasks.applyRunEvent({runId:run.id,hostId:'local',nativeSessionId:run.id,nativeTurnId:'turn',eventKey:'done-'+index,outcome:'succeeded',summary:'Checked result '+index,artifactVersions:[output]});}finally{vi.useRealTimers();}
 }
 const completed=tasks.getTask(owner,task.id);
 expect(completed).toMatchObject({state:'completed',completion:{completedBy:'checks',acceptedAt:'2026-11-04T00:00:01.000Z',sourceRunId:finishing.at(-1)!.id}});
 expect(completed.completion!.artifactVersions).toHaveLength(2);expect(completed.completion!.artifactVersions).toEqual(expect.arrayContaining(outputs));
 expect(completed.completion!.checks?.map(check=>check.identity.runId).sort()).toEqual(runs.map(run=>run.id).sort());
 const receipts=tasks.listReceipts(owner,task.id);expect(receipts).toHaveLength(2);for(const receipt of receipts)expect(tasks.authorizeReceiptDelivery({...owner,agentId:'coordinator'},receipt.id,origin.id)).toMatchObject({policy:'notify',deliveryState:'pending'});
});
