import {openProjectBackground} from "./helpers/navigation";
import {waitForAutosave} from "./helpers/settings";
import { openConfigSection } from "./helpers/navigation";
import { openArea, conversationMenu } from "./helpers/navigation";
import { chooseOption, expectSelection } from "./helpers/select";
import { test, expect } from "@playwright/test";
import type { Conversation } from "../../shared/types";

test.beforeEach(async ({ request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 1,
    projects: [{ id: "controls", name: "Synthetic controls", cwd: "" }],
    agents: [{ id: "worker", name: "Synthetic worker", instructions: "Personal fixture only.", defaultCli: "codex", models: {} }],
  } } });
});

test("browser back preserves settings edits when returning to configure", async ({ page }) => {
 await page.goto('/?project=controls&agent=worker');
 await expect(page.getByRole('combobox',{name:'当前项目',exact:true})).toContainText('Synthetic controls');
 await openArea(page,'设置');await openConfigSection(page,'projects');
 const settingsUrl=page.url();await page.goBack();await expect(page).toHaveURL(/\/projects\/controls\/overview$/);
 await page.goForward();await expect(page).toHaveURL(settingsUrl);await expect(page.getByLabel('项目名称')).toHaveValue('Synthetic controls');
 await openArea(page,'项目');const directoryUrl=page.url();
 await page.getByRole('button',{name:'添加项目',exact:true}).click();await page.getByLabel('项目名称').fill('Unsaved synthetic addition');await page.getByRole('button',{name:'创建项目',exact:true}).click();
 await page.goBack();await expect(page).toHaveURL(directoryUrl);await expect(page.locator('.workspace-directory-row').filter({hasText:'Unsaved synthetic addition'})).toBeVisible();
 await openArea(page,'设置');await expect(page).toHaveURL(/\/settings\/general$/);
 await openArea(page,'项目');const row=page.locator('.workspace-directory-row').filter({hasText:'Unsaved synthetic addition'});await expect(row).toBeVisible();await row.click();await page.getByRole('button',{name:'项目设置',exact:true}).click();await waitForAutosave(page);await openProjectBackground(page);await expect(page.getByLabel('项目名称')).toHaveValue('Unsaved synthetic addition');
});

test("refresh retains an Agent selected during new chat preparation", async ({ page, request }) => {
  const { config, revision } = await (await request.get("/api/config")).json();
  config.agents.push({ id: "second-worker", name: "Synthetic second worker", instructions: "Fixture only.", defaultCli: "codex", models: {}, mcp: [], skills: [] });
  config.projects[0].agentIds.push("second-worker");
  await request.put("/api/config", { data: { config, revision } });
  await page.goto("/?project=controls&agent=worker&workspace=");
  await chooseOption(page, page.getByRole("combobox", { name: "当前 智能体", exact: true }), "second-worker");
  await page.reload();
  await expectSelection(page.getByRole("combobox", { name: "当前 智能体", exact: true }), "second-worker");
});

test("the workbench updates when a background conversation stops", async ({ page, request }) => {
  const chat = await (await request.post("/api/conversations", { data: { projectId: "controls", agentId: "worker", cli: "codex", workspaceId:null } })).json();
  await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: "hold" } });
  await page.goto("/projects/controls/workbench");
  const conversation = page.locator(".project-chat-row").filter({ hasText: "hold" });
  await expect(conversation).toContainText("执行中");
  await request.post(`/api/conversations/${chat.id}/stop`, { data: {} });
  await expect(conversation).toContainText("已中断");
});

test("locks an approval while submitting and restores it after a failed request", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/conversations/*/approvals/*", async (route) => {
    requests++;
    await held;
    await route.fulfill({ status: 500, json: { error: "Synthetic approval failure" } });
  });
  await page.goto("/?project=controls&agent=worker&workspace=");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("approval");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const approve = page.getByRole("button", { name: "允许本次", exact: true });
  const reject = page.getByRole("button", { name: "拒绝", exact: true });
  await expect(approve).toBeVisible();
  try {
    await approve.click();
    await expect(approve).toBeDisabled();
    await expect(reject).toBeDisabled();
    expect(requests).toBe(1);
  } finally { release(); }
  await expect(page.getByRole("alert")).toContainText("Synthetic approval failure");
  await expect(approve).toBeEnabled();
  await expect(reject).toBeEnabled();
});

test("keeps tool traces next to their own chat round after reload", async ({ page }) => {
  await page.goto("/?project=controls&agent=worker&workspace=");
  for (let round = 0; round < 2; round++) {
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("tool-flow");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
    await page.getByRole("button", { name: "展开本轮过程", exact: true }).last().click();
    await expect(page.locator(".trace")).toHaveCount(round + 1);
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "展开本轮过程", exact: true })).toHaveCount(2);
  for (const process of await page.locator(".turn-process").all()) await process.getByRole("button", { name: "展开本轮过程", exact: true }).click();
  await expect(page.locator(".trace")).toHaveCount(2);
  for (const trace of await page.locator(".trace").all()) {
    await expect(trace.locator(".operation-card")).toHaveCount(3);
  }
});

test("a delayed conversation creation cannot replace settings or its unsaved edits", async ({ page, request }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const creating = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    started();
    await held;
    await route.continue();
  });
  await page.goto("/?project=controls&agent=worker&workspace=");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("Delayed synthetic request");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await creating;
  try {
    await openArea(page, "设置");
    await openConfigSection(page, "projects");
    await openProjectBackground(page);
    await page.getByLabel("项目名称").fill("Unsaved synthetic project");
  } finally { release(); }
  await expect.poll(async () => (await (await request.get("/api/conversations")).json())
    .some((chat: { title: string }) => chat.title === "Delayed synthetic request")).toBe(true);
  await expect(page).toHaveURL(url=>['/projects','/projects/manage'].includes(url.pathname)&&url.searchParams.get('project')==='controls'&&url.searchParams.get('tab')==='background');
  await expect(page.getByLabel("项目名称")).toHaveValue("Unsaved synthetic project");
});

test("a delayed archive response cannot hide a newer running turn or replace current runtime state", async ({ page, request }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let processed!: () => void;
  const completedOnServer = new Promise<void>((resolve) => { processed = resolve; });
  await page.route("**/api/conversations/*/archive", async (route) => {
    const response = await route.fetch();
    processed();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/?project=controls&agent=worker&workspace=");
  await page.getByLabel("消息", { exact: true }).fill("Completion response sample");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const id = new URL(page.url()).searchParams.get("conversation")!;
  try {
    await (await conversationMenu(page, "Completion response sample")).getByRole("menuitem", { name: "归档对话 · Completion response sample", exact: true }).click();
    await completedOnServer;
    expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation.archivedAt).toEqual(expect.any(String));
    await page.getByLabel("消息", { exact: true }).fill("hold");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByTestId("chat-status")).toHaveText("执行中");
    await expect(page.getByText("Fixture reply: hold", { exact: true })).toBeVisible();
    const delivered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/archive"));
    release();
    await (await delivered).finished();
    await page.getByLabel("消息", { exact: true }).fill("Unsent draft while running");
    await expect(page.getByTestId("chat-status")).toHaveText("执行中");
    await expect(page.getByRole("button", { name: "停止执行", exact: true })).toBeEnabled();
    await expect((await conversationMenu(page, "Completion response sample")).getByRole("menuitem", { name: "归档对话 · Completion response sample", exact: true })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "重新处理 · Completion response sample", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation.archivedAt).toBeNull();
    await page.getByRole("button", { name: "停止执行", exact: true }).click();
    await expect(page.getByTestId("chat-status")).toHaveText("已中断");
  } finally {
    release();
    await request.post(`/api/conversations/${id}/stop`);
  }
});

test("a delayed archive response preserves a newer automatic title and its source", async ({ page, request }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let processed!: () => void;
  const completedOnServer = new Promise<void>((resolve) => { processed = resolve; });
  let snapshot!: Conversation;
  await page.route("**/api/conversations/*/archive", async (route) => {
    const response = await route.fetch();
    snapshot = ((await response.json()) as { conversation: Conversation }).conversation;
    processed();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/?project=controls&agent=worker&workspace=");
  await page.getByLabel("消息", { exact: true }).fill("Completion title sample");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await expect(page.getByText("Fixture reply: Completion title sample", { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("conversation")!;
  const title = "Synthetic title: Completion title sample";
  try {
    await (await conversationMenu(page, "Completion title sample")).getByRole("menuitem", { name: "归档对话 · Completion title sample", exact: true }).click();
    await completedOnServer;
    expect(snapshot).toMatchObject({ title: "Completion title sample", titleSource: "message", status: "idle", archivedAt: expect.any(String) });
    expect((await request.post(`/api/conversations/${id}/title`, { data: {} })).status()).toBe(202);
    await expect(page.locator(".chat-title-bar")).toContainText(title);
    await expect(page.getByRole("button", { name: "生成标题", exact: true })).toHaveCount(0);
    const updated = (await (await request.get(`/api/conversations/${id}`)).json()).conversation as Conversation;
    expect(updated).toMatchObject({ title, titleSource: "automatic", updatedAt: snapshot.updatedAt });
    const delivered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/archive"));
    release();
    await (await delivered).finished();
    await page.getByLabel("消息", { exact: true }).fill("Unsent draft after automatic title");
    await expect(page.locator(".chat-title-bar")).toContainText(title);
    await expect(page.getByRole("button", { name: "生成标题", exact: true })).toHaveCount(0);
    expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation).toMatchObject({
      title, titleSource: "automatic", archivedAt: snapshot.archivedAt,
    });
  } finally { release(); }
});

test("an unresponsive CLI stops within a bounded time and explicit continuation retains protected occupancy", async ({ page,request }) => {
  await page.goto("/?project=controls&agent=worker&workspace=");
  await page.getByLabel("消息", { exact: true }).fill("ignore-stop");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const stop = page.getByRole("button", { name: "停止执行", exact: true });
  await expect(stop).toBeEnabled();
  const id=new URL(page.url()).searchParams.get('conversation')!;
  // This case tests an unresponsive submitted turn; preparation cancellation has its own case below.
  await expect.poll(async()=>Boolean((await(await request.get('/api/conversations/'+id)).json()).conversation.turnId)).toBe(true);
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute("title", "正在停止…");
  await expect(page.getByTestId("chat-status")).toHaveText("已中断", { timeout: 6000 });
  await page.getByLabel("消息", { exact: true }).fill("Continue personal reading");
  const continued = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/continue"));
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  expect((await continued).ok()).toBe(true);
  await expect(page.getByTestId("chat-status")).toHaveText("已中断");
  const queued=await(await request.get('/api/conversations/'+id+'/queue')).json();expect(queued.find((input:any)=>input.text==='Continue personal reading')).toMatchObject({state:'queued'});await expect(page.getByText('Fixture reply: Continue personal reading',{exact:true})).toHaveCount(0);
  const other=await(await request.post('/api/conversations',{data:{projectId:'controls',agentId:'worker',cli:'codex',workspaceId:null}})).json();expect((await request.post('/api/conversations/'+other.id+'/messages',{data:{text:'Other independent directory'}})).ok()).toBe(true);await expect.poll(async()=>(await(await request.get('/api/conversations/'+other.id)).json()).conversation.status).toBe('idle');expect((await(await request.get('/api/conversations/'+id+'/queue')).json()).find((input:any)=>input.text==='Continue personal reading').state).toBe('queued');
});

test("stop remains available before the native turn has started", async ({ page, request }) => {
  const { config, revision } = await (await request.get("/api/config")).json();
  config.agents[0].runtime = { codex: { args: ["--slow-start"] } };
  await request.put("/api/config", { data: { config, revision } });
  await page.goto("/?project=controls&agent=worker&workspace=");
  await page.getByLabel("消息", { exact: true }).fill("Read a personal sample");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const stop = page.getByRole("button", { name: "停止执行", exact: true });
  await expect(stop).toBeEnabled();
  const id = new URL(page.url()).searchParams.get("conversation");
  expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation.turnId).toBeNull();
  await stop.click();
  await expect(page.getByTestId("chat-status")).toHaveText("已中断", { timeout: 6000 });
  // Keep this intentionally empty history from colliding with the global New chat button in later cases.
  expect((await request.patch(`/api/conversations/${id}`, { data: { title: "Stopped personal startup" } })).ok()).toBe(true);
});

test("a stale idle snapshot cannot hide Stop for a newer running turn", async ({ page, request }) => {
  const c = await (await request.post("/api/conversations", { data: { projectId: "controls", agentId: "worker", cli: "codex", workspaceId:null } })).json();
  await request.patch(`/api/conversations/${c.id}`, { data: { title: "Personal stale status case" } });
  let release!: () => void, captured!: () => void, delivered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = new Promise<void>(resolve => { captured = resolve; });
  const oldDelivered = new Promise<void>(resolve => { delivered = resolve; });
  let reads = 0;
  await page.route(`**/api/conversations/${c.id}`, async route => {
    if (route.request().method() !== "GET" || ++reads !== 2) { await route.continue(); return; }
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  await page.goto(`/?project=controls&conversation=${c.id}`);
  await holding;
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.getByLabel("消息", { exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  try { await expect(page.getByTestId("chat-status")).toHaveText("执行中"); }
  finally { release(); }
  await oldDelivered;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("chat-status")).toHaveText("执行中");
  await expect(page.getByRole("button", { name: "停止执行", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "停止执行", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("已中断");
});
