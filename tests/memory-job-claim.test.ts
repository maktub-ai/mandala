import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
import type { MemoryJob } from '../shared/memory';

const root = { userId: 'local' }, now = '2026-10-26T00:00:00.000Z';
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(close => close()); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'memory-job-claim-')), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const assets = createAssets(store, createAssetFiles(home)), tasks = createTasks(store, { assets });
  const memory = createMemoryStore(store, { assets, tasks, localUserId: 'local' }), jobs = createMemoryJobs(store, memory);
  const collection = memory.ensureCollection(root, { projectId: null, agentId: null });
  const insert = store.database.prepare('INSERT INTO memory_jobs VALUES(?,?,?)');
  const add = (id: string, changes: Partial<MemoryJob> = {}) => {
    const job: MemoryJob = { id, collectionId: collection.id, principal: root, sourceRefs: [], generation: collection.generation,
      state: 'queued', attempt: 0, leaseToken: 0, leaseUntil: null, workerId: null, availableAt: now, createdAt: now, error: null, extractorVersion: 'fixture', ...changes };
    insert.run(id, id, JSON.stringify(job));
    return job;
  };
  const load = (id: string): MemoryJob => JSON.parse(store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(id)!.data as string);
  return { store, jobs, add, load };
}
test('idle claims skip 30000 terminal jobs without parsing them or sorting retained history', () => {
  const s = setup();
  const sourceRefs = Array.from({ length: 8 }, (_, i) => ({ sourceId: 'synthetic-' + i, sourceRevision: 1 }));
  s.store.transaction(() => { for (let i = 0; i < 30000; i++) s.add('terminal-' + i, { state: 'completed', sourceRefs }); });
  const parse = vi.spyOn(JSON, 'parse'), prepare = vi.spyOn(s.store.database, 'prepare'), times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    expect(s.jobs.claim('idle-worker', now)).toBeNull();
    times.push(Number((performance.now() - start).toFixed(3)));
  }
  const parsedRows = parse.mock.calls.length;
  const query = prepare.mock.calls.map(call => call[0]).find(sql => sql.startsWith('SELECT data FROM memory_jobs'))!;
  const plan = s.store.database.prepare('EXPLAIN QUERY PLAN ' + query).all().map(row => String(row.detail));
  console.info(JSON.stringify({ fixture: '30000_completed_jobs_8_refs', claimMilliseconds: times, parsedRows, plan }));
  expect(parsedRows).toBe(0);
  expect(plan.some(detail => /USING INDEX/i.test(detail))).toBe(true);
  expect(plan.some(detail => /TEMP B-TREE/i.test(detail))).toBe(false);
  // Index membership must update when queued jobs become running/completed.
  s.add('first', { availableAt: '2026-10-25T00:00:00.000Z' });s.add('second');
  expect(s.jobs.claim('worker', now)?.id).toBe('first');
  s.jobs.complete('first', 1, now);
  expect(s.jobs.claim('worker', now)?.id).toBe('second');
  s.jobs.complete('second', 1, now);
  expect(s.jobs.claim('worker', now)).toBeNull();
});
test('claim preserves availableAt priority and insertion order for ties', () => {
  const s = setup();s.add('later');s.add('tie-first', { availableAt: '2026-10-25T00:00:00.000Z' });s.add('tie-second', { availableAt: '2026-10-25T00:00:00.000Z' });
  expect(s.jobs.claim('worker', now)?.id).toBe('tie-first');
  expect(s.jobs.claim('worker', now)?.id).toBe('tie-second');
  expect(s.jobs.claim('worker', now)?.id).toBe('later');
});
test.each([
  { name: 'queued due', changes: {}, claimed: true },
  { name: 'queued future', changes: { availableAt: '2026-10-27T00:00:00Z' }, claimed: false },
  { name: 'expired lease', changes: { state: 'running', availableAt: '2026-10-27T00:00:00Z', leaseUntil: '2026-10-25T00:00:00Z', leaseToken: 4 }, claimed: true },
  { name: 'unexpired lease', changes: { state: 'running', leaseUntil: '2026-10-27T00:00:00Z' }, claimed: false },
  { name: 'running without lease', changes: { state: 'running' }, claimed: false },
  { name: 'chunking due', changes: { state: 'pending', kind: 'request', error: 'needs_chunking' }, claimed: true },
  { name: 'chunking without kind', changes: { state: 'pending', error: 'needs_chunking' }, claimed: false },
  { name: 'chunking future', changes: { state: 'pending', kind: 'session', error: 'needs_chunking', availableAt: '2026-10-27T00:00:00Z' }, claimed: false },
  { name: 'other pending reason', changes: { state: 'pending', kind: 'request', error: 'manual_review' }, claimed: false },
] satisfies { name: string; changes: Partial<MemoryJob>; claimed: boolean }[])('$name retains eligibility and lease fencing', ({ changes, claimed }) => {
  const s = setup(), original = s.add('job', changes), result = s.jobs.claim('worker', now);
  if (!claimed) { expect(result).toBeNull();expect(s.load('job')).toEqual(original);return; }
  expect(result).toMatchObject({ state: 'running', attempt: original.attempt + 1, leaseToken: original.leaseToken + 1, workerId: 'worker', leaseUntil: '2026-10-26T00:10:00.000Z' });
  if (original.state === 'pending') expect(result?.error).toBeNull();
});
test('kind filtering precedes future correction and missing kinds default to request', () => {
  const s = setup();s.add('legacy-correction', { error: 'dependency_not_provided', availableAt: '2026-10-27T00:00:00Z' });
  s.add('session-correction', { kind: 'session', error: 'dependency_not_provided', availableAt: '2026-10-27T00:00:00Z' });
  expect(s.jobs.claim('worker', now, ['request'])).toBeNull();
  expect(s.load('legacy-correction').state).toBe('failed');expect(s.load('session-correction').state).toBe('queued');
  expect(s.jobs.claim('worker', now, [])).toBeNull();expect(s.load('session-correction').state).toBe('queued');
  expect(s.jobs.claim('worker', now, ['session'])).toBeNull();expect(s.load('session-correction').state).toBe('failed');
});
test('an obsolete earlier source does not block the next valid job', () => {
  const s = setup();s.add('stale', { generation: 999 });s.add('valid');
  expect(s.jobs.claim('worker', now)?.id).toBe('valid');expect(s.load('stale')).toMatchObject({ state: 'obsolete', error: 'generation_changed' });
});

test('manual priority stays ahead of older automatic jobs and ties retain insertion order', () => {
  const s = setup();
  s.add('automatic', { availableAt: '2026-10-20T00:00:00.000Z' });
  s.add('manual-first', { manualPriority: true });s.add('manual-second', { manualPriority: true });
  s.add('lower-manual', { manualPriority: false });
  expect(s.jobs.claim('worker', now)?.id).toBe('manual-first');
  expect(s.jobs.claim('worker', now)?.id).toBe('manual-second');
  expect(s.jobs.claim('worker', now)?.id).toBe('automatic');
  expect(s.jobs.claim('worker', now)?.id).toBe('lower-manual');
});
