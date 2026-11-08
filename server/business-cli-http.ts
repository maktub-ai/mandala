import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Store } from './store';
import type { SessionManager } from './sessions';
import { DomainError } from '../shared/workspace-contracts';

// Only local-user JSON writes use this receipt ledger. Bound Agent commands use
// their existing domain deduplication, after current invocation/ACL validation.
export function createCliReceipts(store: Store) {
  store.database.exec(`CREATE TABLE IF NOT EXISTS cli_command_receipts (
    command_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    status INTEGER, response TEXT, created_at TEXT NOT NULL
  )`);
  return (req: IncomingMessage, res: ServerResponse, path: string, data: unknown): boolean => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim() || key.length > 200)
      throw new DomainError('invalid_command_key',422,'CLI writes require an Idempotency-Key');
    const fingerprint = createHash('sha256').update(JSON.stringify([req.method,path,data])).digest('hex');
    const previous = store.database.prepare('SELECT * FROM cli_command_receipts WHERE command_key=?').get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError('command_conflict',409,'Command key already used with different input');
      if (previous.status === null)
        throw new DomainError('command_unconfirmed',409,'Command is pending or interrupted; query its result before issuing another command');
      res.writeHead(previous.status as number, {'Content-Type':'application/json','Cache-Control':'no-store','X-Mandala-Replayed':'1','X-OpenMana-Replayed':'1'});
      res.end(previous.response as string);
      return true;
    }
    store.database.prepare('INSERT INTO cli_command_receipts VALUES(?,?,NULL,NULL,?)').run(key,fingerprint,new Date().toISOString());
    const end = res.end.bind(res);
    res.end = ((chunk?: any, ...args: any[]) => {
      // Record before sending: a lost client response can replay without running again.
      if (typeof chunk === 'string') {
        store.database.prepare('UPDATE cli_command_receipts SET status=?,response=? WHERE command_key=?')
          .run(res.statusCode,chunk,key);
      }
      return (end as any)(chunk,...args);
    }) as typeof res.end;
    return false;
  };
}

export async function invokeBusinessCli(manager: SessionManager, req: IncomingMessage, data: any,
  boundTool: (command: string) => string | undefined): Promise<unknown> {
  const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw new DomainError('forbidden',403,'Invocation identity required');
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(k=>!['command','args','commandKey'].includes(k)) ||
      typeof data.command !== 'string' || !data.args || typeof data.args !== 'object' || Array.isArray(data.args) ||
      typeof data.commandKey !== 'string' || !data.commandKey.trim() || data.commandKey.length > 200)
    throw new DomainError('invalid_cli_request',422,'Invalid CLI request');
  const name = boundTool(data.command);
  if (!name) throw new DomainError('forbidden',403,'Command unavailable to this invocation');
  return manager.callBoundTool(token,name,data.args,data.commandKey);
}
