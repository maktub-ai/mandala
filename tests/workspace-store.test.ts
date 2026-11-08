import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { openStore, type Store } from "../server/store";
const homes: string[] = [], stores: Store[] = [];
const setup = () => { const home = mkdtempSync(join(tmpdir(), "workspace-store-")); homes.push(home); const store = openStore(home); stores.push(store); return { home, store }; };
const event = { type: "domain.changed", aggregateId: "one", aggregateRevision: 1, causationId: "command", payload: { ok: true } };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
test("rolls back domain write and outbox on throw and can transact again", () => {
 const { home, store } = setup(); store.database.exec("CREATE TABLE domain_test(id TEXT PRIMARY KEY)");
 const reader = new DatabaseSync(join(home, "state.sqlite"));
 try {
 expect(() => store.transaction(() => { store.database.prepare("INSERT INTO domain_test VALUES (?)").run("one"); store.enqueueOutbox(event); expect(reader.prepare("SELECT count(*) n FROM domain_test").get()!.n).toBe(0); expect(reader.prepare("SELECT count(*) n FROM outbox").get()!.n).toBe(0); throw new Error("abort"); })).toThrow("abort");
 expect(store.database.prepare("SELECT count(*) n FROM domain_test").get()!.n).toBe(0); expect(store.listOutbox(0)).toEqual([]);
 store.transaction(() => { store.database.prepare("INSERT INTO domain_test VALUES (?)").run("two"); store.enqueueOutbox(event); });
 expect(store.listOutbox(0)).toMatchObject([{ ...event, schemaVersion: 1 }]);
 } finally { reader.close(); }
});
test("migrations are idempotent and enforce database settings", () => {
 const { home, store } = setup(); const migrations = store.database.prepare("SELECT * FROM schema_migrations").all(); const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
 const second = openStore(home); stores.push(second);
 expect(second.database.prepare("SELECT * FROM schema_migrations").all()).toEqual(migrations); expect(second.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tables);
 for (const [key, value] of [["journal_mode", "wal"], ["foreign_keys", 1], ["busy_timeout", 5000], ["synchronous", 2]] as const) expect(second.database.prepare(`PRAGMA ${key}`).get()![key === "busy_timeout" ? "timeout" : key]).toBe(value);
});
test("outbox sequences increase, replay is idempotent and cursor is exclusive", () => {
 const { store } = setup(); const first = store.enqueueOutbox(event); expect(store.enqueueOutbox(event)).toBe(first); const second = store.enqueueOutbox({ ...event, aggregateRevision: 2 }); expect(second).toBeGreaterThan(first); expect(store.listOutbox(first).map(e => e.sequence)).toEqual([second]);
});
test("nested and asynchronous transactions are rejected without corrupting connection", () => {
 const { store } = setup(); expect(() => store.transaction(() => store.transaction(() => 1))).toThrow(); expect(() => store.transaction(async () => 1)).toThrow(); expect(store.transaction(() => 2)).toBe(2);
});
test("process exit before commit rolls back domain and outbox", () => {
 const { home, store } = setup(); store.database.exec("CREATE TABLE domain_test(id TEXT PRIMARY KEY)");
 const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN IMMEDIATE; INSERT INTO domain_test VALUES ('one'); INSERT INTO outbox(id,type,aggregate_id,aggregate_revision,causation_id,schema_version,created_at,payload) VALUES ('exit','domain.changed','one',1,'exit',1,'2026-10-02T00:00:00.000Z','{}')"); process.exit(0);`, join(home, "state.sqlite")]);
 expect(result.status).toBe(0); expect(store.database.prepare("SELECT count(*) n FROM domain_test").get()!.n).toBe(0); expect(store.listOutbox(0)).toEqual([]);
});

test("database failures use a safe domain error and roll back", () => {
 const { store } = setup();
 expect(() => store.transaction(() => store.database.exec("INSERT INTO private_missing_table VALUES (1)"))).toThrow(expect.objectContaining({ code: "storage_failure", status: 500, message: "Storage transaction failed" }));
 expect(store.transaction(() => 3)).toBe(3);
});
