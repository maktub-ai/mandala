import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../server/store';
import { bindWorkspaceOwner } from '../server/workspace-identity';
import { createChatPreferences } from '../server/chat-preferences';
import type { Config } from '../shared/types';
import { createElement } from 'react';
import { renderChineseMarkup } from './helpers/render-ui';
import RuntimeSettingsEditor, { AgentApprovalSettings } from '../src/RuntimeSettingsEditor';

const homes: string[] = [], stores: Store[] = [];
const config: Config = {runtimes:['codex','omp'], version: 2, projects: [], agents: ['a', 'b'].map(id => ({
  id, name: id, instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [],
  runtime: { codex: { approvalMode: 'default' } },
})) };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'chat-preferences-')); homes.push(home);
  const store = openStore(home); stores.push(store);
  return { home, store, preferences: createChatPreferences(store) };
}
it('persists an explicit Agent choice after reopening the workspace without changing config or conversations', () => {
  const s = setup(), snapshot = JSON.stringify(config);
  const chat = s.store.createConversation({ projectId: '', agentId: 'a', cli: 'codex', model: null });
  expect(s.preferences.getApproval(config, 'a', 'codex')).toBeNull();
  expect(s.preferences.setApproval(config, 'a', 'codex', 'auto')).toEqual({ approvalMode: 'auto' });
  expect(s.store.getConversation(chat.id)?.approvalMode).toBeUndefined();
  s.store.close(); stores.splice(stores.indexOf(s.store), 1);
  const reopened = openStore(s.home); stores.push(reopened);
  expect(createChatPreferences(reopened).getApproval(config, 'a', 'codex')).toBe('auto');
  expect(JSON.stringify(config)).toBe(snapshot);
  expect(reopened.getConversation(chat.id)?.approvalMode).toBeUndefined();
});
it('keeps Agent and CLI preferences separate and deletes only the requested override on reset', () => {
  const { preferences } = setup();
  preferences.setApproval(config, 'a', 'codex', 'auto');
  preferences.setApproval(config, 'a', 'omp', 'default');
  preferences.setApproval(config, 'b', 'codex', 'auto');
  expect(preferences.setApproval(config, 'a', 'codex', null)).toEqual({ approvalMode: null });
  expect(preferences.getApproval(config, 'a', 'codex')).toBeNull();
  expect(preferences.getApproval(config, 'a', 'omp')).toBe('default');
  expect(preferences.getApproval(config, 'b', 'codex')).toBe('auto');
});
it('scopes reads and writes to the current owner, including a later local workspace claim', () => {
  const { store, preferences } = setup();
  preferences.setApproval(config, 'a', 'codex', 'auto');
  bindWorkspaceOwner(store, 'owner-123');
  expect(preferences.getApproval(config, 'a', 'codex')).toBeNull();
  preferences.setApproval(config, 'a', 'codex', 'default');
  expect(preferences.getApproval(config, 'a', 'codex')).toBe('default');
  expect(store.database.prepare('SELECT owner_user_id,approval_mode FROM chat_approval_preferences ORDER BY owner_user_id').all()).toEqual([
    { owner_user_id: 'local', approval_mode: 'auto' }, { owner_user_id: 'owner-123', approval_mode: 'default' },
  ]);
});
it('rejects missing or unknown Agents instead of creating a global auto-approval preference', () => {
  const { store, preferences } = setup();
  for (const id of ['', ' ', 'missing', "a' OR 1=1 --", undefined, null]) {
    expect(() => preferences.setApproval(config, id as string, 'codex', 'auto')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => preferences.getApproval(config, id as string, 'codex')).toThrow(expect.objectContaining({ status: 404 }));
  }
  expect(store.database.prepare('SELECT * FROM chat_approval_preferences').all()).toEqual([]);
});
it('validates approval enums and enabled runtime identifiers before storing anything', () => {
  const { store, preferences } = setup();
  for (const mode of ['', 'AUTO', 'typo', undefined, {}, 0])
    expect(() => preferences.setApproval(config, 'a', 'codex', mode as any)).toThrow(expect.objectContaining({ status: 400 }));
  for (const cli of ['', 'missing', 'CODEX', null, {}])
    expect(() => preferences.setApproval(config, 'a', cli as any, 'auto')).toThrow(expect.objectContaining({ status: 400 }));
  expect(() => preferences.setApproval(config, 'a', 'claude', 'auto')).toThrow(expect.objectContaining({ status: 409 }));
  expect(() => preferences.getApproval({ ...config, runtimes: [] }, 'a', 'codex')).toThrow(expect.objectContaining({ status: 409 }));
  expect(store.database.prepare('SELECT * FROM chat_approval_preferences').all()).toEqual([]);
  const enabled: Config = { ...config, runtimes: ['claude'] };
  expect(preferences.setApproval(enabled, 'a', 'claude', 'auto')).toEqual({ approvalMode: 'auto' });
});
it('uses bound parameters for valid Agent identifiers containing SQL syntax', () => {
  const { preferences } = setup(), id = "agent'; DROP TABLE conversations;--";
  const custom: Config = { ...config, agents: [{ ...config.agents[0], id }] };
  preferences.setApproval(custom, id, 'codex', 'auto');
  expect(preferences.getApproval(custom, id, 'codex')).toBe('auto');
  expect(preferences.getApproval(config, 'a', 'codex')).toBeNull();
});
it('exposes the Agent default approval selector independently of advanced arguments and environment settings', () => {
  const common = renderChineseMarkup(createElement(AgentApprovalSettings, {
    agentId: 'a', cli: 'codex', value: { codex: { approvalMode: 'auto' } }, available: false, onChange() {},
  }));
  expect(common).toContain('默认审批模式');
  expect(common).toContain('自动批准');
  expect(common).not.toContain('环境变量引用');
  const advanced = renderChineseMarkup(createElement(RuntimeSettingsEditor, { cli: 'codex', hideApproval: true, onChange() {} }));
  expect(advanced).not.toContain('aria-label="审批模式"');
  expect(advanced).toContain('环境变量引用');
});

it('persists strict mode alongside existing preferences after migration',()=>{
 const {preferences}=setup();preferences.setApproval(config,'a','codex','auto');
 expect(preferences.setApproval(config,'a','codex','strict')).toEqual({approvalMode:'strict'});
 expect(preferences.getApproval(config,'a','codex')).toBe('strict');
});
it('migrates legacy preference checks transactionally and retains saved overrides',()=>{
 const {store}=setup();
 store.database.exec(`DROP TABLE chat_approval_preferences; CREATE TABLE chat_approval_preferences (
 owner_user_id TEXT NOT NULL,agent_id TEXT NOT NULL,cli TEXT NOT NULL,approval_mode TEXT NOT NULL CHECK(approval_mode IN ('default','auto')),PRIMARY KEY(owner_user_id,agent_id,cli))`);
 store.database.prepare('INSERT INTO chat_approval_preferences VALUES(?,?,?,?)').run(store.ownerUserId,'a','codex','auto');
 const migrated=createChatPreferences(store);expect(migrated.getApproval(config,'a','codex')).toBe('auto');
 migrated.setApproval(config,'b','codex','strict');expect(migrated.getApproval(config,'b','codex')).toBe('strict');
});
