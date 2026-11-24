import { randomUUID } from 'node:crypto';
import type { CodexWriterRecovery, CodexWriterRecoveryAction } from '../shared/codex-writer-recovery';
import type { Conversation } from '../shared/types';
import { DomainError } from '../shared/workspace-contracts';
import type { CodexClient } from './codex';
import { mandalaContextBoundary } from './mandala';
import type { Store } from './store';

export function createCodexWriterRecovery(options: {
  store: Store;
  blocked(id: string): boolean;
  lock(id: string): void;
  unlock(id: string): void;
  closed(): boolean;
  open(chat: Conversation): Promise<{ client: CodexClient; cwd: string }>;
  isolatePreviousContext(id: string): void;
}) {
  const { store } = options;
  const pending = new Map<string, Promise<CodexWriterRecovery>>();
  const recorded = store.database.prepare(`SELECT json_extract(data,'$.codexWriterRecovery') AS record
    FROM events WHERE conversationId=? AND kind='metadata' AND superseded=0
    AND (json_extract(data,'$.codexWriterRecovery.previousNativeId')=?
      OR json_extract(data,'$.nativeExecutionBoundary.nativeId')=?)
    ORDER BY id DESC LIMIT 1`);
  const recentError = store.database.prepare(`SELECT id,data FROM events WHERE conversationId=? AND id>?
    AND kind='error' AND superseded=0 ORDER BY id DESC LIMIT 1`);
  const write = (id: string, recovery: CodexWriterRecovery) =>
    store.appendEvent(id, 'metadata', { codexWriterRecovery: recovery });
  const read = (c: Conversation) => {
    const row = recorded.get(c.id, c.nativeId, c.nativeId);
    return typeof row?.record === 'string' ? JSON.parse(row.record) as CodexWriterRecovery : undefined;
  };
  const conflict = (c: Conversation) => {
    if (c.status !== 'error') return;
    const event = recentError.get(c.id, mandalaContextBoundary(store, c.id));
    if (!event) return;
    const data = JSON.parse(event.data as string);
    if (data.code === 'native_thread_busy' && data.nativeTurnSubmitted === false &&
        (data.nativeId === undefined || data.nativeId === c.nativeId)) return Number(event.id);
  };
  const supported = (c: Conversation | null | undefined): c is Conversation & { nativeId: string } =>
    !!c?.nativeId && c.cli === 'codex' && c.purpose === 'mandala-main' && !c.executionLocation && !c.archivedAt;
  const status = (id: string): CodexWriterRecovery | null => {
    const c = store.getConversation(id);
    if (!supported(c)) return null;
    const prior = read(c);
    if (prior?.state === 'linked' && !conflict(c)) return prior;
    if (prior?.state === 'creating') return pending.has(id) ? prior : { ...prior, state: 'unknown' };
    if (prior?.state === 'unknown') return prior;
    const conflictId = conflict(c);
    if (conflictId && prior?.state === 'released' && prior.operationId && prior.conflictId !== conflictId)
      return { ...prior, conflictId, state: 'unknown' };
    return conflictId ? (prior?.conflictId === conflictId ? prior : {
      conflictId, previousNativeId: c.nativeId, state: 'held',
    }) : null;
  };
  const changed = () => new DomainError('writer_recovery_changed', 409, 'Codex recovery state changed. Refresh before continuing.');
  const name = (attempt: CodexWriterRecovery) => 'Mandala continuation ' + attempt.operationId;

  async function recover(c: Conversation & { nativeId: string }, current: CodexWriterRecovery, action: CodexWriterRecoveryAction) {
    const id = c.id;
    const validate = () => {
      const latest = store.getConversation(id);
      if (options.closed() || !supported(latest) || latest.nativeId !== c.nativeId ||
        latest.agentId !== c.agentId || latest.cwd !== c.cwd || latest.model !== c.model ||
        conflict(latest) === undefined || options.blocked(id)) throw changed();
      return latest;
    };
    const useClient = async <T>(fn: (client: CodexClient, cwd: string) => Promise<T>) => {
      const { client, cwd } = await options.open(validate());
      try { validate(); return await fn(client, cwd); }
      finally { await client.close(); }
    };
    const originalHeld = () => useClient(async client => {
      try { await client.resumeThread(c.nativeId); return false; }
      catch (error) {
        if ((error as Partial<DomainError>).code === 'native_thread_busy' && (error as Partial<DomainError>).status === 409) return true;
        throw new DomainError('writer_recovery_unverified', 409, 'Codex did not confirm whether the original writer is available.');
      }
    });
    const held = await originalHeld();
    validate();
    if (!held) {
      const released = { ...current, state: 'released' as const };
      if (current.state !== 'released') write(id, released);
      return released;
    }
    if (action === 'retry-original') {
      if (current.operationId) return current;
      const result = { ...current, state: 'held' as const };
      if (current.state !== 'held') write(id, result);
      return result;
    }

    let attempt = current.operationId ? current : undefined;
    try {
      if (action === 'isolate' && !attempt) {
        await useClient(async (client, cwd) => {
          if (!client.nameEmptyThread || !client.readEmptyNamedThread)
            throw new DomainError('writer_recovery_unsupported', 422, 'This runtime cannot verify an empty persistent Codex thread.');
          attempt = store.transaction(() => {
            const latest = validate();
            const previous = read(latest);
            if (previous?.operationId && previous.previousNativeId === c.nativeId) throw changed();
            const next = { ...current, state: 'creating' as const, operationId: randomUUID() };
            write(id, next);
            return next;
          });
          const nativeId = await client.startThread({ cwd, instructions: '', model: c.model ?? undefined, safeSystem: true, ephemeral: false });
          if (!nativeId || nativeId === c.nativeId) throw changed();
          attempt = { ...attempt!, nativeId };
          write(id, attempt);
          await client.nameEmptyThread(nativeId, name(attempt));
        });
      }
      // Only a separate client can verify that the empty thread survives native shutdown.
      if (!attempt?.nativeId) return current;
      const candidate = attempt;
      let linked: CodexWriterRecovery | undefined;
      await useClient(async client => {
        if (!client.readEmptyNamedThread || !await client.readEmptyNamedThread(candidate.nativeId!, name(candidate))) throw changed();
        // The cold read proves durability. Hold the candidate writer through the
        // transaction so an external client cannot race the final emptiness check.
        await client.resumeThread(candidate.nativeId!);
        if (!await client.readEmptyNamedThread(candidate.nativeId!, name(candidate))) throw changed();
        if (!await originalHeld()) {
          const released = { ...candidate, state: 'released' as const };
          validate();
          write(id, released);
          linked = released;
          return;
        }
        linked = store.transaction(() => {
          const latest = validate();
          if (read(latest)?.operationId !== candidate.operationId) throw changed();
          const result = { ...candidate, state: 'linked' as const };
          options.isolatePreviousContext(id);
          store.updateConversation(id, { nativeId: candidate.nativeId!, turnId: null, continuityPending: false });
          store.appendEvent(id, 'metadata', {
            codexWriterRecovery: result,
            // Older readers honor the receipt cutoff. Isolation revokes inherited receipt context.
            nativeContextReset: { reason: 'receipt_access_revoked', historyPreserved: true, trigger: 'codex_writer_isolation' },
            nativeExecutionBoundary: { version: 1, previousNativeId: c.nativeId, nativeId: candidate.nativeId },
          });
          return result;
        });
      }).catch(error => { if (!linked) throw error; });
      return linked!;
    } catch (error) {
      if (!attempt) throw error;
      const result = { ...attempt, state: 'unknown' as const };
      write(id, result);
      return result;
    }
  }
  return {
    status,
    busy: (id: string) => pending.has(id),
    request(id: string, conflictId: number, action: CodexWriterRecoveryAction) {
      const current = status(id), c = store.getConversation(id);
      if (!current || !supported(c) || current.conflictId !== conflictId) throw changed();
      if (current.state === 'linked' || current.state === 'creating' || current.state === 'unknown' && action === 'isolate' ||
          action === 'check' && current.state !== 'unknown') return Promise.resolve(current);
      if (pending.has(id) || options.blocked(id) || options.closed()) throw changed();
      options.lock(id);
      const work = Promise.resolve().then(() => recover(c, current, action)).finally(() => { pending.delete(id); options.unlock(id); });
      pending.set(id, work);
      return work;
    },
    close: () => Promise.allSettled(pending.values()),
  };
}
