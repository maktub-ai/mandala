import {readConfiguredRuntime} from './configured-runtime';
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Config } from "../shared/types";
import { request as httpRequest, type Server } from "node:http";
import { openStore, type Store } from "../server/store";

import { createSessionManager, type SessionManager } from "../server/sessions";
import { createHttpServer } from "../server/http";
let home: string,
  store: Store,
  manager: SessionManager,
  server: Server,
  url: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "mana-http-"));
  store = openStore(home);
  manager = createSessionManager(
    store,
    async () => (await readConfiguredRuntime(home)).config,
  );
  server = createHttpServer({requireIdentity:false, home, store, manager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  manager?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  store?.close();
  rmSync(home, { recursive: true, force: true });
});
const put = (body: unknown, origin = url) =>
  fetch(url + "/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
it.each([['中', 1], ['中', 2], ['🙂', 1], ['🙂', 3]])('preserves %s split after byte %i when saving configuration', async (character, offset) => {
  const { revision } = await readConfiguredRuntime(home), instructions = 'Keep 中文🙂 exactly.';
  const payload = Buffer.from(JSON.stringify({ revision, config: {runtimes:['codex','omp'], version: 2, projects: [], agents: [{ id: 'unicode', name: 'Unicode', instructions, defaultCli: 'codex', models: {}, mcp: [], skills: [] }] } }));
  const split = payload.indexOf(Buffer.from(character)) + Number(offset);
  const firstRead = new Promise<void>(resolve => server.prependOnceListener('request', incoming => {
    const iterator = incoming.iterator.bind(incoming);
    incoming.iterator = options => (async function* () {
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator(options) }) { yield chunk; resolve(); }
    })();
  }));
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<{status: number; body: string}>((resolve, reject) => {
    request = httpRequest(url + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: url } }, result => {
      let text = ''; result.setEncoding('utf8'); result.on('data', chunk => { text += chunk; }); result.on('end', () => resolve({ status: result.statusCode!, body: text }));
    });
    request.on('error', reject); request.write(payload.subarray(0, split));
  });
  await firstRead; request.end(payload.subarray(split));
  const result = await response;
  if (result.status !== 200) throw new Error(result.body);
  expect((await readConfiguredRuntime(home)).config.agents[0].instructions).toBe(instructions);
});
it('bounds requested history pages and keeps the unpaged response compatible',async()=>{
 const c=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const events=Array.from({length:5},(_,i)=>store.appendEvent(c.id,'text',{text:String(i)}));
 const page=await fetch(url+`/api/conversations/${c.id}/history?limit=2`).then(r=>r.json());
 expect(page.map((e:any)=>e.id)).toEqual(events.slice(0,2).map(e=>e.id));
 expect(await fetch(url+`/api/conversations/${c.id}/history?after=${page[1].id}&limit=2`).then(r=>r.json())).toHaveLength(2);
 expect(await fetch(url+`/api/conversations/${c.id}/history`).then(r=>r.json())).toHaveLength(5);
 expect((await fetch(url+`/api/conversations/${c.id}/history?limit=0`)).status).toBe(400);
});
it('replays complete SSE history in bounded batches without duplicating or omitting events',async()=>{
 const c=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const events=Array.from({length:600},(_,i)=>store.appendEvent(c.id,'text',{text:String(i)}));
 const read=store.listEvents.bind(store),sizes:number[]=[];
 const spy=vi.spyOn(store,'listEvents').mockImplementation((...args)=>{const rows=read(...args);sizes.push(rows.length);return rows;});
 const controller=new AbortController();
 try {
  const response=await fetch(url+`/api/conversations/${c.id}/events`,{signal:controller.signal}),reader=response.body!.getReader();let text='';
  while([...text.matchAll(/^id: (\d+)$/gm)].length<events.length){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}
  expect([...text.matchAll(/^id: (\d+)$/gm)].map(m=>Number(m[1]))).toEqual(events.map(e=>e.id));
  expect(Math.max(...sizes)).toBeLessThanOrEqual(256);
 }finally{controller.abort();spy.mockRestore();}
});
it("rejects_foreign_origin_and_invalid_configuration", async () => {
  expect((await put({}, "https://evil.example")).status).toBe(403);
  expect((await put({ config: { version: 7 }, revision: "none" })).status).toBe(
    400,
  );
});
it("browses local directories without exposing file contents or accepting invalid paths", async () => {
  const root = join(home, "browse");
  mkdirSync(join(root, "subfolder"), { recursive: true });
  writeFileSync(join(root, "private.txt"), "not for listing");
  symlinkSync(join(root, "subfolder"), join(root, "linked-folder"));
  const response = await fetch(url + "/api/directories?path=" + encodeURIComponent(root));
  expect(response.status).toBe(200);
  const listing = await response.json();
  expect(listing.path).toBe(root);
  expect(listing.parent).toBe(home);
  expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(["linked-folder", "subfolder"]);
  expect(JSON.stringify(listing)).not.toContain("private.txt");
  expect((await fetch(url + "/api/directories?path=relative")).status).toBe(400);
  expect((await fetch(url + "/api/directories?path=" + encodeURIComponent(join(root, "private.txt")))).status).toBe(400);
  expect((await fetch(url + "/api/directories?path=" + encodeURIComponent(root), {
    headers: { Origin: "https://evil.example" },
  })).status).toBe(403);
});
it("saves_default_directory_and_rejects_stale_revision", async () => {
  // Seed legacy v1 before the first API read provisions the protected identity.
  const initial = await readConfiguredRuntime(home);
  const config = {runtimes:['codex','omp'],
    version: 1,
    projects: [{ id: "p", name: "Project", cwd: "" }],
    agents: [
      {
        id: "a",
        name: "Agent",
        instructions: "",
        defaultCli: "codex",
        models: {},
      },
    ],
  };
  expect((await put({ config, revision: initial.revision })).status).toBe(200);
  expect((await put({ config, revision: initial.revision })).status).toBe(409);
  const saved = await (await fetch(url + "/api/config")).json();
  expect(saved.config.projects[0].cwd).toBe(join(home, "workspaces", "p"));
  const created = await (
    await fetch(url + "/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p", agentId: "a" }),
    })
  ).json();
  expect((await fetch(url + "/api/conversations/" + created.id)).status).toBe(
    200,
  );
  expect(store.listConversations()).toHaveLength(1);
  store.updateConversation(created.id, { status: "running" });
  expect(
    (
      await fetch(url + `/api/conversations/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "second" }),
      })
    ).status,
  ).toBe(409);
});
it("replays_events_after_cursor_without_duplicate_execution", async () => {
  const c = store.createConversation({
    projectId: "p",
    agentId: "a",
    cli: "codex",
    model: null,
  });
  for (let i = 1; i <= 4; i++)
    store.appendEvent(c.id, "text", { text: String(i) });
  const controller = new AbortController();
  const response = await fetch(
    url + `/api/conversations/${c.id}/events?after=2`,
    { signal: controller.signal },
  );
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  controller.abort();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  expect(events.filter(e => e.id !== undefined).map(e => e.id)).toEqual([3, 4]);
  expect(text).toContain('event: history-ready\ndata: {"cursor":4}');
  expect(store.listConversations()).toHaveLength(1);
});
it('does not reauthorize an idle stream but checks fresh authority before delivering new content',async()=>{
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 store.appendEvent(chat.id,'text',{text:'Initial answer'});
 const authorize=vi.spyOn(manager,'authorizeConversationRead'),controller=new AbortController();
 const response=await fetch(url+'/api/conversations/'+chat.id+'/events?recent=5',{signal:controller.signal});
 const reader=response.body!.getReader(),decoder=new TextDecoder();let frames='';
 try{
  while(!frames.includes('event: history-ready')){const {value,done}=await reader.read();if(done)throw Error('Missing history');frames+=decoder.decode(value);}
  const checked=authorize.mock.calls.length;
  await new Promise(resolve=>setTimeout(resolve,450));
  expect(authorize.mock.calls.length).toBe(checked);
  authorize.mockImplementation(()=>{throw Error('revoked');});
  store.appendEvent(chat.id,'text',{text:'New private content'});
  for(;;){const {value,done}=await reader.read();if(done)break;frames+=decoder.decode(value);}
  expect(frames).not.toContain('New private content');
  expect(authorize.mock.calls.length).toBeGreaterThan(checked);
 }finally{controller.abort();authorize.mockRestore();}
});
it('compacts history replay while preserving cursor continuity and unabridged live events',async()=>{
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),path=url+'/api/conversations/'+chat.id;
 const user=store.appendEvent(chat.id,'user',{text:'Request',runId:'r'});
 const deltas=Array.from({length:600},()=>store.appendEvent(chat.id,'tool',{method:'item/reasoning/textDelta',runId:'r',params:{itemId:'thought',delta:'part '}}));
 const snapshot=store.appendEvent(chat.id,'tool',{method:'item/completed',runId:'r',params:{item:{id:'thought',type:'reasoning',content:['Full reasoning']}}});
 const tail=Array.from({length:300},(_,i)=>store.appendEvent(chat.id,'text',{text:'Answer '+i,runId:'r'}));
 const controller=new AbortController(),response=await fetch(path+'/events?recent=5&compact=1',{signal:controller.signal});
 const reader=response.body!.getReader(),decoder=new TextDecoder();let frames='';
 const through=async(marker:string)=>{while(!frames.includes(marker)){const {value,done}=await reader.read();if(done)throw Error('Stream ended');frames+=decoder.decode(value);}const result=frames;frames='';return result;};
 try{
  const replay=await through('event: history-ready');
  expect([...replay.matchAll(/^id: (\d+)$/gm)].map(match=>Number(match[1]))).toEqual([user.id,deltas[0].id,snapshot.id,...tail.map(event=>event.id)]);
  expect(replay).toContain('"cursor":'+tail.at(-1)!.id);
  const page=await(await fetch(path+'/history?recent=5&compact=1')).json();
  expect(page.events.map((e:{id:number})=>e.id)).toEqual([user.id,deltas[0].id,snapshot.id,...tail.map(event=>event.id)]);
  const live=store.appendEvent(chat.id,'tool',{method:'item/reasoning/textDelta',runId:'r',params:{itemId:'live',delta:'Live delta'}});
  store.appendEvent(chat.id,'tool',{method:'item/completed',runId:'r',params:{item:{id:'live',type:'reasoning',content:['Complete live reasoning']}}});
  expect(await through('Complete live reasoning')).toContain('id: '+live.id+'\n');
  expect(store.listEvents(chat.id,0)).toHaveLength(904);
  const resume=new AbortController();
  try{
   const response=await fetch(path+'/events?recent=5&compact=1',{headers:{'Last-Event-ID':String(deltas[0].id)},signal:resume.signal});
   const reader=response.body!.getReader();let resumed='';
   while(!resumed.includes('event: history-ready')){const {value,done}=await reader.read();if(done)throw Error('Missing resumed history');resumed+=decoder.decode(value);}
   expect([...resumed.matchAll(/^id: (\d+)$/gm)].map(match=>Number(match[1]))).toEqual([snapshot.id,...tail.map(event=>event.id),live.id,live.id+1]);
   expect(resumed).not.toContain('event: history-window');
  }finally{resume.abort();}
 }finally{controller.abort();}
});
it('does not repeat snapshot authorization for every socket drain during a large replay',async()=>{
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 store.transaction(()=>{for(let i=0;i<600;i++)store.appendEvent(chat.id,'text',{text:'x'.repeat(4096),itemId:String(i)});});
 const authorize=vi.spyOn(manager,'authorizeConversationRead'),controller=new AbortController();
 const response=await fetch(url+'/api/conversations/'+chat.id+'/events?recent=5',{signal:controller.signal});
 const reader=response.body!.getReader(),decoder=new TextDecoder();let frames='';
 try{
  while(!frames.includes('event: history-ready')){const {value,done}=await reader.read();if(done)throw Error('Missing history');frames+=decoder.decode(value);}
  const ids=[...frames.matchAll(/^id: (\d+)$/gm)].map(match=>Number(match[1]));
  expect(ids).toEqual(store.listEvents(chat.id,0).map(event=>event.id));
  expect(authorize.mock.calls.length).toBeLessThanOrEqual(5);
 }finally{controller.abort();authorize.mockRestore();}
});
it("pages recent conversation turns and resumes live events from the last received ID", async () => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const path = url + "/api/conversations/" + chat.id;
  const turns = Array.from({ length: 25 }, (_, i) => {
    const runId = "run-" + i;
    return [
      store.appendEvent(chat.id, "user", { text: "Question " + i, runId }),
      store.appendEvent(chat.id, "metadata", { execution: "started", runId }),
      store.appendEvent(chat.id, "text", { text: "Answer " + i, runId }),
    ];
  });
  const connect = async (lastId?: number) => {
    const controller = new AbortController();
    const response = await fetch(path + "/events?recent=20", {
      headers: lastId ? { "Last-Event-ID": String(lastId) } : {},
      signal: controller.signal,
    });
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffered = "";
    const readThrough = async (marker: string) => {
      while (!buffered.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE closed before " + marker);
        buffered += decoder.decode(value, { stream: true });
      }
      const end = buffered.indexOf(marker) + marker.length;
      const result = buffered.slice(0, end);
      buffered = buffered.slice(end);
      return result;
    };
    return { readThrough, close: () => controller.abort() };
  };
  const ids = (frames: string) => [...frames.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
  const initial = await connect();
  const last = turns.at(-1)!.at(-1)!.id, before = turns[5][0].id;
  try {
    const replay = await initial.readThrough('event: history-ready\ndata: {"cursor":' + last + '}\n\n');
    expect(ids(replay)).toEqual(turns.slice(5).flat().map(event => event.id));
    expect(replay).toContain('event: history-window\ndata: {"before":' + before + '}');
    const page = await (await fetch(path + "/history?before=" + before + "&recent=20")).json();
    expect(page.events.map((event: { id: number }) => event.id)).toEqual(turns.slice(0, 5).flat().map(event => event.id));
    expect(page.before).toBeNull();
    const live = store.appendEvent(chat.id, "user", { text: "Live question" });
    expect(ids(await initial.readThrough('"text":"Live question"'))).toEqual([live.id]);
  } finally { initial.close(); }
  const reconnectAfter = store.listEvents(chat.id, last).at(-1)!.id;
  const missed = store.appendEvent(chat.id, "text", { text: "While disconnected" });
  const resumed = await connect(reconnectAfter);
  try {
    const replay = await resumed.readThrough('event: history-ready\ndata: {"cursor":' + missed.id + '}\n\n');
    expect(ids(replay)).toEqual([missed.id]);
    expect(replay).not.toContain("history-window");
  } finally { resumed.close(); }
});
it("counts a substantive agent reply once even when its state changes", async () => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const user = store.appendEvent(chat.id, "user", { text: "Old request" });
  const reply = store.appendEvent(chat.id, "metadata", {
    agentMessage: { id: "inquiry", direction: "reply", reply: "Here is the result", replyState: "pending" },
  });
  const update = store.appendEvent(chat.id, "metadata", {
    agentMessage: { id: "inquiry", direction: "reply", reply: "Here is the result", replyState: "consumed" },
  });
  const latest = store.appendEvent(chat.id, "user", { text: "Latest request" });
  const path = url + "/api/conversations/" + chat.id + "/history?recent=2";
  const page = await (await fetch(path)).json();
  expect(page.events.map((event: { id: number }) => event.id)).toEqual([reply.id, update.id, latest.id]);
  expect(page.before).toBe(reply.id);
  const earlier = await (await fetch(path + "&before=" + page.before)).json();
  expect(earlier.events.map((event: { id: number }) => event.id)).toEqual([user.id]);
  expect(earlier.before).toBeNull();
});
it("reconciles the previous recent window when events change and more than a page arrives", async () => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const path = url + "/api/conversations/" + chat.id + "/history?recent=5";
  const turns = Array.from({ length: 8 }, (_, i) => store.appendEvent(chat.id, "user", { text: "Turn " + i }));
  const initial = await (await fetch(path)).json();
  expect(initial.before).toBe(turns[3].id);
  store.database.prepare("UPDATE events SET data=? WHERE id=?").run(JSON.stringify({ text: "Updated text" }), turns[4].id);
  store.database.prepare("UPDATE events SET superseded=1 WHERE id=?").run(turns[5].id);
  const additions = Array.from({ length: 7 }, (_, i) => store.appendEvent(chat.id, "user", { text: "Missed " + i }));
  const refreshed = await (await fetch(path + "&since=" + initial.before)).json();
  expect(refreshed.before).toBe(additions[2].id);
  expect(refreshed.events.map((event: { id: number }) => event.id)).toEqual(
    [...turns.slice(3, 5), ...turns.slice(6), ...additions].map(event => event.id),
  );
  expect(refreshed.events[1].data.text).toBe("Updated text");
});
it("gives an empty recent history a resume cursor", async () => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const controller = new AbortController();
  try {
    const response = await fetch(url + "/api/conversations/" + chat.id + "/events?recent=20", { signal: controller.signal });
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes('data: {"cursor":0}\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE closed before history-ready");
      frames += decoder.decode(value, { stream: true });
    }
    expect(frames).toContain('id: 0\nevent: history-ready\ndata: {"cursor":0}');
  } finally { controller.abort(); }
});
it("renames_a_conversation_and_rejects_invalid_titles_without_changing_execution", async () => {
  const c = store.createConversation({
    projectId: "p",
    agentId: "a",
    cli: "codex",
    model: null,
  });
  store.updateConversation(c.id, {
    nativeId: "native-original",
    status: "running",
  });
  const rename = (title: unknown) =>
    fetch(url + "/api/conversations/" + c.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  expect((await rename("  阅读项目  ")).status).toBe(200);
  expect(store.getConversation(c.id)).toMatchObject({
    title: "阅读项目",
    nativeId: "native-original",
    status: "running",
  });
  for (const title of [" ", 42, "字".repeat(81)])
    expect((await rename(title)).status).toBe(400);
  expect(store.getConversation(c.id)?.title).toBe("阅读项目");
  expect(store.listEvents(c.id, 0)).toEqual([]);
});
it("exposes_cli_status_without_requiring_a_configured_project", async () => {
  manager.getCliStatus = async () => ({
    status: "login-required",
    version: "0.154.0",
  });
  const response = await fetch(url + "/api/cli/status?cli=codex");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "login-required",
    version: "0.154.0",
  });
  expect(store.listConversations()).toEqual([]);
});

it("keeps completion separate from native execution and rejects running completion", async () => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const request = (completed: unknown) => fetch(url + `/api/conversations/${chat.id}/completion`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed }),
  });
  expect((await request(true)).status).toBe(200);
  expect(store.getConversation(chat.id)?.completedAt).toBeTruthy();
  expect(store.getConversation(chat.id)?.status).toBe("idle");
  expect((await request(false)).status).toBe(200);
  expect(store.getConversation(chat.id)?.completedAt).toBeNull();
  expect((await request("true")).status).toBe(400);
  store.updateConversation(chat.id, { status: "running" });
  expect((await request(true)).status).toBe(409);
  expect(store.getConversation(chat.id)?.completedAt).toBeNull();
});
it("stores private knowledge with verified source ownership and explicit adoption", async () => {
  const initial = await (await fetch(url + "/api/config")).json();
  const config = {runtimes:['codex','omp'], ...initial.config, version: 2, projects: [
    { id: "p", name: "Project", cwd: "/tmp", agentIds: ["a"], resources: [], mcp: [], skills: [] },
    { id: "q", name: "Other", cwd: "/tmp", agentIds: ["b"], resources: [], mcp: [], skills: [] },
  ], agents: [...["a", "b"].map(id => ({ id, name: id, instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] })), ...initial.config.agents] };
  expect((await put({ config, revision: initial.revision })).status).toBe(200);
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const event = store.appendEvent(chat.id, "text", { text: "Synthetic conclusion" });
  const send = (path: string, method: string, data: unknown) => fetch(url + "/api/knowledge" + path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const entry = { kind: "memory", title: "Synthetic memory", content: "Conclusion", scope: "agent", agentId: "a", projectId: "p", level: "L1", sourceConversationId: chat.id, sourceEventId: event.id };
  expect((await send("", "POST", { ...entry, projectId: "q", agentId: "b" })).status).toBe(400);
  expect((await send("", "POST", { ...entry, sourceConversationId: "unknown" })).status).toBe(400);
  const created = await send("", "POST", entry);
  expect(created.status).toBe(201);
  const saved = await created.json();
  expect(saved.status).toBe("candidate");
  expect((await send("/" + saved.id, "PATCH", { agentId: "b", projectId: "q" })).status).toBe(400);
  const active = await send("/" + saved.id, "PATCH", { status: "active" });
  expect(active.status).toBe(200);
  expect((await active.json()).sourceConversationId).toBe(chat.id);
  expect((await (await fetch(url + "/api/knowledge")).json())[0].status).toBe("active");
  expect((await fetch(url + "/api/knowledge/" + saved.id, { method: "DELETE" })).status).toBe(200);
  expect(await (await fetch(url + "/api/knowledge")).json()).toEqual([]);
});
it("rejects missing runtime values as client errors and previews references without exposing values", async () => {
  const initial = await (await fetch(url + "/api/config")).json();
  const config: Config = {runtimes:['codex','omp'], ...initial.config, version: 2, projects: [{ id: "p", name: "Preview", cwd: "/tmp", agentIds: ["a"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "a", name: "Preview agent", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [],
      runtime: { codex: { args: ["--enable"], env: {} } } }, ...initial.config.agents] };
  expect((await put({ config, revision: initial.revision })).status).toBe(400);
  config.agents[0].runtime!.codex!.args = ["--enable", "test-feature"];
  config.agents[0].runtime!.codex!.env = { PREVIEW_ONLY: "${OPEN_MANA_SYNTHETIC_REF}" };
  process.env.OPEN_MANA_SYNTHETIC_REF = "synthetic-value-never-returned";
  try {
    expect((await put({ config, revision: initial.revision })).status).toBe(200);
    const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
    const { capabilitySignature } = await import("../server/capabilities");
    manager.getVerification = () => ({ mcp: {}, skills: [], loadedSignature: capabilitySignature(config.projects[0], config.agents[0]) });
    const preview = () => fetch(url + `/api/effective?projectId=p&agentId=a&cli=codex&conversationId=${chat.id}`).then(response => response.json());
    let data = await preview();
    expect(data.runtime).toEqual({ fullAccess: true, args: ["--enable", "test-feature"], env: { PREVIEW_ONLY: "${OPEN_MANA_SYNTHETIC_REF}" }, missing: [], status: "passed" });
    expect(JSON.stringify(data)).not.toContain("synthetic-value-never-returned");
    const loaded = manager.getVerification(chat.id)!.loadedSignature;
    manager.getVerification = () => ({ mcp: {}, skills: [], loadedSignature: loaded });
    const saved = await (await fetch(url + "/api/config")).json();
    saved.config.agents[0].runtime!.codex!.args = ["--disable", "test-feature"];
    expect((await put(saved)).status).toBe(200);
    data = await preview();
    expect(data.runtime.status).toBe("pending");
    delete process.env.OPEN_MANA_SYNTHETIC_REF;
    data = await preview();
    expect(data.runtime.status).toBe("unverified");
    expect(data.runtime.missing).toEqual(["PREVIEW_ONLY"]);
  } finally { delete process.env.OPEN_MANA_SYNTHETIC_REF; }
});

it.each([["completion", "completed"], ["archive", "archived"]])("rechecks execution state after a delayed %s request body", async (action, field) => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  let sawRead!: () => void;
  const reached = new Promise<void>(resolve => { sawRead = resolve; });
  const originalGet = store.getConversation;
  store.getConversation = (id) => { const value = originalGet(id); if (id === chat.id) sawRead(); return value; };
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<number>(resolve => {
    request = httpRequest(url + `/api/conversations/${chat.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" } }, result => {
      result.resume(); result.on("end", () => resolve(result.statusCode!));
    });
    request.write(`{"${field}":`);
  });
  await reached;
  store.updateConversation(chat.id, { status: "running" });
  request.end('true}');
  expect(await response).toBe(409);
  expect(store.getConversation(chat.id)?.completedAt).toBeNull();
  expect(store.getConversation(chat.id)?.archivedAt).toBeNull();
});

it("validates branch input and returns a distinct branch without modifying the source", async () => {
  const source = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const message = store.appendEvent(source.id, "user", { text: "old question" });
  const calls: unknown[] = [];
  manager.branch = async (id, eventId, text) => {
    calls.push({ id, eventId, text });
    return store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null,
      branchedFrom: { conversationId: id, eventId } });
  };
  const branch = (body: unknown, origin = url) => fetch(url + `/api/conversations/${source.id}/branch`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
  });
  expect((await branch({ eventId: "1", text: "new question" })).status).toBe(400);
  expect((await branch({ eventId: message.id, text: "new question" }, "https://evil.example")).status).toBe(403);
  const response = await branch({ eventId: message.id, text: "new question" });
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result.conversation.id).not.toBe(source.id);
  expect(result.conversation.branchedFrom).toEqual({ conversationId: source.id, eventId: message.id });
  expect(calls).toEqual([{ id: source.id, eventId: message.id, text: "new question" }]);
  expect(store.listEvents(source.id, 0)).toEqual([message]);
});

it("archives and restores conversations without completing them or hiding GET history", async () => {
  const chat = store.createConversation({ projectId: "p", agentId: "a", cli: "codex", model: null });
  const message = store.appendEvent(chat.id, "user", { text: "Keep the transcript" });
  const archive = (archived: unknown) => fetch(url + `/api/conversations/${chat.id}/archive`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
  });
  expect((await archive("true")).status).toBe(400);
  let response = await archive(true);
  expect(response.status).toBe(200);
  expect((await response.json()).conversation).toMatchObject({ archivedAt: expect.any(String), completedAt: null });
  expect(await (await fetch(url + "/api/conversations")).json()).toEqual([store.getConversation(chat.id)]);
  expect((await fetch(url + `/api/conversations/${chat.id}`)).status).toBe(200);
  expect(store.listEvents(chat.id, 0)).toEqual([message]);
  response = await archive(false);
  expect(response.status).toBe(200);
  expect((await response.json()).conversation.archivedAt).toBeNull();
  for (const status of ["running", "approval"] as const) {
    store.updateConversation(chat.id, { status });
    expect((await archive(true)).status).toBe(409);
    expect(store.getConversation(chat.id)?.archivedAt).toBeNull();
  }
});


it("serves the system catalog without requiring a Project and validates CLI scope", async () => {
  const calls: unknown[] = [];
  manager.listModels = async (...args) => { calls.push(args); return [{ id: "synthetic-system", label: "Synthetic global model" }]; };
  const response = await fetch(url + "/api/models?scope=system&cli=omp");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([{ id: "synthetic-system", label: "Synthetic global model" }]);
  expect(calls).toEqual([[undefined, "omp", undefined, "system"]]);
  expect((await fetch(url + "/api/models?scope=other&cli=omp")).status).toBe(400);
  expect((await fetch(url + "/api/models?scope=system&cli=unknown")).status).toBe(400);
  expect((await fetch(url + "/api/models?cli=codex")).status).toBe(200);
  expect(calls).toHaveLength(2);
  for (const cli of ["claude","gemini","opencode"]) expect((await fetch(url + "/api/models?scope=system&cli="+cli)).status).toBe(200);
  expect((await fetch(url + "/api/models?scope=runtime&cli=claude")).status).toBe(200);
});

it("creates an unassigned conversation without requiring seeded configuration", async () => {
  const response = await fetch(url + "/api/conversations", { method: "POST", headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ cli: "codex", workspaceId: null }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ projectId: "", agentId: "", workspaceId: null, cli: "codex" });
});
it("validates an independent working directory without binding a Project or Agent", async () => {
  const create = (cwd: string) => fetch(url + "/api/conversations", { method: "POST", headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ cli: "codex", cwd, workspaceId: null }) });
  const good = await create(home);
  expect(good.status).toBe(201);
  expect(await good.json()).toMatchObject({ projectId: "", agentId: "", cwd: home, workspaceId: null });
  expect((await create("relative-path")).status).toBe(400);
  expect((await create(join(home, "missing"))).status).toBe(400);
});
it('acknowledges and cancels a persisted busy-chat input without waiting for CLI startup', async () => {
 const c=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.updateConversation(c.id,{status:'running'});
 const endpoint=url+'/api/conversations/'+c.id+'/queue';
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'next',commandKey:'queued-test',userId:'forged'})});
 expect(response.status).toBe(202);const input=await response.json();expect(input).toMatchObject({state:'queued',text:'next'});
 expect((await (await fetch(endpoint)).json())).toMatchObject([{id:input.id,state:'queued'}]);
 expect((await fetch(endpoint+'/'+input.id,{method:'DELETE'})).status).toBe(200);
 expect(manager.listUserInputs(c.id)[0].state).toBe('cancelled');
 expect((await fetch(url+'/api/task-tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'forged',name:'delegate',args:{}})})).status).toBe(403);
});
it('serves the selected-conversation reference catalog at the composer route',async()=>{
 const conversation=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const item={id:'skill:'+ 'a'.repeat(64),kind:'skill' as const,name:'Personal skill',source:'Agent · Personal',detail:'/synthetic/SKILL.md',status:'available'};
 const catalog=vi.spyOn(manager,'listComposerReferences').mockResolvedValue([item]);
 const response=await fetch(url+`/api/conversations/${conversation.id}/references`);
 expect(response.status).toBe(200);expect(await response.json()).toEqual({items:[item]});expect(catalog).toHaveBeenCalledWith(conversation.id);
});

it('previews effective default references and marks changed workspace defaults pending until the next launch',async()=>{
 const initial=await (await fetch(url+'/api/config')).json();
 const config:Config={runtimes:['codex','omp'],...initial.config,version:2,projects:[],agents:[{id:'preview-a',name:'Preview',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[],runtime:{codex:{args:[]}}},...initial.config.agents],runtimeDefaults:{codex:{args:['--strict-config'],fullAccess:false,approvalMode:'auto',env:{INHERITED:'${RUNTIME_PREVIEW_REFERENCE}'}}}};
 process.env.RUNTIME_PREVIEW_REFERENCE='synthetic-resolved-secret';
 try {
  expect((await put({config,revision:initial.revision})).status).toBe(200);
  const chat=store.createConversation({projectId:'',agentId:'preview-a',cli:'codex',model:null});
  const {capabilitySignature}=await import('../server/capabilities');const {runtimeSignature}=await import('../server/runtime');
  const {conversationContext}=await import('../server/conversation-context');
  const context=conversationContext(config,chat,'/tmp');
  manager.getVerification=()=>({mcp:{},skills:[],loadedSignature:capabilitySignature(context.project,context.agent),loadedRuntimeSignature:runtimeSignature('codex',config.agents[0].runtime,config.runtimeDefaults)+':auto'});
  const preview=()=>fetch(url+`/api/effective?agentId=preview-a&cli=codex&conversationId=${chat.id}`).then(r=>r.json());
  const data=await preview();expect(data.runtime).toMatchObject({args:[],env:{INHERITED:'${RUNTIME_PREVIEW_REFERENCE}'},fullAccess:false,approvalMode:'auto',status:'passed'});
  expect(JSON.stringify(data)).not.toContain('synthetic-resolved-secret');
  const saved=await (await fetch(url+'/api/config')).json();saved.config.runtimeDefaults.codex.fullAccess=true;expect((await put(saved)).status).toBe(200);
  expect((await preview()).runtime).toMatchObject({fullAccess:true,status:'pending'});
 }finally{delete process.env.RUNTIME_PREVIEW_REFERENCE;}
});

it('lets selected history overtake a burst of bulk list reads',async()=>{
 const {IncomingMessage,ServerResponse}=await import('node:http'),{Socket}=await import('node:net');
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 store.appendEvent(chat.id,'user',{text:'hi'});
 const completed:string[]=[];
 const dispatch=(path:string)=>new Promise<void>(resolve=>{
  const req=new IncomingMessage(new Socket());req.method='GET';req.url='/api'+path;req.headers={host:new URL(url).host};
  const res=new ServerResponse(req);res.end=((..._args:unknown[])=>{completed.push(path);resolve();return res;}) as typeof res.end;
  server.emit('request',req,res);
 });
 await Promise.all([...Array.from({length:8},()=>dispatch('/v2/tasks')),dispatch('/conversations/'+chat.id)]);
 expect(completed.indexOf('/conversations/'+chat.id)).toBeLessThan(8);
 expect(completed.filter(path=>path==='/v2/tasks')).toHaveLength(8);
});

it('skips an abandoned queued list and continues serving later reads',async()=>{
 const {IncomingMessage,ServerResponse}=await import('node:http'),{Socket}=await import('node:net');
 const list=vi.spyOn(manager.taskService,'listTasks');
 try{
  const req=new IncomingMessage(new Socket());req.method='GET';req.url='/api/v2/tasks';req.headers={host:new URL(url).host};
  const res=new ServerResponse(req);server.emit('request',req,res);res.destroy();
  const next=await fetch(url+'/api/v2/tasks');expect(next.status).toBe(200);expect(await next.json()).toEqual([]);
  expect(list).toHaveBeenCalledTimes(1);
  expect((await fetch(url+'/api/v2/tasks?invalid=1')).status).toBe(422);
  expect((await fetch(url+'/api/v2/tasks')).status).toBe(200);
 }finally{list.mockRestore();}
});
