import { expect, it } from 'vitest';
import { newRemoteKey } from '../shared/remote-crypto';
import { createRemoteStorage } from '../src/remote-storage';

function setup() {
  const records = new Map<string, string>();
  const storage = { get length() { return records.size; }, key: (i: number) => [...records.keys()][i] ?? null,
    getItem: (k: string) => records.get(k) ?? null, setItem: (k: string, v: string) => { records.set(k, v); }, removeItem: (k: string) => { records.delete(k); }, clear: () => records.clear() };
  const key = newRemoteKey(), scope = ['service', 'account', 'computer', 'host-key'];
  return { records, storage, key, scope, local: createRemoteStorage(storage, scope, key) };
}
it('recovers the original target and pending send after reload, without plaintext on disk', () => {
  const { local, records, storage, scope, key } = setup();
  local.saveDraft('chat-1', { text: 'private draft', taskId: 'task-1', pending: { key: 'receipt-1', action: 'queue' } });
  expect(createRemoteStorage(storage, scope, key).readDraft('chat-1')).toEqual({ text: 'private draft', taskId: 'task-1', pending: { key: 'receipt-1', action: 'queue' } });
  expect(JSON.stringify([...records.values()])).not.toContain('private draft');
  expect(local.readDraft('chat-2')).toBeUndefined();
});
it('never reuses a draft after account, computer, service, host or browser identity changes', () => {
  const { local, storage, scope, key } = setup(); local.saveDraft('chat', { text: 'scope secret' });
  for (let i = 0; i < scope.length; i++) expect(createRemoteStorage(storage, scope.map((v, n) => n === i ? 'other' : v), key).readDraft('chat')).toBeUndefined();
  expect(createRemoteStorage(storage, scope, newRemoteKey()).readDraft('chat')).toBeUndefined();
});
it('rejects ciphertext copied into another draft of the same browser identity', () => {
  const { local, records } = setup();
  local.saveDraft('first', { text: 'first draft' });
  local.saveDraft('second', { text: 'second draft' });
  const [first, second] = [...records.keys()];
  records.set(second, records.get(first)!);
  expect(() => local.readDraft('second')).toThrow('scope mismatch');
  expect(local.readDraft('first')?.text).toBe('first draft');
});
it('does not persist read content by default; opt-in cache expires at seven days', () => {
  const { local, storage, scope, key } = setup();
  local.saveCache('work', { goal: 'work' }, 1000); expect(local.readCache('work', 1001)).toBeUndefined();
  local.setCacheEnabled(true); local.saveCache('work', { goal: 'work' }, 1000);
  expect(createRemoteStorage(storage, scope, key).readCache('work', 1001)).toEqual({ value: { goal: 'work' }, savedAt: 1000 });
  expect(local.readCache('work', 1000 + 7 * 86400000)).toBeUndefined();
});
it('removes an inaccessible chat from the read cache without erasing other chats or drafts', () => {
  const { local } = setup();
  local.setCacheEnabled(true);
  local.saveCache('chat:one', { text: 'old content' });
  local.saveCache('chat:two', { text: 'visible content' });
  local.saveDraft('chat:one', { text: 'unsent' });
  local.removeCache('chat:one');
  expect(local.readCache('chat:one')).toBeUndefined();
  expect(local.readCache('chat:two')?.value).toEqual({ text: 'visible content' });
  expect(local.readDraft('chat:one')?.text).toBe('unsent');
});
it('disabling cache removes cached bodies and preserves unsent drafts', () => {
  const { local } = setup(); local.saveDraft('chat', { text: 'keep me' }); local.setCacheEnabled(true); local.saveCache('work', { body: 'forget' });
  local.setCacheEnabled(false); local.setCacheEnabled(true);
  expect(local.readCache('work')).toBeUndefined(); expect(local.readDraft('chat')?.text).toBe('keep me');
});
it('prunes expired unread cache records without discarding durable pending drafts', () => {
  const { local, records } = setup(); local.setCacheEnabled(true);
  local.saveCache('unopened-chat', { body: 'old' }, 1); local.saveDraft('chat', { text: 'keep', pending: { key: 'key', action: 'queue' } });
  local.pruneCache(7 * 86400000 + 1);
  expect([...records.keys()].filter(k => k.includes(':cache:'))).toEqual([]);
  expect(local.readDraft('chat')?.pending?.key).toBe('key');
});
it('clear removes only the current scoped content and reports deletion failures', () => {
  const { local, storage, scope, key } = setup(), other = createRemoteStorage(storage, [...scope, 'other'], key);
  local.saveDraft('chat', { text: 'clear' }); other.saveDraft('chat', { text: 'keep' }); local.clear();
  expect(local.readDraft('chat')).toBeUndefined(); expect(other.readDraft('chat')?.text).toBe('keep');
  local.saveDraft('chat', { text: 'still here' }); storage.removeItem = () => { throw new Error('denied'); };
  expect(() => local.clear()).toThrow('denied'); expect(local.readDraft('chat')?.text).toBe('still here');
});
it('reports quota, blocked reads, corrupt records and oversized drafts instead of claiming saved', () => {
  const { local, storage, records } = setup(); local.saveDraft('chat', { text: 'last saved' });
  expect(() => local.saveDraft('chat', { text: 'x'.repeat(1048577) })).toThrow();
  storage.setItem = () => { throw new Error('quota'); };
  expect(() => local.saveDraft('chat', { text: 'unsaved' })).toThrow('quota'); expect(local.readDraft('chat')?.text).toBe('last saved');
  for (const k of records.keys()) records.set(k, 'corrupt'); expect(() => local.readDraft('chat')).toThrow();
  storage.getItem = () => { throw new Error('blocked'); }; expect(() => local.readDraft('chat')).toThrow('blocked');
});
