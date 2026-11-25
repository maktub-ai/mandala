import { openRemote, sealRemote, type RemoteKey } from '../shared/remote-crypto';

export type RemoteDraft = { text: string; taskId?: string; projectId?: string; agentId?: string; pending?: { key: string; action: 'queue' | 'continue' | 'task' | 'chat' } };
const WEEK = 7 * 86400000;

/** Access-device storage only. The caller must authenticate before reading this scope. */
export function createRemoteStorage(storage: Storage, scope: string[], identity: RemoteKey) {
  const prefix = 'mandala-remote-v2:' + JSON.stringify([...scope, identity.publicKey]) + ':';
  const key = (kind: string, id = '') => prefix + kind + ':' + id;
  const read = <T,>(name: string): T | undefined => {
    const wire = storage.getItem(name);
    if (wire === null) return;
    const record = openRemote(wire, identity.publicKey, identity.secretKey, 3 * 1024 * 1024);
    if (record?.name !== name) throw new Error('Remote record scope mismatch');
    return record.value as T;
  };
  const write = (name: string, value: unknown) => {
    const wire = sealRemote({ name, value }, identity.publicKey, identity.secretKey);
    if (wire.length > 3 * 1024 * 1024) throw new Error('Local record too large');
    storage.setItem(name, wire);
  };
  const names = (kind?: string) => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((name): name is string => !!name && name.startsWith(kind ? key(kind) : prefix));
  const remove = (kind?: string) => { for (const name of names(kind)) storage.removeItem(name); };
  return {
    readDraft(id: string) { return read<RemoteDraft>(key('draft', id)); },
    saveDraft(id: string, draft: RemoteDraft) {
      if (draft.text.length > 1048576) throw new Error('Draft exceeds 1 Mi characters');
      if (!draft.text && !draft.pending) storage.removeItem(key('draft', id));
      else write(key('draft', id), draft);
    },
    cacheEnabled() { return read<boolean>(key('cache-enabled')) === true; },
    setCacheEnabled(enabled: boolean) { if (!enabled) remove('cache'); write(key('cache-enabled'), enabled); },
    saveCache(id: string, value: unknown, now = Date.now()) {
      if (this.cacheEnabled()) write(key('cache', id), { value, savedAt: now });
    },
    removeCache(id: string) { storage.removeItem(key('cache', id)); },
    readCache<T>(id: string, now = Date.now()): { value: T; savedAt: number } | undefined {
      if (!this.cacheEnabled()) return;
      const cached = read<{ value: T; savedAt: number }>(key('cache', id));
      if (cached && (!Number.isFinite(cached.savedAt) || cached.savedAt > now || now - cached.savedAt >= WEEK)) { storage.removeItem(key('cache', id)); return; }
      return cached;
    },
    pruneCache(now = Date.now()) {
      for (const name of names('cache')) {
        let savedAt: number | undefined;
        try { savedAt = read<{ savedAt: number }>(name)?.savedAt; } catch { /* Corrupt read cache is expendable; drafts are separate. */ }
        if (!Number.isFinite(savedAt) || savedAt! > now || now - savedAt! >= WEEK) storage.removeItem(name);
      }
    },
    clear() { remove(); },
  };
}
