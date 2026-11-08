import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
const root = { userId: 'local' }, at = '2026-10-07T00:00:00Z';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));
function setup() {
 const home = mkdtempSync(join(tmpdir(), 'memory-job-failure-')), store = openStore(home);
 cleanup.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
 const assets = createAssets(store, createAssetFiles(home)), tasks = createTasks(store, { assets });
 const memory = createMemoryStore(store, { assets, tasks, localUserId: 'local' }), jobs = createMemoryJobs(store, memory);
 const collection = memory.ensureCollection(root, { projectId: null, agentId: null });
 const capture = () => {
  const chat = store.createConversation({ projectId: '', agentId: '', cli: 'codex', model: null });
  store.appendEvent(chat.id, 'user', { text: 'Synthetic source stays available.' }, at);
  store.appendEvent(chat.id, 'status', { status: 'idle' }, at);
  return memory.captureConversation(root, { collectionId: collection.id, conversationId: chat.id, trigger: 'explicit', kind: 'request' }).jobs[0];
 };
 return { store, memory, jobs, capture };
}
const validationErrors = ['dependency_not_provided', 'stale_memory_dependency', 'unsupported_user_scope', 'unsupported_extract', 'tool_observation_scope_required', 'consolidation_no_coverage'];
test.each(validationErrors)('%s keeps progress and stops automatic retries', error => {
 const s = setup(), captured = s.capture();
 const row = { ...captured, availableAt: at, extraction: { nextChunk: 22, totalChunks: 26 } };
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(row), row.id);
 const job = s.jobs.claim('worker', at)!;
 s.jobs.fail(job.id, job.leaseToken, error, at);
 expect(s.jobs.list(root)[0]).toMatchObject({ state: 'failed', error, attempt: 1, extraction: row.extraction, sourceRefs: row.sourceRefs });
 expect(s.jobs.claim('worker', '2026-10-08T00:00:00Z')).toBeNull();
});
test.each(['dependency_not_provided', 'stale_memory_dependency', 'verification_no_result', 'verification_identity_changed', 'invalid_replacement'])('legacy queued %s failures are parked without blocking fresh jobs or losing checkpoints', error => {
 const s = setup(), old = s.capture(), fresh = s.capture();
 const legacy = { ...old, state: 'queued', error, attempt: 898, availableAt: at, extraction: { nextChunk: 2, totalChunks: 25 } };
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(legacy), old.id);
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...fresh, availableAt: at }), fresh.id);
 s.store.database.exec('CREATE TABLE memory_extraction_drafts(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 const checkpoint = JSON.stringify({ atoms: [], nextAtom: 2, summary: 'Saved synthetic summary.' });
 s.store.database.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?)').run(old.id, checkpoint);
 expect(s.jobs.claim('worker', at)).toMatchObject({ id: fresh.id, attempt: 1 });
 expect(s.jobs.list(root).find(job => job.id === old.id)).toMatchObject({ state: 'failed', error: legacy.error, attempt: 898, extraction: legacy.extraction, sourceRefs: old.sourceRefs });
 expect(s.store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(old.id)?.data).toBe(checkpoint);
});
test.each(['generation_timed_out', 'quota_exhausted'])('%s remains recoverable with its existing backoff', error => {
 const s = setup(), captured = s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...captured, availableAt: at }), captured.id);
 const job = s.jobs.claim('worker', at)!;
 s.jobs.fail(job.id, job.leaseToken, error, at);
 const queued = s.jobs.list(root)[0];
 expect(queued).toMatchObject({ state: 'queued', error });
 expect(s.jobs.claim('worker', at)).toBeNull();
 expect(s.jobs.claim('worker', queued.availableAt)).toMatchObject({ id: job.id });
});
test.each(['verification_no_result', 'verification_identity_changed', 'invalid_replacement', 'memory_rewrite_requires_new_proof'])('%s may recover from model output errors but stops after one retry', error => {
 const s = setup(), captured = s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({ ...captured, availableAt: at }), captured.id);
 let next = at;
 for (let attempt = 1; attempt <= 2; attempt++) {
  const job = s.jobs.claim('worker', next)!;
  s.jobs.fail(job.id, job.leaseToken, error, next);
  const failed = s.jobs.list(root)[0];
  expect(failed).toMatchObject({ state: attempt < 2 ? 'queued' : 'failed', error, attempt });
  next = failed.availableAt;
 }
 expect(s.jobs.claim('worker', '2026-10-08T00:00:00Z')).toBeNull();
});

test.each(['quota_exhausted', 'network_error', 'invalid_memory_generation'])('%s has one retry across stages and worker restarts', error => {
 const s=setup(), captured=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...captured,availableAt:at}),captured.id);
 let worker=s.jobs;
 // Recreate the jobs controller between attempts to exercise persisted state.
 let job=s.jobs.claim('first',at)!;
 s.jobs.fail(job.id,job.leaseToken,error,at);
 const retryAt=s.jobs.list(root)[0].availableAt;
 job=s.jobs.claim('second',retryAt)!;
 s.jobs.advance(job,'scene',retryAt);
 worker=createMemoryJobs(s.store,s.memory);
 job=worker.claim('restarted',retryAt)!;
 worker.fail(job.id,job.leaseToken,error,retryAt);
 expect(worker.list(root)[0]).toMatchObject({state:'failed',failureCount:2});
 expect(worker.claim('later','2026-10-08T00:00:00Z')).toBeNull();
});

test('legacy pauses do not consume retry budget and resumed work still gets one retry',()=>{
 const s=setup(),captured=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...captured,state:'queued',error:'memory_generation_disabled',attempt:20,availableAt:at}),captured.id);
 const job=s.jobs.claim('resumed',at)!;expect(job).not.toBeNull();
 s.jobs.fail(job.id,job.leaseToken,'quota_exhausted',at);
 expect(s.jobs.list(root)[0]).toMatchObject({state:'queued',failureCount:1});
});
test('repeated expired leases stop after one recovery across worker restarts',()=>{
 const s=setup(),captured=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...captured,availableAt:at}),captured.id);
 const first=s.jobs.claim('first',at)!;
 const second=createMemoryJobs(s.store,s.memory).claim('restarted',first.leaseUntil!)!;
 expect(second).toMatchObject({failureCount:1});
 expect(createMemoryJobs(s.store,s.memory).claim('again',second.leaseUntil!)).toBeNull();
 expect(s.jobs.list(root)[0]).toMatchObject({state:'failed',failureCount:2});
});

test('legacy quota retries already beyond the limit are parked even when outputFailures is zero',()=>{
 const s=setup(),captured=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...captured,state:'queued',error:'quota_exhausted',attempt:7,outputFailures:0,availableAt:at}),captured.id);
 expect(s.jobs.claim('upgraded',at)).toBeNull();
 expect(s.jobs.list(root)[0]).toMatchObject({state:'failed',error:'quota_exhausted'});
});
test.each(['source_changed','source_retracted','memory_source_not_found','generation_changed','forbidden'])('%s ends obsolete immediately and never blocks fresh work after restart',error=>{
 const s=setup(),old=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...old,availableAt:at}),old.id);
 const running=s.jobs.claim('first',at)!;s.jobs.fail(running.id,running.leaseToken,error,at);
 expect(s.jobs.list(root).find(job=>job.id===old.id)).toMatchObject({state:'obsolete',error,failureCount:1,leaseUntil:null,workerId:null});
 const restarted=createMemoryJobs(s.store,s.memory),fresh=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...fresh,availableAt:at}),fresh.id);
 expect(restarted.claim('restarted',at)).toMatchObject({id:fresh.id,attempt:1});
 expect(restarted.list(root).find(job=>job.id===old.id)?.state).toBe('obsolete');
});
test('a legacy queued source-change failure is retired before its backoff and excluded from the effective queue',()=>{
 const s=setup(),old=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...old,state:'queued',error:'source_changed',failureCount:1,availableAt:'2099-01-01T00:00:00Z'}),old.id);
 expect(s.jobs.claim('restarted',at)).toBeNull();
 expect(s.jobs.list(root)[0]).toMatchObject({state:'obsolete',error:'source_changed',leaseUntil:null,workerId:null});
});
test('automatic capture does not offer an unchanged invalid processing unit again, while a new turn remains eligible',()=>{
 const s=setup(),old=s.capture();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...old,availableAt:at}),old.id);
 const running=s.jobs.claim('first',at)!;s.jobs.fail(running.id,running.leaseToken,'source_changed',at);
 const restarted=createMemoryJobs(s.store,s.memory);
 expect(s.memory.captureConversation(root,{collectionId:old.collectionId,conversationId:old.conversationId!,trigger:'explicit',kind:'request'}).jobs).toEqual([]);
 s.store.appendEvent(old.conversationId!,'user',{text:'A fresh independently supported request.'});s.store.appendEvent(old.conversationId!,'status',{status:'idle'});
 const fresh=s.memory.captureConversation(root,{collectionId:old.collectionId,conversationId:old.conversationId!,trigger:'explicit',kind:'request'}).jobs[0];
 expect(fresh).toMatchObject({state:'queued',error:null});expect(fresh.id).not.toBe(old.id);
 expect(restarted.claim('restarted','2099-01-01T00:00:00Z')).toMatchObject({id:fresh.id});
});

test('a 28-job backlog advances each due job without duplicate claims or starving later stages',()=>{
 const s=setup(),captured=Array.from({length:28},()=>s.capture());
 for(const job of captured)s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,availableAt:at}),job.id);
 const claimed=[];
 for(let index=0;index<captured.length;index++){
  const job=s.jobs.claim('worker',at)!;expect(job).not.toBeNull();claimed.push(job.id);
  s.jobs.advance(job,'conflict','2026-10-07T00:00:01Z');
 }
 expect(new Set(claimed).size).toBe(28);expect(s.jobs.claim('worker',at)).toBeNull();
 for(let index=0;index<captured.length;index++){
  const job=s.jobs.claim('worker','2026-10-07T00:00:01Z')!;expect(job.stage).toBe('conflict');s.jobs.complete(job.id,job.leaseToken,'2026-10-07T00:00:01Z');
 }
 expect(s.jobs.claim('worker','2026-10-07T00:00:01Z')).toBeNull();
 expect(s.jobs.list(root,{states:['completed']})).toHaveLength(28);
});
