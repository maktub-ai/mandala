import { DomainError, LOCAL_USER_ID, type Principal } from '../shared/workspace-contracts';
import type { Store } from './store';

// Services retain this object across the first authenticated claim of legacy data.
export function workspacePrincipal(store: Store): Principal {
  return { get userId() { return store.ownerUserId; } };
}

export function bindWorkspaceOwner(store: Store, userId: string): void {
  if (typeof userId !== 'string' || !userId.trim() || userId !== userId.trim() || userId.length > 200 || userId === LOCAL_USER_ID)
    throw new DomainError('invalid_workspace_owner', 422, 'invalid_workspace_owner');
  store.transaction(() => {
    const db = store.database;
    const existing = db.prepare('SELECT owner_user_id FROM workspace_identity WHERE id=1').get();
    if (existing) {
      if (existing.owner_user_id !== userId) throw new DomainError('workspace_owner_mismatch', 403, 'workspace_owner_mismatch');
      return;
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    // Transfer authority fields only; immutable source snapshots, chat bytes and blob files stay intact.
    for (const table of ['work_tasks', 'task_user_inputs', 'local_composer_drafts']) {
      if (tables.has(table)) db.prepare(`UPDATE ${table} SET owner_user_id=? WHERE owner_user_id=?`).run(userId, LOCAL_USER_ID);
    }
    for (const [table, path] of [['assets', '$.owner.userId'], ['memory_jobs', '$.principal.userId']] as const) {
      if (tables.has(table)) db.prepare(`UPDATE ${table} SET data=json_set(data,?,?) WHERE json_extract(data,?)=?`).run(path, userId, path, LOCAL_USER_ID);
    }
    for (const table of ['command_dedup', 'task_command_dedup', 'task_plan_commands']) {
      if (tables.has(table)) db.prepare(`UPDATE ${table} SET principal=json_set(principal,'$.userId',?) WHERE json_extract(principal,'$.userId')=?`).run(userId, LOCAL_USER_ID);
    }
    if (tables.has('memory_collections')) {
      db.prepare("UPDATE memory_collections SET scope_key=json_set(scope_key,'$[0]',?) WHERE json_valid(scope_key) AND json_extract(CASE WHEN json_valid(scope_key) THEN scope_key ELSE 'null' END,'$[0]')=?").run(userId, LOCAL_USER_ID);
    }
    db.prepare('INSERT INTO workspace_identity VALUES (1,?)').run(userId);
  });
}
