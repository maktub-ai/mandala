import {createTaskWithExecutions} from './helpers/task-executions';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../server/store';
import { bindWorkspaceOwner, workspacePrincipal } from '../server/workspace-identity';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
import { memoryServices, MEMORY_CUTOVER } from '../server/memory-runtime';
import { createTaskScheduler } from '../server/task-scheduler';
import { readKnowledge, createKnowledge, KNOWLEDGE_CUTOVER } from '../server/knowledge';

const homes: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'workspace-identity-')); homes.push(home);
  const store = openStore(home); stores.push(store);
  return { home, store };
}
test('owner binds durably once and existing principals follow the real identity', () => {
  const { home, store } = setup(), principal = workspacePrincipal(store);
  expect(store.ownerUserId).toBe('local');
  expect(principal.userId).toBe('local');
  bindWorkspaceOwner(store, 'owner-123');
  expect(store.ownerUserId).toBe('owner-123');
  expect(principal.userId).toBe('owner-123');
  bindWorkspaceOwner(store, 'owner-123');
  expect(() => bindWorkspaceOwner(store, 'other-user')).toThrow('workspace_owner_mismatch');
  expect(store.ownerUserId).toBe('owner-123');
  const reopened = openStore(home); stores.push(reopened);
  expect(reopened.ownerUserId).toBe('owner-123');
});
test('unclaimed workspaces cannot bind missing or reserved legacy identities', () => {
  const { store } = setup();
  for (const id of ['', ' ', 'local']) expect(() => bindWorkspaceOwner(store, id)).toThrow('invalid_workspace_owner');
  expect(store.ownerUserId).toBe('local');
});
test('repeated principal checks reuse query compilation and still observe an owner claim after await', async () => {
  const {store}=setup(),principal=workspacePrincipal(store),prepare=vi.spyOn(store.database,'prepare');
  try {
    for(let i=0;i<500;i++)expect(principal.userId).toBe('local');
    expect(prepare.mock.calls.filter(([sql])=>sql.includes('SELECT owner_user_id FROM workspace_identity'))).toHaveLength(0);
    bindWorkspaceOwner(store,'fresh-owner');await Promise.resolve();
    expect(principal.userId).toBe('fresh-owner');
  } finally {prepare.mockRestore();}
});
test('initial claim retains assets, task command replay, memory, history and published file bytes', async () => {
  const { home, store } = setup(), p = workspacePrincipal(store);
  const { memory, tasks, jobs } = memoryServices(home, store);
  const chat = store.createConversation({ projectId: '', agentId: 'a', cli: 'codex', model: null });
  const event = store.appendEvent(chat.id, 'user', { text: 'local remains a literal history word' });
  store.appendEvent(chat.id, 'text', { text: 'Local answer' });
  store.appendEvent(chat.id, 'status', { status: 'idle' });
  const taskInput = { goal: 'Keep personal task', criteria: [], acceptance: 'delivery' as const, projectId: null, assigneeAgentId: 'a' };
  const task = tasks.createTask(p, taskInput, 'personal-task');
  const collection = memory.ensureCollection(p, { projectId: null, agentId: 'a' });
  const capture = memory.captureConversation(p, { collectionId: collection.id, conversationId: chat.id, trigger: 'completed' });
  memory.importLegacy(p, [{ id: 'old-memory', kind: 'memory', title: 'Personal preference', content: '保留我的记忆', scope: 'global', status: 'active', createdAt: '2026-10-01', updatedAt: '2026-10-01' }]);
  const files = createAssetFiles(home), assets = createAssets(store, files);
  writeFileSync(join(home, 'personal.md'), 'personal file local');
  const staged = await files.stageFiles(p, null, [{ allowedRoot: home, relativePath: 'personal.md', manifestPath: 'document.md' }]);
  const imported = assets.importAsset(p, { kind: 'document', title: 'Personal document', submissionId: staged.submissionId }, 'personal-asset');
  const foreign = assets.createAsset({ userId: 'unrelated' }, { kind: 'document', title: 'Foreign', owner: { userId: 'unrelated' } });
  const before = store.listEvents(chat.id, 0);

  bindWorkspaceOwner(store, 'owner-123');

  expect(tasks.getTask(p, task.id).ownerUserId).toBe('owner-123');
  expect(tasks.createTask(p, taskInput, 'personal-task').id).toBe(task.id);
  expect(createTaskWithExecutions(store,tasks,p,{...taskInput},[chat.id],'new-linked-task').ownerUserId).toBe('owner-123');
  expect(assets.importAsset(p, { kind: 'document', title: 'Personal document', submissionId: staged.submissionId }, 'personal-asset').asset.id).toBe(imported.asset.id);
  expect(assets.getAuthorizedAsset(p, imported.asset.id).owner.userId).toBe('owner-123');
  const file = assets.readAssetFile(p, { assetId: imported.asset.id, versionId: imported.version.id }, '0');
  expect(readFileSync(file.blobPath, 'utf8')).toBe('personal file local');
  expect(assets.getAuthorizedAsset({ userId: 'unrelated' }, foreign.id).owner.userId).toBe('unrelated');
  expect(() => assets.getAuthorizedAsset({ userId: 'local' }, imported.asset.id)).toThrow('forbidden');
  expect(memory.ensureCollection(p, { projectId: null, agentId: 'a' }).id).toBe(collection.id);
  expect(memory.listAll(p).find(item => item.legacyId === 'old-memory')?.text).toBe('保留我的记忆');
  expect(jobs.list(p).find(job => job.id === capture.jobs[0].id)?.principal.userId).toBe('owner-123');
  expect(() => memory.listAll({ userId: 'local' })).toThrow('forbidden');
  expect(store.getConversation(chat.id)?.id).toBe(chat.id);
  expect(store.listEvents(chat.id, 0)).toEqual(before);
  expect(store.listEvents(chat.id, 0)[0].id).toBe(event.id);
  expect(store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const reopened = openStore(home); stores.push(reopened);
  const restored = memoryServices(home, reopened), restoredPrincipal = workspacePrincipal(reopened);
  expect(restored.tasks.getTask(restoredPrincipal, task.id).ownerUserId).toBe('owner-123');
  expect(restored.memory.listAll(restoredPrincipal).find(item => item.legacyId === 'old-memory')?.text).toBe('保留我的记忆');
  expect(reopened.listEvents(chat.id, 0)).toEqual(before);
});
test('knowledge projection and new writes use the supplied bound workspace owner', async () => {
  const { home, store } = setup(); memoryServices(home, store);
  for (const key of [KNOWLEDGE_CUTOVER, MEMORY_CUTOVER]) store.database.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key, '2026-10-11');
  bindWorkspaceOwner(store, 'owner-123');
  const config = { version: 2 as const, projects: [], agents: [] };
  const entry = await createKnowledge(home, { kind: 'document', title: 'Identity document', content: 'Persist this content', scope: 'global', status: 'active' }, config, false, store);
  await createKnowledge(home, { kind: 'memory', title: 'Identity memory', content: 'Persist this memory', scope: 'global', status: 'active' }, config, false, store);
  expect((await readKnowledge(home, store)).map(item => item.title)).toEqual(expect.arrayContaining(['Identity document', 'Identity memory']));
  const assets = createAssets(store, createAssetFiles(home));
  expect(assets.getAuthorizedAsset({ userId: 'owner-123' }, entry.id).owner.userId).toBe('owner-123');
});
test('a scheduler constructed before claim retains queued personal input and writes with the real owner', () => {
  const { home, store } = setup(), principal = workspacePrincipal(store), { tasks } = memoryServices(home, store);
  const chat = store.createConversation({ projectId: '', agentId: 'a', cli: 'codex', model: null });
  const scheduler = createTaskScheduler(store, tasks, { principal });
  const input = scheduler.enqueueUserInput(chat.id, 'My queued input', 'personal-input');
  bindWorkspaceOwner(store, 'owner-123');
  expect(scheduler.listUserInputs(chat.id)[0].id).toBe(input.id);
  expect(scheduler.enqueueUserInput(chat.id, 'My queued input', 'personal-input').id).toBe(input.id);
  const next = scheduler.enqueueUserInput(chat.id, 'New input', 'new-input');
  expect(store.database.prepare('SELECT owner_user_id FROM task_user_inputs WHERE id=?').get(next.id)?.owner_user_id).toBe('owner-123');
});
test('ownership migration rolls back all changes if a legacy scope collides with the target owner', () => {
  const { store, home } = setup(), p = workspacePrincipal(store), { memory } = memoryServices(home, store);
  const collection = memory.ensureCollection(p, { projectId: null, agentId: null });
  const foreign = createAssets(store, createAssetFiles(home)).createAsset({ userId: 'owner-123' }, { kind: 'memory_collection', title: 'Conflicting scope', owner: { userId: 'owner-123' } });
  store.database.prepare('INSERT INTO memory_collections VALUES (?,?,?)').run(foreign.id, JSON.stringify(['owner-123', null, null]), '{}');
  expect(() => bindWorkspaceOwner(store, 'owner-123')).toThrow();
  expect(store.ownerUserId).toBe('local');
  expect(memory.ensureCollection(p, { projectId: null, agentId: null }).id).toBe(collection.id);
  expect(createAssets(store, createAssetFiles(home)).getAuthorizedAsset(p, collection.id).owner.userId).toBe('local');
});
test('session manager follows first owner claim when authorizing queued inputs',async()=>{
 const {home,store}=setup();const {createSessionManager}=await import('../server/sessions');const {readConfig}=await import('../server/config');
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
 try{const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});bindWorkspaceOwner(store,'owner-session');const queued=manager.enqueueUserInput(chat.id,'Personal queued work','owner-queue');expect(store.database.prepare('SELECT owner_user_id FROM task_user_inputs WHERE id=?').get(queued.id)?.owner_user_id).toBe('owner-session');}finally{await manager.close();}
});
