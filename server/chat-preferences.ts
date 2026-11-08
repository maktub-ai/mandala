import { isApprovalMode, type ApprovalPreference } from '../shared/chat-preferences';
import { enabledRuntimes, isCli, runtimeIds } from '../shared/runtimes';
import type { ApprovalMode, Cli, Config } from '../shared/types';
import { DomainError } from '../shared/workspace-contracts';
import type { Store } from './store';

// Owner-local service: HTTP callers must pass the existing workspace authorization gate.
export function createChatPreferences(store: Store) {
  const db = store.database;
  // Rebuild once to widen the old SQLite CHECK without losing saved choices.
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_approval_preferences'").get()?.sql;
  const migrate=typeof schema==='string'&&(!schema.includes("'strict'")||runtimeIds.some(cli=>!schema.includes(`'${cli}'`)));
  store.transaction(()=>{
    if(migrate) db.exec('ALTER TABLE chat_approval_preferences RENAME TO chat_approval_preferences_legacy');
    db.exec(`CREATE TABLE IF NOT EXISTS chat_approval_preferences (
      owner_user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      cli TEXT NOT NULL CHECK(cli IN (${runtimeIds.map(cli=>`'${cli}'`).join(',')})),
      approval_mode TEXT NOT NULL CHECK(approval_mode IN ('default','strict','auto')),
      PRIMARY KEY(owner_user_id,agent_id,cli))`);
    if(migrate) db.exec('INSERT INTO chat_approval_preferences SELECT * FROM chat_approval_preferences_legacy; DROP TABLE chat_approval_preferences_legacy');
  });
  const read = db.prepare('SELECT approval_mode FROM chat_approval_preferences WHERE owner_user_id=? AND agent_id=? AND cli=?');
  const write = db.prepare(`INSERT INTO chat_approval_preferences(owner_user_id,agent_id,cli,approval_mode) VALUES(?,?,?,?)
    ON CONFLICT(owner_user_id,agent_id,cli) DO UPDATE SET approval_mode=excluded.approval_mode`);
  const remove = db.prepare('DELETE FROM chat_approval_preferences WHERE owner_user_id=? AND agent_id=? AND cli=?');
  function validate(config: Config, agentId: string, cli: Cli) {
    if (typeof agentId !== 'string' || !agentId.trim() || !config.agents.some(agent => agent.id === agentId))
      throw new DomainError('agent_not_found', 404, 'Agent not found');
    if (!isCli(cli)) throw new DomainError('invalid_cli', 400, 'Invalid CLI');
    if (!enabledRuntimes(config).includes(cli)) throw new DomainError('runtime_disabled', 409, 'Runtime is disabled');
  }
  return {
    getApproval(config: Config, agentId: string, cli: Cli): ApprovalMode | null {
      validate(config, agentId, cli);
      const row = read.get(store.ownerUserId, agentId, cli);
      return row ? row.approval_mode as ApprovalMode : null;
    },
    setApproval(config: Config, agentId: string, cli: Cli, mode: ApprovalMode | null): ApprovalPreference {
      validate(config, agentId, cli);
      if (config.agents.find(agent=>agent.id===agentId)?.systemRole === 'mandala')
        throw new DomainError('managed_agent', 403, 'Mandala approval rules are system managed');
      if (mode !== null && !isApprovalMode(mode)) throw new DomainError('invalid_approval_mode', 400, 'Invalid approval mode');
      if (mode === null) remove.run(store.ownerUserId, agentId, cli);
      else write.run(store.ownerUserId, agentId, cli, mode);
      return { approvalMode: mode };
    },
  };
}
