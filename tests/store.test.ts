import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/store";
it('pages visible history without skipping events at the next cursor',()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-history-page-')),store=openStore(home);
 try {
  const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
  const events=Array.from({length:6},(_,i)=>store.appendEvent(chat.id,'text',{text:String(i)}));
  store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(events[1].id);
  const first=store.listEvents(chat.id,0,2);
  expect(first.map(e=>e.id)).toEqual([events[0].id,events[2].id]);
  const second=store.listEvents(chat.id,first.at(-1)!.id,2);
  expect(second.map(e=>e.id)).toEqual([events[3].id,events[4].id]);
  expect(store.listEvents(chat.id,second.at(-1)!.id,2).map(e=>e.id)).toEqual([events[5].id]);
  expect(store.listEvents(chat.id,0)).toHaveLength(5);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
it("reopens_conversation_and_events_and_replays_after_cursor", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-store-"));
  let store = openStore(home);
  try {
    const chat = store.createConversation({
      projectId: "reading",
      agentId: "developer",
      cli: "codex",
      model: null,
    });
    const first = store.appendEvent(chat.id, "user", { text: "hello" });
    store.appendEvent(chat.id, "text", { text: "world" });
    store.close();
    store = openStore(home);
    expect(store.getConversation(chat.id)?.status).toBe("idle");
    expect(store.listEvents(chat.id, 0).map((e) => e.kind)).toEqual([
      "user",
      "text",
    ]);
    expect(store.listEvents(chat.id, first.id).map((e) => e.data)).toEqual([
      { text: "world" },
    ]);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("names_the_first_message_and_preserves_a_renamed_title_after_reopening", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-title-"));
  let store = openStore(home);
  try {
    const c = store.createConversation({
      projectId: "p",
      agentId: "a",
      cli: "codex",
      model: null,
    });
    store.appendEvent(c.id, "user", { text: "  阅读清单\n 增加标签  " });
    expect(store.getConversation(c.id)?.title).toBe("阅读清单 增加标签");
    store.updateConversation(c.id, { title: "标签功能" });
    store.appendEvent(c.id, "user", { text: "继续开发" });
    store.close();
    store = openStore(home);
    expect(store.listConversations()[0].title).toBe("标签功能");
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("keeps a long Chinese first request out of the title without shortening its history or a manual rename", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-short-title-"));
  let store = openStore(home);
  const request = "导出读书笔记记录并核对章节目录，整理结果供后续复核和发布";
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    store.appendEvent(chat.id, "user", { text: request });
    const title = store.getConversation(chat.id)!.title!;
    expect(Array.from(title).length).toBeLessThanOrEqual(24);
    expect(title).toMatch(/^导出读书笔记记录.*…$/);
    expect(store.listEvents(chat.id, 0)[0].data).toEqual({ text: request });
    store.renameConversation(chat.id, request);
    store.close();
    store = openStore(home);
    expect(store.getConversation(chat.id)).toMatchObject({ title: request, titleSource: "user" });
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("reads_legacy_titles_without_losing_native_history", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-legacy-"));
  let store = openStore(home);
  try {
    const c = store.createConversation({
      projectId: "p",
      agentId: "a",
      cli: "codex",
      model: null,
    });
    store.appendEvent(c.id, "user", { text: "旧会话首条消息" });
    store.close();
    const db = new DatabaseSync(join(home, "state.sqlite"));
    const legacy = { ...c, nativeId: "original-native-id" };
    delete (legacy as any).title;
    db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
      JSON.stringify(legacy),
      c.id,
    );
    db.close();
    store = openStore(home);
    expect(store.getConversation(c.id)).toMatchObject({
      title: "旧会话首条消息",
      nativeId: "original-native-id",
    });
    expect(store.listConversations()[0].title).toBe("旧会话首条消息");
    expect(store.listEvents(c.id, 0)).toHaveLength(1);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("migrates_legacy_activity_and_title_sources_without_replacing_history", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-metadata-migration-"));
  const createdAt = "2026-09-29T01:00:00.000Z";
  const db = new DatabaseSync(join(home, "state.sqlite"));
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);`);
  for (const [id, title] of [["legacy-user", "My chosen title"], ["legacy-message", "First message"]]) {
    db.prepare("INSERT INTO conversations VALUES (?,?)").run(id, JSON.stringify({
      id, title, projectId: "p", agentId: "a", cli: "codex", model: null,
      nativeId: `native-${id}`, turnId: null, status: "idle", createdAt,
    }));
    db.prepare("INSERT INTO events(conversationId,kind,data,createdAt) VALUES (?,?,?,?)")
      .run(id, "user", JSON.stringify({ text: "First message" }), createdAt);
  }
  db.close();
  let store = openStore(home);
  try {
    expect(store.getConversation("legacy-user")).toMatchObject({
      updatedAt: createdAt, completedAt: null, titleSource: "user",
      nativeId: "native-legacy-user", title: "My chosen title",
    });
    expect(store.getConversation("legacy-message")).toMatchObject({
      updatedAt: createdAt, completedAt: null, titleSource: "message",
    });
    expect(store.listEvents("legacy-user", 0)[0].data).toEqual({ text: "First message" });
    expect(store.setAutomaticTitle("legacy-user", "Overwritten title")).toBe(false);
    store.close();
    store = openStore(home);
    expect(store.getConversation("legacy-user")?.titleSource).toBe("user");
    expect(store.listConversations()).toHaveLength(2);
    expect(store.listEvents("legacy-message", 0)).toHaveLength(1);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("persists_manual_completion_separately_from_execution_and_reopens_on_new_work", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-completion-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T01:00:00.000Z"));
  let store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    store.updateConversation(chat.id, { status: "interrupted", nativeId: "native-1" });
    vi.setSystemTime(new Date("2026-10-01T02:00:00.000Z"));
    store.completeConversation(chat.id, true);
    store.close();
    store = openStore(home);
    expect(store.getConversation(chat.id)).toMatchObject({
      completedAt: "2026-10-01T02:00:00.000Z", status: "interrupted", nativeId: "native-1",
    });
    store.appendEvent(chat.id, "task", { status: "completed", result: "Background receipt" });
    expect(store.getConversation(chat.id)?.completedAt).toBe("2026-10-01T02:00:00.000Z");
    store.completeConversation(chat.id, false);
    expect(store.getConversation(chat.id)).toMatchObject({ completedAt: null, status: "interrupted" });
    store.completeConversation(chat.id, true);
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    store.appendEvent(chat.id, "user", { text: "Continue this work" });
    expect(store.getConversation(chat.id)).toMatchObject({
      completedAt: null, updatedAt: "2026-10-01T03:00:00.000Z", status: "interrupted",
    });
  } finally {
    store.close();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
});
it("sets_one_automatic_title_and_never_overwrites_a_user_title", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-title-source-"));
  let store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    store.appendEvent(chat.id, "user", { text: "  First request\n in detail  " });
    expect(store.getConversation(chat.id)).toMatchObject({ title: "First request in detail", titleSource: "message" });
    expect(store.setAutomaticTitle(chat.id, "Automatic summary")).toBe(true);
    expect(store.setAutomaticTitle(chat.id, "Second automatic summary")).toBe(false);
    store.renameConversation(chat.id, "My own title");
    expect(store.setAutomaticTitle(chat.id, "Late automatic summary")).toBe(false);
    store.close();
    store = openStore(home);
    expect(store.getConversation(chat.id)).toMatchObject({ title: "My own title", titleSource: "user" });
    store.appendEvent(chat.id, "user", { text: "Another request" });
    expect(store.getConversation(chat.id)?.title).toBe("My own title");
    // Existing callers also use updateConversation to rename a chat.
    store.updateConversation(chat.id, { title: "Compatibility rename" });
    expect(store.getConversation(chat.id)).toMatchObject({ title: "Compatibility rename", titleSource: "user" });
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("records_conversation_activity_without_rewriting_metadata_for_streamed_text", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-activity-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T01:00:00.000Z"));
  const store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    expect(chat.updatedAt).toBe(chat.createdAt);
    vi.setSystemTime(new Date("2026-10-01T02:00:00.000Z"));
    store.updateConversation(chat.id, { status: "running" });
    expect(store.getConversation(chat.id)?.updatedAt).toBe("2026-10-01T02:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    store.appendEvent(chat.id, "text", { text: "A streamed chunk" });
    expect(store.getConversation(chat.id)?.updatedAt).toBe("2026-10-01T02:00:00.000Z");
    store.appendEvent(chat.id, "tool", { status: "completed" });
    expect(store.getConversation(chat.id)?.updatedAt).toBe("2026-10-01T03:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-01T04:00:00.000Z"));
    store.updateConversation(chat.id, { status: "idle", turnId: null });
    expect(store.getConversation(chat.id)?.updatedAt).toBe("2026-10-01T04:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-01T05:00:00.000Z"));
    store.appendEvent(chat.id, "metadata", { systemTask: "title", status: "completed" });
    expect(store.getConversation(chat.id)?.updatedAt).toBe("2026-10-01T04:00:00.000Z");
  } finally {
    store.close();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
});

it("persists reversible archive state independently of completion, history, and tasks", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-archive-"));
  let store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    store.updateConversation(chat.id, { nativeId: "native-preserved" });
    store.appendEvent(chat.id, "user", { text: "Keep this history" });
    store.completeConversation(chat.id, true);
    const completedAt = store.getConversation(chat.id)!.completedAt;
    const task = store.createTask({ projectId: "p", sourceConversationId: chat.id, targetConversationId: "target",
      kind: "dispatch", request: "Independent work" });
    const events = store.listEvents(chat.id, 0);
    store.archiveConversation(chat.id, true);
    const archivedAt = store.getConversation(chat.id)!.archivedAt;
    expect(archivedAt).toEqual(expect.any(String));
    store.archiveConversation(chat.id, true);
    expect(store.getConversation(chat.id)!.archivedAt).toBe(archivedAt);
    store.close();
    store = openStore(home);
    expect(store.listConversations()).toHaveLength(1);
    expect(store.getConversation(chat.id)).toMatchObject({ archivedAt, completedAt, nativeId: "native-preserved" });
    expect(store.listEvents(chat.id, 0)).toEqual(events);
    expect(store.getTask(task.id)).toEqual(task);
    store.archiveConversation(chat.id, false);
    expect(store.getConversation(chat.id)).toMatchObject({ archivedAt: null, completedAt, nativeId: "native-preserved" });
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("reads legacy conversations without archive metadata as unarchived", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-legacy-archive-"));
  let store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "omp", model: null });
    store.close();
    const db = new DatabaseSync(join(home, "state.sqlite"));
    const legacy = { ...chat };
    delete legacy.archivedAt;
    db.prepare("UPDATE conversations SET data=? WHERE id=?").run(JSON.stringify(legacy), chat.id);
    db.close();
    store = openStore(home);
    expect(store.getConversation(chat.id)?.archivedAt).toBeNull();
    store.archiveConversation(chat.id, true);
    expect(store.getConversation(chat.id)?.archivedAt).toEqual(expect.any(String));
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("restores an archived completed chat when new execution starts, not when a task is only queued", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-archive-resume-"));
  const store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    store.updateConversation(chat.id, { nativeId: "same-native-history" });
    const original = store.appendEvent(chat.id, "user", { text: "Original task" });
    store.completeConversation(chat.id, true);
    store.archiveConversation(chat.id, true);
    const task = store.createTask({ projectId: "p", sourceConversationId: "another-chat", targetConversationId: chat.id,
      kind: "return", request: "New result to process" });
    store.renameConversation(chat.id, "Updated title");
    expect(store.getConversation(chat.id)).toMatchObject({ archivedAt: expect.any(String), completedAt: expect.any(String) });
    store.updateConversation(chat.id, { status: "running" });
    expect(store.getConversation(chat.id)).toMatchObject({ archivedAt: null, completedAt: null,
      nativeId: "same-native-history", status: "running" });
    expect(store.listEvents(chat.id, 0)).toEqual([original]);
    expect(store.getTask(task.id)).toEqual(task);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("preserves observed event times when copying history into a new conversation", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-copy-time-")), store = openStore(home);
  try {
    const chat = store.createConversation({projectId: "", agentId: "", cli: "codex", model: null});
    const event = store.appendEvent(chat.id, "user", {text:"past request"}, "2024-01-01T00:00:00.000Z");
    expect(event.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(store.getConversation(chat.id)!.updatedAt).not.toBe(event.createdAt);
  } finally {store.close(); rmSync(home, {recursive:true, force:true});}
});

it("conservatively decodes legacy task continuation permission and persists revoked eligibility", () => {
  const home = mkdtempSync(join(tmpdir(), "mana-task-permission-"));
  let store = openStore(home);
  try {
    const task = store.createTask({ projectId: "p", sourceConversationId: "source", targetConversationId: "target", kind: "dispatch", request: "help" });
    expect(store.getTask(task.id)).toMatchObject({ continuationEpoch: 0, autoResume: false });
    const db = new DatabaseSync(join(home, "state.sqlite"));
    db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify({ ...task, continuationEpoch: undefined, autoResume: undefined }), task.id); db.close();
    expect(store.listTasks()[0]).toMatchObject({ continuationEpoch: 0, autoResume: false });
    store.updateTask(task.id, { continuationEpoch: 3, autoResume: false });
    store.close(); store = openStore(home);
    expect(store.getTask(task.id)).toMatchObject({ continuationEpoch: 3, autoResume: false });
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});


it('bounds Agent history in SQL before decoding and preserves snapshots and cursors', () => {
  const home = mkdtempSync(join(tmpdir(), 'mana-agent-history-')), store = openStore(home);
  try {
    const chat = store.createConversation({ projectId: 'p', agentId: 'a', cli: 'codex', model: null });
    const hidden = store.appendEvent(chat.id, 'user', { text: 'superseded' });
    store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(hidden.id);
    const visible = Array.from({ length: 250 }, (_, i) => {
      store.appendEvent(chat.id, 'tool', { method: 'item/started', params: { item: { type: 'commandExecution' } } });
      return store.appendEvent(chat.id, 'user', { text: `history ${i}` });
    });
    const snapshot = store.appendEvent(chat.id, 'tool', { method: 'item/completed', runId: 'run', params: { item: { id: 'answer', type: 'agentMessage', text: 'final', phase: 'final_answer' } } });
    const parse = vi.spyOn(JSON, 'parse');
    const first = store.listAgentHistory(chat.id, 0, false);
    expect(first.map(e => e.id)).toEqual(visible.slice(0, 200).map(e => e.id));
    expect(parse).toHaveBeenCalledTimes(200);
    parse.mockClear();
    const latest = store.listAgentHistory(chat.id, 0, true);
    expect(latest.map(e => e.id)).toEqual([...visible.slice(51).map(e => e.id), snapshot.id]);
    expect(latest.at(-1)).toMatchObject({ kind: 'text', data: { text: 'final', snapshot: true, runId: 'run', phase: 'final_answer' } });
    expect(parse).toHaveBeenCalledTimes(200);
    expect(store.listAgentHistory(chat.id, first.at(-1)!.id, false)).toHaveLength(51);
    parse.mockRestore();
  } finally { vi.restoreAllMocks(); store.close(); rmSync(home, { recursive: true, force: true }); }
});

it('reads only requested context event kinds while retaining order, cursor and history replacement semantics',()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-context-events-')),store=openStore(home);
 try{
  const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
  const first=store.appendEvent(chat.id,'user',{text:'first'});
  const old=store.appendEvent(chat.id,'metadata',{status:'loaded',cli:'codex'});
  store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(old.id);
  store.appendEvent(chat.id,'text',{text:'unrelated output'});
  const latest=store.appendEvent(chat.id,'metadata',{actualUse:'acknowledged'});
  const next=store.appendEvent(chat.id,'user',{text:'second'});
  expect(store.listContextEvents(chat.id,'user',first.id)).toEqual([next]);
  expect(store.listContextEvents(chat.id,'metadata',0)).toEqual([latest]);
  expect(store.listContextEvents(chat.id,'user',next.id)).toEqual([]);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
