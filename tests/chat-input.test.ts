import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveAttachment, loadAttachments } from "../server/attachments";
import { connectCodex } from "../server/codex";
import { validateConfig } from "../server/config";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
it("stores uploads as conversation-owned files and rejects traversal or foreign references", async () => {
  const home = await mkdtemp(join(tmpdir(), "mana-upload-")); homes.push(home);
  const item = await saveAttachment(home, "chat-a", "notes.txt", Buffer.from("synthetic notes"));
  const [loaded] = await loadAttachments(home, "chat-a", [item.id]);
  expect(await readFile(loaded.path, "utf8")).toBe("synthetic notes");
  expect(loaded.name).toBe("notes.txt");
  await expect(loadAttachments(home, "chat-b", [item.id])).rejects.toThrow();
  await expect(loadAttachments(home, "chat-a", ["../../private"])).rejects.toThrow("invalid attachment");
  await expect(saveAttachment(home, "chat-a", "../escape", Buffer.from("x"))).rejects.toThrow("invalid attachment");
  await expect(saveAttachment(home, "chat-a", "big.txt", Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toThrow("20 MB");
});
it("forwards model, reasoning effort and native images with each Codex turn", async () => {
  let sent: any;
  const client = await connectCodex({
    async request(method, params) { if (method === "turn/start") { sent = params; return { turn: { id: "t" } }; } return {}; },
    notify() {}, reply() {}, close() {},
  });
  await client.startTurn("thread", "inspect", undefined, undefined, { model: "sample-model", effort: "high", images: [{ path: "/tmp/sample.png", mimeType: "image/png" }] });
  expect(sent).toMatchObject({ model: "sample-model", effort: "high", input: [{ type: "text", text: "inspect" }, { type: "localImage", path: "/tmp/sample.png" }] });
});
it("validates persisted chat defaults", () => {
  const base = {runtimes:['codex','omp'], version: 2, agents: [], projects: [] };
  expect(() => validateConfig({ ...base, chatDefaults: { codex: { model: "sample", effort: "high" } } })).not.toThrow();
  expect(() => validateConfig({ ...base, chatDefaults: { codex: { effort: "invalid" } } })).toThrow();
  expect(() => validateConfig({ ...base, chatDefaults: { unknown: { model: "x" } } })).toThrow();
});

it("keeps uploaded content separate from metadata, including a file named metadata.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "mana-upload-")); homes.push(home);
  const saved = await saveAttachment(home, "c", "metadata.json", Buffer.from('{"synthetic":true}'));
  const [loaded] = await loadAttachments(home, "c", [saved.id]);
  expect(await readFile(loaded.path, "utf8")).toBe('{"synthetic":true}');
});

it("saves default selection, switches a live conversation on the next turn and preserves native identity", async () => {
  const { openStore } = await import("../server/store");
  const { createSessionManager } = await import("../server/sessions");
  const home = await mkdtemp(join(tmpdir(), "mana-input-session-")); homes.push(home);
  const store = openStore(home);
  const calls: any[] = [];
  let callbacks: any;
  const manager = createSessionManager(store, async () => ({runtimes:['codex','omp'], version: 2, projects: [], agents: [], chatDefaults: { codex: { model: "first", effort: "medium" } } }), async options => {
    callbacks = options;
    return { getStatus: async () => ({ status: "ready", version: "synthetic" }), listModels: async () => [],
      startThread: async () => "native-input", resumeThread: async () => {}, close() {}, replyApproval() {}, interrupt: async () => {},
      startTurn: async (nativeId, text, _mode, _roots, turnOptions) => { calls.push({ nativeId, text, turnOptions }); return `turn-${calls.length}`; } };
  }, undefined, home);
  try {
    const chat = await manager.create("", "");
    expect(chat).toMatchObject({ model: "first", effort: "medium" });
    expect(await manager.create("", "", "other-model")).toMatchObject({ model: "other-model", effort: null });
    const file = await saveAttachment(home, chat.id, "notes.txt", Buffer.from("Synthetic input"));
    const attachments = await loadAttachments(home, chat.id, [file.id]);
    await manager.send(chat.id, "", attachments);
    expect(calls[0]).toMatchObject({ nativeId: "native-input", turnOptions: { model: "first", effort: "medium" } });
    expect(calls[0].text).toContain(attachments[0].path);
    await expect(manager.setModel(chat.id, "second", "low")).rejects.toThrow("conversation busy");
    callbacks.onEvent({ method: "turn/completed", params: { threadId: "native-input", turn: { id: "turn-1", status: "completed" } } });
    await manager.setModel(chat.id, "second", "low");
    await manager.send(chat.id, "next");
    expect(calls[1]).toMatchObject({ nativeId: "native-input", turnOptions: { model: "second", effort: "low" } });
    expect(store.listEvents(chat.id, 0).find(e => e.kind === "user")?.data).toMatchObject({ text: "", attachments: [{ name: "notes.txt" }] });
    manager.close(); store.close();
    const reopened = openStore(home);
    try { expect(reopened.getConversation(chat.id)).toMatchObject({ model: "second", effort: "low", nativeId: "native-input" }); }
    finally { reopened.close(); }
  } finally { manager.close(); }
});

it("routes raw uploads and model changes through the guarded HTTP handler", async () => {
  const { Readable } = await import("node:stream");
  const { openStore } = await import("../server/store");
  const { createSessionManager } = await import("../server/sessions");
  const { createHttpServer } = await import("../server/http");
  const home = await mkdtemp(join(tmpdir(), "mana-input-http-")); homes.push(home);
  const store = openStore(home);
  const turns: any[] = [];
  const manager = createSessionManager(store, async () => ({runtimes:['codex','omp'], version: 2, projects: [], agents: [] }), async options => ({
    getStatus: async () => ({ status: "ready", version: "synthetic" }), listModels: async () => [],
    startThread: async () => "native-http-input", resumeThread: async () => {}, close() {}, replyApproval() {}, interrupt: async () => {},
    startTurn: async (_id, text, _mode, _roots, turnOptions) => {
      turns.push({ text, turnOptions });
      setTimeout(() => options.onEvent({ method: "turn/completed", params: { threadId: "native-http-input", turn: { id: "turn-input", status: "completed" } } }), 10);
      return "turn-input";
    },
  }), undefined, home);
  const server = createHttpServer({requireIdentity:false, home, store, manager });
  const chat = await manager.create("", "");
  const call = (path: string, body: string | Buffer, raw = false, origin = "http://127.0.0.1") => new Promise<{ status: number; data: any }>(resolve => {
    let status = 0;
    const req = Object.assign(Readable.from([Buffer.from(body)]), { url: path, method: "POST", headers: { host: "127.0.0.1", origin, "content-type": raw ? "application/octet-stream" : "application/json" } });
    server.emit("request", req, { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, data: JSON.parse(text) }); } });
  });
  try {
    const root = `/api/conversations/${chat.id}`;
    expect((await call(root + "/attachments?name=x.txt", "x", true, "https://foreign.example")).status).toBe(403);
    expect((await call(root + "/attachments?name=../x.txt", "x", true)).status).toBe(400);
    const upload = await call(root + "/attachments?name=notes.txt", "synthetic data", true);
    expect(upload.status).toBe(201);
    expect((await loadAttachments(home, chat.id, [upload.data.id]))[0].size).toBe(14);
    const selection = await call(root + "/model", JSON.stringify({ model: "second", effort: "high" }));
    expect(selection).toMatchObject({ status: 200, data: { conversation: { model: "second", effort: "high" } } });
    expect((await call(root + "/model", JSON.stringify({ model: "second", effort: "invalid" }))).status).toBe(400);
    expect((await call(root + "/messages", JSON.stringify({ text: "read", attachments: ["../../outside"] }))).status).toBe(400);
    const other = await manager.create("", "");
    expect((await call(`/api/conversations/${other.id}/messages`, JSON.stringify({ text: "read", attachments: [upload.data.id] }))).status).toBe(400);
    expect((await call(root + "/messages", JSON.stringify({ text: "", attachments: [upload.data.id] }))).status).toBe(200);
    expect(turns[0]).toMatchObject({ turnOptions: { model: "second", effort: "high" } });
    expect(turns[0].text).toContain("notes.txt");
    await expect.poll(() => store.getConversation(chat.id)?.status).toBe("idle");
    const image = await call(root + "/attachments?name=sample.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGD8AAAAASUVORK5CYII=", "base64"), true);
    expect(image.data.mimeType).toBe("image/png");
    expect((await call(root + "/messages", JSON.stringify({ text: "inspect", attachments: [image.data.id] }))).status).toBe(200);
    expect(turns[1].turnOptions.images[0]).toMatchObject({ mimeType: "image/png", path: expect.stringContaining("sample.png") });
  } finally { manager.close(); store.close(); server.close(); }
});

it("round-trips the model defaults in the platform configuration", async () => {
  const { readConfig, writeConfig } = await import("../server/config");
  const home = await mkdtemp(join(tmpdir(), "mana-input-config-")); homes.push(home);
  const initial = await readConfig(home);
  await writeConfig(home, { ...initial.config, chatDefaults: { codex: { model: "selected-model", effort: "high" } } }, initial.revision);
  expect((await readConfig(home)).config.chatDefaults).toEqual({ codex: { model: "selected-model", effort: "high" } });
});

it('persists attachments with queued messages, including attachments-only input and idempotency checks', async () => {
 const {openStore}=await import('../server/store');
 const {createTasks}=await import('../server/tasks');
 const {createTaskScheduler}=await import('../server/task-scheduler');
 const {LOCAL_USER_ID}=await import('../shared/workspace-contracts');
 const home=await mkdtemp(join(tmpdir(),'mana-queued-upload-'));homes.push(home);
 let store=openStore(home);
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const attachment=await saveAttachment(home,chat.id,'notes.txt',Buffer.from('Queued fixture'));
 const scheduler=createTaskScheduler(store,createTasks(store),{principal:{userId:LOCAL_USER_ID}});
 const input=scheduler.enqueueUserInput(chat.id,'','queued-attachment',[attachment.id]);
 expect(input.attachments).toEqual([attachment.id]);
 expect(()=>scheduler.enqueueUserInput(chat.id,'','queued-attachment',[])).toThrow();
 store.close();store=openStore(home);
 try {
  const reopened=createTaskScheduler(store,createTasks(store),{principal:{userId:LOCAL_USER_ID}});
  expect(reopened.takeNext(chat.id)).toMatchObject({kind:'input',input:{text:'',attachments:[attachment.id]}});
 } finally {store.close();}
});

it('returns a clean 404 for a missing static file instead of exposing an internal path', async () => {
 const {Readable}=await import('node:stream');
 const {openStore}=await import('../server/store');
 const {createSessionManager}=await import('../server/sessions');
 const {createHttpServer}=await import('../server/http');
 const home=await mkdtemp(join(tmpdir(),'mana-missing-file-'));homes.push(home);
 const store=openStore(home),manager=createSessionManager(store,async()=>({runtimes:['codex','omp'],version:2,projects:[],agents:[]}),undefined,undefined,home);
 const server=createHttpServer({requireIdentity:false,home,store,manager});
 try {
  const response=await new Promise<{status:number;text:string}>(resolve=>{
   let status=0;server.emit('request',Object.assign(Readable.from([]),{method:'GET',url:'/Users/example/missing.md',headers:{host:'127.0.0.1'}}),{writeHead(code:number){status=code;},end(text:string){resolve({status,text});}});
  });
  expect(response).toEqual({status:404,text:JSON.stringify({error:'File not found'})});
 } finally {await manager.close();store.close();server.close();}
});
