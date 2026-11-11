import { enqueueWikiCompletion } from './wiki-completion';
import { enqueueSkillCompletion } from "./skill-completion";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readdirSync, writeFileSync, rmSync, realpathSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation, DisplayEvent, EventKind, Task } from "../shared/types";
import { DomainError, LOCAL_USER_ID, type EventEnvelope } from "../shared/workspace-contracts";
import { createOutbox, type OutboxInput } from "./outbox";
import { titleFromText } from "./conversation-title";
export interface Store {
  readonly home: string;
  readonly database: DatabaseSync;
  readonly ownerUserId: string;
  transaction<T>(fn: () => T): T;
  enqueueOutbox(input: OutboxInput): number;
  listOutbox(afterSequence: number): EventEnvelope[];
  createConversation(
    input: Pick<Conversation, "purpose" | "projectId" | "agentId" | "cli" | "model" | "effort" | "branchedFrom" | "workspaceId" | "cwd" | "workspaceName" | "approvalMode" | "executionLocation">,
  ): Conversation;
  getConversation(id: string): Conversation | undefined;
  listConversations(): Conversation[];
  listConversationTaskRuns(id: string): string[];
  inheritConversationTaskRuns(id: string, runIds: readonly string[]): void;
  updateConversation(
    id: string,
    patch: Partial<
      Pick<Conversation, "cli" | "continuityPending" | "nativeId" | "turnId" | "status" | "title" | "model" | "effort" | "approvalMode" | "completedAt">
    >,
  ): void;
  completeConversation(id: string, completed: boolean): void;
  archiveConversation(id: string, archived: boolean): void;
  renameConversation(id: string, title: string, source?: Conversation["titleSource"]): void;
  setAutomaticTitle(id: string, title: string): boolean;
  appendEvent(id: string, kind: EventKind, data: unknown, observedAt?: string): DisplayEvent;
  listEvents(id: string, afterId: number, limit?: number, compact?: boolean): DisplayEvent[];
  historyWindowStart(id: string, before: number, turns: number): number | null;
  listEarlierEvents(id: string, from: number, before: number, compact?: boolean): DisplayEvent[];
  listAgentHistory(id: string, afterId: number, latest: boolean): DisplayEvent[];
  replaceHistory(id: string, fromEventId: number, nativeId: string | null): number;
  createTask(input: Pick<Task, "projectId" | "sourceConversationId" | "targetConversationId" | "kind" | "request"> & Pick<Task, "continuationEpoch" | "autoResume">): Task;
  getTask(id: string): Task | undefined;
  listTasks(): Task[];
  updateTask(id: string, patch: Partial<Pick<Task, "status" | "result" | "startEventId" | "continuationEpoch" | "autoResume">>): void;
  close(): void;
}
// A regular execution already belongs to its user turn. Independently started
// executions also need boundaries, including Chats used only for Task runs.
const agentReplyAnchor = `(kind='metadata' AND json_extract(data,'$.agentMessage.direction')='reply'
  AND length(trim(json_extract(data,'$.agentMessage.reply')))>0)`;
const historyAnchor = `(kind='user' OR (kind='metadata' AND json_extract(data,'$.execution')='started') OR ${agentReplyAnchor})`;
// The final native snapshot replaces these deltas in the renderer. Keep incomplete,
// legacy and later deltas, and never compact against a snapshot outside this page.
const compactHistory = `NOT EXISTS (SELECT 1 FROM events AS complete
  WHERE e.kind='tool' AND json_extract(e.data,'$.method') IN ('item/reasoning/textDelta','item/reasoning/summaryTextDelta')
    AND json_type(e.data,'$.runId')='text' AND json_type(e.data,'$.params.itemId')='text'
    AND EXISTS (SELECT 1 FROM events AS first
      WHERE first.conversationId=e.conversationId AND first.superseded=0 AND first.id<e.id
        AND first.kind='tool' AND json_extract(first.data,'$.method') IN ('item/reasoning/textDelta','item/reasoning/summaryTextDelta')
        AND json_extract(first.data,'$.runId')=json_extract(e.data,'$.runId')
        AND json_extract(first.data,'$.params.itemId')=json_extract(e.data,'$.params.itemId'))
    AND complete.conversationId=e.conversationId AND complete.superseded=0 AND complete.id>e.id AND complete.id<?
    AND complete.kind='tool' AND json_extract(complete.data,'$.method')='item/completed'
    AND json_extract(complete.data,'$.params.item.type')='reasoning'
    AND json_extract(complete.data,'$.runId')=json_extract(e.data,'$.runId')
    AND json_extract(complete.data,'$.params.item.id')=json_extract(e.data,'$.params.itemId')
    AND CASE WHEN json_array_length(complete.data,'$.params.item.summary')>0
      THEN length(json_extract(complete.data,'$.params.item.summary[0]'))>0
      ELSE length(json_extract(complete.data,'$.params.item.content[0]'))>0 END)`;
const decodeEvent = (row: Record<string, unknown>) => ({ ...row, data: JSON.parse(row.data as string) }) as DisplayEvent;
const decodeTask = (data: string): Task => {
  const task = JSON.parse(data) as Task;
  return { ...task, continuationEpoch: task.continuationEpoch ?? 0, autoResume: task.autoResume ?? false };
};
const maintenanceTokens=new Map<string,symbol>();
export function acquireWorkspaceMaintenance(home:string):{token:symbol;release:()=>void} {
  mkdirSync(home,{recursive:true});
  const root=realpathSync(resolve(home)), lock=join(root,'.workspace-maintenance');
  try {mkdirSync(lock);}catch{throw new Error('workspace_in_use');}
  const leases=join(root,'.store-leases');
  if(existsSync(leases))for(const name of readdirSync(leases)){
    const match=/^([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name);
    if(!match||!Number.isSafeInteger(Number(match[1])))continue;
    const path=join(leases,name);
    try{
      if(!lstatSync(path).isFile()||readFileSync(path,'utf8')!=='open')continue;
      try{process.kill(Number(match[1]),0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')rmSync(path);}
    }catch{/* An ambiguous lease remains a blocker. */}
  }
  if(existsSync(leases)&&readdirSync(leases).length){rmSync(lock,{recursive:true});throw new Error('workspace_in_use');}
  const token=Symbol('maintenance');maintenanceTokens.set(root,token);
  return {token,release:()=>{maintenanceTokens.delete(root);rmSync(lock,{recursive:true,force:true});}};
}
export function openStore(home: string, maintenanceToken?:symbol): Store {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const root=realpathSync(resolve(home)), lock=join(root,'.workspace-maintenance');
  const allowed=()=>!existsSync(lock)||(maintenanceToken!==undefined&&maintenanceTokens.get(root)===maintenanceToken);
  if(!allowed())throw new Error('workspace_in_use');
  const leases=join(root,'.store-leases');mkdirSync(leases,{recursive:true});
  const lease=join(leases,`${process.pid}-${randomUUID()}`);writeFileSync(lease,'open',{flag:'wx'});
  if(!allowed()){rmSync(lease);throw new Error('workspace_in_use');}
  let db:DatabaseSync;
  try {db=new DatabaseSync(join(home,"state.sqlite"));}catch(error){rmSync(lease,{force:true});throw error;}
  try {
  let inTransaction = false;
  const transaction = <T>(fn: () => T): T => {
    if (inTransaction || db.isTransaction) throw new DomainError("nested_transaction", 409, "Nested transactions are not supported");
    if (fn.constructor.name === "AsyncFunction") throw new DomainError("async_transaction", 422, "Transaction callback must be synchronous");
    try { db.exec("BEGIN IMMEDIATE"); } catch { throw new DomainError("storage_failure", 500, "Unable to start storage transaction"); }
    inTransaction = true;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new DomainError("async_transaction", 422, "Transaction callback must be synchronous");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR")
        throw new DomainError("storage_failure", 500, "Storage transaction failed");
      throw error;
    } finally { inTransaction = false; }
  };
  db.exec(`PRAGMA journal_mode=WAL;
 PRAGMA foreign_keys=ON;
 PRAGMA busy_timeout=5000;
 PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT, completed_at TEXT, title_source TEXT);
 CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workspace_identity (id INTEGER PRIMARY KEY CHECK(id=1), owner_user_id TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_chat ON events(conversationId, id);
 CREATE INDEX IF NOT EXISTS events_run_progress ON events(json_extract(data,'$.runId'), id DESC)
 WHERE kind IN ('text','tool','approval','error');`);
  const eventColumns = db.prepare("PRAGMA table_info(events)").all();
  if (!eventColumns.some(row => row.name === "superseded"))
    db.exec("ALTER TABLE events ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE INDEX IF NOT EXISTS events_chat_history_anchors ON events(conversationId,id)
    WHERE superseded=0 AND ${historyAnchor};
    CREATE INDEX IF NOT EXISTS events_chat_user_runs ON events(conversationId,json_extract(data,'$.runId'))
    WHERE superseded=0 AND kind='user';
    CREATE INDEX IF NOT EXISTS events_chat_agent_replies ON events(conversationId,json_extract(data,'$.agentMessage.id'),id)
    WHERE superseded=0 AND ${agentReplyAnchor};`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_reasoning_snapshots ON events(conversationId,json_extract(data,'$.runId'),json_extract(data,'$.params.item.id'),id)
    WHERE superseded=0 AND kind='tool' AND json_extract(data,'$.method')='item/completed'
      AND json_extract(data,'$.params.item.type')='reasoning'
      AND CASE WHEN json_array_length(data,'$.params.item.summary')>0
        THEN length(json_extract(data,'$.params.item.summary[0]'))>0
        ELSE length(json_extract(data,'$.params.item.content[0]'))>0 END`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_reasoning_deltas ON events(conversationId,json_extract(data,'$.runId'),json_extract(data,'$.params.itemId'),id)
    WHERE superseded=0 AND kind='tool' AND json_extract(data,'$.method') IN ('item/reasoning/textDelta','item/reasoning/summaryTextDelta')`);
  // Digest invalidation follows the affected transcript, including writes from other connections.
  db.exec(`CREATE TABLE IF NOT EXISTS event_revisions (conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS event_revision_insert AFTER INSERT ON events BEGIN
      INSERT INTO event_revisions VALUES (NEW.conversationId,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS event_revision_delete AFTER DELETE ON events BEGIN
      INSERT INTO event_revisions VALUES (OLD.conversationId,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS event_revision_update AFTER UPDATE ON events BEGIN
      INSERT INTO event_revisions VALUES (OLD.conversationId,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
      INSERT INTO event_revisions SELECT NEW.conversationId,1 WHERE NEW.conversationId!=OLD.conversationId
        ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1;
    END;`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_memory_history ON events(conversationId,id)
    WHERE kind='metadata' AND superseded=0 AND
      (json_type(data,'$.memoryUse') IS NOT NULL OR json_type(data,'$.memoryHistory') IS NOT NULL OR json_type(data,'$.memoryRecall') IS NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_receipt_history ON events(conversationId,id)
    WHERE superseded=0 AND (kind='user' AND json_extract(data,'$.source.kind')='coordination'
      OR kind='metadata' AND json_extract(data,'$.receiptContext')=1)`);
  const columns = new Set(db.prepare("PRAGMA table_info(conversations)").all().map((row) => row.name));
  for (const name of ["updated_at", "completed_at", "title_source"])
    if (!columns.has(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} TEXT`);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  transaction(() => {
    const key = "workspace_foundation_001_outbox";
    if (db.prepare("SELECT key FROM schema_migrations WHERE key=?").get(key)) return;
    db.exec(`CREATE TABLE outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_revision INTEGER NOT NULL,
      causation_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1),
      created_at TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(type,aggregate_id,aggregate_revision,causation_id)
    )`);
    db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(key, new Date().toISOString());
  });
  db.exec('CREATE INDEX IF NOT EXISTS outbox_aggregate_created ON outbox(aggregate_id,created_at)');
  const decode = (row: Record<string, unknown>): Conversation => {
    const chat = JSON.parse(row.data as string) as Conversation;
    const firstTitle = () => {
      const first = db
        .prepare(
          "SELECT data FROM events WHERE conversationId=? AND kind='user' AND superseded=0 ORDER BY id LIMIT 1",
        )
        .get(chat.id);
      return first
        ? titleFromText(JSON.parse(first.data as string).text)
        : null;
    };
    if (chat.title === undefined) chat.title = firstTitle();
    return {
      ...chat,
      updatedAt: (row.updated_at ?? chat.updatedAt ?? chat.createdAt) as string,
      completedAt: row.completed_at as string | null,
      archivedAt: chat.archivedAt ?? null,
      titleSource: (row.title_source ?? chat.titleSource ??
        (chat.title && chat.title !== firstTitle() ? "user" : "message")) as Conversation["titleSource"],
    };
  };
  for (const row of db.prepare("SELECT * FROM conversations WHERE updated_at IS NULL OR title_source IS NULL").all()) {
    const chat = decode(row), legacy = JSON.parse(row.data as string) as Conversation;
    db.prepare("UPDATE conversations SET updated_at=?,completed_at=?,title_source=? WHERE id=?").run(
      chat.updatedAt!, legacy.completedAt ?? null, chat.titleSource!, chat.id,
    );
  }
  const get = (id: string): Conversation | undefined => {
    const row = db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    return row ? decode(row) : undefined;
  };
  const write = (chat: Conversation) => db.prepare(
    "UPDATE conversations SET data=?,updated_at=?,completed_at=?,title_source=? WHERE id=?",
  ).run(JSON.stringify(chat), chat.updatedAt!, chat.completedAt ?? null, chat.titleSource!, chat.id);
  const ownerIdentity = db.prepare("SELECT owner_user_id FROM workspace_identity WHERE id=1");
  return {
    database: db,
    home: root,
    get ownerUserId() { return ownerIdentity.get()?.owner_user_id as string ?? LOCAL_USER_ID; },
    transaction,
    ...createOutbox(db),
    createConversation(input) {
      const createdAt = new Date().toISOString();
      const chat: Conversation = {
        ...input,
        id: randomUUID(),
        title: null,
        nativeId: null,
        turnId: null,
        status: "idle",
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        archivedAt: null,
        titleSource: "message",
      };
      db.prepare("INSERT INTO conversations(id,data,updated_at,completed_at,title_source) VALUES (?,?,?,?,?)").run(
        chat.id,
        JSON.stringify(chat),
        chat.updatedAt!,
        chat.completedAt ?? null,
        chat.titleSource!,
      );
      return chat;
    },
    getConversation: get,
    listConversations() {
      return db
        .prepare("SELECT * FROM conversations ORDER BY rowid DESC")
        .all()
        .map(decode);
    },
    listConversationTaskRuns(id) {
      return db.prepare("SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? UNION SELECT run_id AS id FROM conversation_task_provenance WHERE conversation_id=?").all(id,id).map(row=>row.id as string);
    },
    inheritConversationTaskRuns(id, runIds) {
      for(const runId of runIds)db.prepare("INSERT OR IGNORE INTO conversation_task_provenance(conversation_id,run_id) VALUES (?,?)").run(id,runId);
    },
    updateConversation(id, patch) {
      const chat = get(id);
      if (!chat) throw new Error("conversation not found");
      write({ ...chat, ...patch,
        executionLocation: chat.executionLocation,
        ...(patch.status === "running" ? { archivedAt: null, completedAt: null } : {}),
        titleSource: patch.title === undefined ? chat.titleSource : "user",
        updatedAt: patch.status === undefined && patch.title === undefined ? chat.updatedAt : new Date().toISOString(),
      });
    },
    completeConversation(id, completed) {
      const chat = get(id);
      if (!chat) throw new Error("conversation not found");
      if (Boolean(chat.completedAt) === completed) return;
      const now = new Date().toISOString();
      write({ ...chat, completedAt: completed ? now : null, updatedAt: now });
    },
    archiveConversation(id, archived) {
      const chat = get(id);
      if (!chat) throw new Error("conversation not found");
      if (chat.purpose === "mandala-main" && archived) throw new Error("Mandala primary conversation cannot be archived");
      if (Boolean(chat.archivedAt) === archived) return;
      const now = new Date().toISOString();
      write({ ...chat, archivedAt: archived ? now : null, updatedAt: now });
    },
    renameConversation(id, title, source = "user") {
      const chat = get(id);
      if (!chat) throw new Error("conversation not found");
      write({ ...chat, title, titleSource: source, updatedAt: new Date().toISOString() });
    },
    setAutomaticTitle(id, title) {
      const chat = get(id);
      if (!chat) throw new Error("conversation not found");
      if (chat.titleSource === "user" || chat.titleSource === "automatic") return false;
      write({ ...chat, title, titleSource: "automatic" });
      return true;
    },
    appendEvent(conversationId, kind, data, observedAt) {
      const append=()=>{
      const createdAt = observedAt ?? new Date().toISOString();
      const result = db
        .prepare(
          "INSERT INTO events(conversationId,kind,data,createdAt) VALUES (?,?,?,?)",
        )
        .run(conversationId, kind, JSON.stringify(data), createdAt);
      if (kind !== "text" && kind !== "metadata") {
        const chat = get(conversationId);
        if (chat) {
          const text = (data as { text?: string }).text;
          write({ ...chat, updatedAt: observedAt ? new Date().toISOString() : createdAt,
            ...(kind === "user" ? {
              completedAt: null,
              ...(!chat.title && typeof text === "string" && text.trim() ?
                { title: titleFromText(text), titleSource: "message" as const } : {}),
            } : {}),
          });
        }
      }
      if(kind==='status'&&(data as {status?:string}).status==='idle'){enqueueSkillCompletion(db,home,conversationId,Number(result.lastInsertRowid));enqueueWikiCompletion(db,conversationId,Number(result.lastInsertRowid));}
      return {
        id: Number(result.lastInsertRowid),
        conversationId,
        kind,
        data,
        createdAt,
      };
      };
      return kind==='status'&&(data as {status?:string}).status==='idle'&&!db.isTransaction?transaction(append):append();
    },
    listEvents(conversationId, afterId, limit, compact = false) {
      return db
        .prepare(
          `SELECT id,conversationId,kind,data,createdAt FROM events AS e WHERE conversationId=? AND id>? AND superseded=0 ${compact ? 'AND '+compactHistory : ''} ORDER BY id LIMIT ?`,
        )
        .all(conversationId, afterId, ...(compact ? [Number.MAX_SAFE_INTEGER] : []), limit ?? -1)
        .map(decodeEvent);
    },
    historyWindowStart(id, before, turns) {
      const anchors = db.prepare(`SELECT id, kind, json_extract(data,'$.runId') AS runId FROM events AS e
        WHERE conversationId=? AND id<? AND superseded=0 AND ${historyAnchor}
          AND (kind='user' OR (json_extract(data,'$.execution')='started' AND NOT EXISTS (SELECT 1 FROM events AS u
            WHERE u.conversationId=e.conversationId AND u.superseded=0 AND u.kind='user'
              AND json_extract(u.data,'$.runId')=json_extract(e.data,'$.runId')))
            OR (${agentReplyAnchor} AND NOT EXISTS (SELECT 1 FROM events AS r
              WHERE r.conversationId=e.conversationId AND r.id<e.id AND r.superseded=0 AND ${agentReplyAnchor}
                AND json_extract(r.data,'$.agentMessage.id')=json_extract(e.data,'$.agentMessage.id'))))
        ORDER BY id DESC LIMIT ?`).all(id, before, turns + 1);
      if (anchors.length <= turns) return null;
      const oldest = anchors[turns - 1], previous = anchors[turns];
      if (oldest.kind === 'user' && typeof oldest.runId === 'string') {
        // Some stored runs emitted startup events before accepting their user message.
        const earlier = db.prepare(`SELECT id FROM events WHERE conversationId=? AND superseded=0
          AND id>? AND id<? AND json_extract(data,'$.runId')=? ORDER BY id LIMIT 1`)
          .get(id, previous.id!, oldest.id!, oldest.runId);
        if (earlier) return Number(earlier.id);
      }
      return Number(oldest.id);
    },
    listEarlierEvents(id, from, before, compact = false) {
      return db.prepare(`SELECT id,conversationId,kind,data,createdAt FROM events AS e
        WHERE conversationId=? AND id>=? AND id<? AND superseded=0 ${compact ? 'AND '+compactHistory : ''} ORDER BY id`)
        .all(id, from, before, ...(compact ? [before] : [])).map(decodeEvent);
    },
    listAgentHistory(id, afterId, latest) {
      const rows = db.prepare(`SELECT id,conversationId,kind,data,createdAt FROM events
        WHERE conversationId=? AND id>? AND superseded=0 AND
          (kind IN ('user','text','status') OR (kind='tool' AND json_extract(data,'$.method')='item/completed'
            AND json_extract(data,'$.params.item.type')='agentMessage' AND json_type(data,'$.params.item.text')='text'))
        ORDER BY id ${latest ? "DESC" : "ASC"} LIMIT 200`).all(id, afterId);
      if (latest) rows.reverse();
      return rows.map(row => ({ ...row, data: JSON.parse(row.data as string) }) as DisplayEvent).flatMap(event => {
        if (["user", "text", "status"].includes(event.kind)) return [event];
        const data = event.data as { method?: string; runId?: string; params?: { item?: { id: string; type: string; text?: string; phase?: string } } }, item = data.params?.item;
        return event.kind === "tool" && data.method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string"
          ? [{ ...event, kind: "text" as const, data: { text: item.text, itemId: item.id, phase: item.phase, runId: data.runId, snapshot: true } }] : [];
      });
    },
    replaceHistory(id, fromEventId, nativeId) {
      const chat = get(id);
      if (!chat) throw new Error("conversation not found");
      const message = db.prepare("SELECT kind,data FROM events WHERE conversationId=? AND id=? AND superseded=0").get(id, fromEventId);
      if (message?.kind !== "user") throw new Error("invalid branch message");
      const runId = JSON.parse(message.data as string).runId;
      if (runId) fromEventId = Number(db.prepare("SELECT MIN(id) AS id FROM events WHERE conversationId=? AND superseded=0 AND json_extract(data,'$.runId')=?").get(id, runId)!.id);
      return transaction(() => {
        // Keep replaced events for local recovery; they no longer enter the active context.
        db.prepare("UPDATE events SET superseded=1 WHERE conversationId=? AND id>=?").run(id, fromEventId);
        const first = db.prepare("SELECT data FROM events WHERE conversationId=? AND kind='user' AND superseded=0 ORDER BY id LIMIT 1").get(id);
        write({ ...chat, nativeId, ...(nativeId === null ? {continuityPending:true} : {}), turnId: null, status: "idle", completedAt: null,
          ...(chat.titleSource === "message" || !first && chat.titleSource === "automatic"
            ? { title: first ? titleFromText(JSON.parse(first.data as string).text) : null, titleSource: "message" as const } : {}),
        });
        return fromEventId;
      });
    },
    createTask(input) {
      const task: Task = { continuationEpoch: 0, autoResume: false, ...input, id: randomUUID(), status: "queued", result: null,
        startEventId: 0, createdAt: new Date().toISOString() };
      db.prepare("INSERT INTO tasks VALUES (?,?)").run(task.id, JSON.stringify(task));
      return task;
    },
    getTask(id) {
      const row = db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
      return row ? decodeTask(row.data as string) : undefined;
    },
    listTasks() {
      return db.prepare("SELECT data FROM tasks ORDER BY rowid DESC").all()
        .map((row) => decodeTask(row.data as string));
    },
    updateTask(id, patch) {
      const row = db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
      if (!row) throw new Error("task not found");
      db.prepare("UPDATE tasks SET data=? WHERE id=?").run(
        JSON.stringify({ ...JSON.parse(row.data as string), ...patch }), id);
    },
    close() {
      db.close();
      rmSync(lease,{force:true});
    },
  };
  }catch(error){db.close();rmSync(lease,{force:true});throw error;}
}
