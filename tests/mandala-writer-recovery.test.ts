import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { ensureMandalaConversation, mandalaContextBoundary, mandalaContinuity } from '../server/mandala';
import { createSessionManager } from '../server/sessions';
import type { CodexClient } from '../server/codex';
import { DomainError } from '../shared/workspace-contracts';
import { ensureConfiguredMandala } from './configured-mandala';
import { businessCliContext } from './business-cli-context';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'mandala-writer-recovery-'));
  const store = openStore(home);
  const { config } = await ensureConfiguredMandala(home);
  const chat = ensureMandalaConversation(store, config);
  const controls = { token: '', held: true, lostStart: false, loseNameReply: false, wait: undefined as Promise<void> | undefined };
  const named = new Map<string, string>();
  const starts: Parameters<CodexClient['startThread']>[0][] = [];
  const resumes: string[] = [];
  const turns: { id: string; text: string }[] = [];
  const newManager = () => {
    const manager = createSessionManager(store, async () => config, async () => ({
      getStatus: async () => ({ status: 'ready', version: 'fixture' }),
      listModels: async () => [],
      resumeThread: async (id, _mcp, instructions) => {
        resumes.push(id);
        if (instructions) controls.token = businessCliContext(instructions).token;
        if (id === 'original-native' && controls.held)
          throw new DomainError('native_thread_busy', 409, 'Original writer held');
      },
      startThread: async input => {
        starts.push(input);
        await controls.wait;
        if (controls.lostStart) throw new Error('Lost start response');
        return 'isolated-native';
      },
      nameEmptyThread: async (id: string, name: string) => {
        named.set(id, name);
        if (controls.loseNameReply) throw new Error('Lost name response');
      },
      readEmptyNamedThread: async (id: string, name: string) => named.get(id) === name,
      startTurn: async (id, text) => { turns.push({ id, text }); return 'turn-1'; },
      interrupt: async () => { throw Error('Unexpected interrupt'); },
      replyApproval() {},
      close() {},
    }), undefined, home);
    cleanup.push(() => manager.close());
    return manager;
  };
  cleanup.push(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const manager = newManager();
  store.updateConversation(chat.id, { nativeId: 'original-native' });
  store.appendEvent(chat.id, 'user', { text: 'Old private transcript' });
  store.appendEvent(chat.id, 'text', { text: 'Old native answer' });
  await expect(manager.send(chat.id, 'Unsubmitted private draft')).rejects.toMatchObject({ code: 'native_thread_busy' });
  const conflictId = store.listEvents(chat.id, 0).find(event => event.kind === 'error')!.id;
  return { store, manager, newManager, chat, conflictId, controls, starts, resumes, turns };
}

it('prefers the original Codex ID after release without sending or creating', async () => {
  const { manager, chat, conflictId, controls, starts, resumes, turns, store } = await setup();
  expect(manager.writerRecoveryStatus(chat.id)).toMatchObject({ conflictId, state: 'held' });
  controls.held = false;
  await expect(manager.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'released' });
  expect(starts).toEqual([]);
  expect(turns).toEqual([]);
  expect(resumes).toEqual(['original-native', 'original-native']);
  expect(store.getConversation(chat.id)?.nativeId).toBe('original-native');
  await manager.continue(chat.id, 'One manual turn');
  expect(turns).toEqual([{ id: 'original-native', text: 'One manual turn' }]);
});

it('links one empty native thread atomically and preserves the old transcript across reload and manual send', async () => {
  const { manager, newManager, chat, conflictId, starts, turns, store } = await setup();
  const previous = store.listEvents(chat.id, 0);
  expect(starts).toEqual([]);
  await expect(manager.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'linked', nativeId: 'isolated-native' });
  await expect(manager.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'linked' });
  expect(starts).toEqual([expect.objectContaining({ instructions: '', safeSystem: true, ephemeral: false })]);
  expect(starts[0]).not.toHaveProperty('mcp');
  expect(turns).toEqual([]);
  expect(store.getConversation(chat.id)).toMatchObject({ nativeId: 'isolated-native', continuityPending: false });
  const events = store.listEvents(chat.id, 0);
  expect(events.slice(0, previous.length)).toEqual(previous);
  expect(events.at(-1)?.data).toMatchObject({
    nativeExecutionBoundary: { version: 1, previousNativeId: 'original-native', nativeId: 'isolated-native' },
  });
  expect(mandalaContextBoundary(store, chat.id)).toBe(events.at(-1)?.id);
  expect(mandalaContinuity(store, chat.id)).not.toContain('Old private transcript');
  expect(mandalaContinuity(store, chat.id)).not.toContain('Unsubmitted private draft');
  await manager.close();
  await newManager().continue(chat.id, 'One new manual turn');
  expect(turns).toEqual([{ id: 'isolated-native', text: 'One new manual turn' }]);
});

it('recovers a named empty thread by readback after a lost response and service restart', async () => {
  const { manager, newManager, chat, conflictId, controls, starts, turns, store } = await setup();
  controls.loseNameReply = true;
  await expect(manager.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'unknown', nativeId: 'isolated-native' });
  expect(store.getConversation(chat.id)?.nativeId).toBe('original-native');
  await manager.close();
  const reopened = newManager();
  await expect(reopened.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'unknown' });
  await expect(reopened.recoverCodexWriter(chat.id, conflictId, 'check')).resolves.toMatchObject({ state: 'linked' });
  expect(starts).toHaveLength(1);
  expect(turns).toEqual([]);
  expect(store.getConversation(chat.id)?.nativeId).toBe('isolated-native');
});

it('fences a concurrent confirmation and refuses to recreate after a lost start response', async () => {
  const { manager, newManager, chat, conflictId, controls, starts, turns, store } = await setup();
  controls.lostStart = true;
  let release!: () => void;
  controls.wait = new Promise(resolve => { release = resolve; });
  const first = manager.recoverCodexWriter(chat.id, conflictId, 'isolate');
  try {
    await expect.poll(() => starts.length).toBe(1);
    await expect(manager.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'creating' });
    await expect(manager.continue(chat.id, 'Racing send')).rejects.toThrow();
  } finally { release(); }
  await expect(first).resolves.toMatchObject({ state: 'unknown' });
  await manager.close();
  const reopened = newManager();
  await expect(reopened.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'unknown' });
  await expect(reopened.recoverCodexWriter(chat.id, conflictId, 'check')).resolves.toMatchObject({ state: 'unknown' });
  expect(starts).toHaveLength(1);
  expect(turns).toEqual([]);
  expect(store.getConversation(chat.id)?.nativeId).toBe('original-native');
  expect(mandalaContextBoundary(store, chat.id)).toBe(0);
});

it('parks an earlier inquiry and clears its chat-wide grant while leaving specialist work active', async () => {
  const { manager, chat, store, conflictId, turns } = await setup();
  const target = store.createConversation({ projectId: '', agentId: 'fixture-specialist', cli: 'codex', model: null });
  const origin = store.listEvents(chat.id, 0).find(event => event.kind === 'user')!;
  store.database.prepare(`INSERT INTO agent_messages
    (id,source_conversation_id,target_conversation_id,source_request_event_id,source_invocation_id,text,
     policy,state,reply_state,auto_resume_allowed,request_input_id,command_key,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old-inquiry', chat.id, target.id, origin.id, 'before-boundary', 'Old specialist request',
      'resume', 'running', 'pending', 1, 'old-input', 'old-key', new Date().toISOString());
  const { createConversationApprovals } = await import('../server/conversation-approvals');
  const approvals = createConversationApprovals(store);
  const scope = { conversationId: chat.id, agentId: chat.agentId, projectId: chat.projectId, cli: chat.cli, cwd: chat.cwd! };
  approvals.allow(scope);
  expect(approvals.has(scope)).toBe(true);
  await expect(manager.recoverCodexWriter(chat.id, conflictId, 'isolate')).resolves.toMatchObject({ state: 'linked' });
  expect(approvals.has(scope)).toBe(false);
  expect(store.database.prepare('SELECT state,reply_state,auto_resume_allowed FROM agent_messages WHERE id=?').get('old-inquiry'))
    .toMatchObject({ state: 'running', reply_state: 'parked', auto_resume_allowed: 0 });
  expect(turns).toEqual([]);
});

it('persists an original release after an uncertain creation and preserves its confirmation identity', async () => {
  const { manager, newManager, chat, conflictId, controls, starts, store } = await setup();
  controls.lostStart = true;
  const unknown = await manager.recoverCodexWriter(chat.id, conflictId, 'isolate');
  expect(unknown.state).toBe('unknown');
  controls.held = false;
  await expect(manager.recoverCodexWriter(chat.id, conflictId, 'retry-original'))
    .resolves.toMatchObject({ state: 'released', operationId: unknown.operationId });
  await manager.close();
  const reopened = newManager();
  expect(reopened.writerRecoveryStatus(chat.id)).toMatchObject({ state: 'released', operationId: unknown.operationId });
  expect(store.getConversation(chat.id)?.nativeId).toBe('original-native');
  expect(starts).toHaveLength(1);
});

it('limits the new native invocation’s bound history while preserving owner-visible earlier messages', async () => {
  const { manager, chat, conflictId, controls, store } = await setup();
  await manager.recoverCodexWriter(chat.id, conflictId, 'isolate');
  await manager.continue(chat.id, 'Current human turn');
  const visibleToInvocation = await manager.callBoundTool(controls.token, 'conversation_history', { conversationId: chat.id }, 'read-current-context');
  expect(JSON.stringify(visibleToInvocation)).toContain('Current human turn');
  expect(JSON.stringify(visibleToInvocation)).not.toContain('Old private transcript');
  expect(store.listEvents(chat.id, 0).find(event => (event.data as { text?: string }).text === 'Old private transcript')).toBeTruthy();
});
