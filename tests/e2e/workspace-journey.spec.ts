import {pickDirectoryAgent, pickDirectoryProject} from './helpers/navigation';
import { openArea, conversationMenu } from "./helpers/navigation";
import { chooseOption, expectSelection } from "./helpers/select";
import { type APIRequestContext } from "@playwright/test";
import { test, expect } from "./helpers/execution-fixture";
import type { KnowledgeEntry } from "../../shared/types";

async function fixture(request: APIRequestContext, key: string, executionDirectory: string) {
  const projects = ["garden", "studio"].map((name) => ({
    id: `journey-${key}-${name}`, name: `Journey ${key} ${name}`, cwd: executionDirectory,
    agentIds: name === "garden" ? ["shared"] : ["shared", "reviewer"], resources: [], mcp: [], skills: [],
  }));
  const config = { version: 2, projects, agents: ["shared", "reviewer"].map((id) => ({
    id, name: `Worker ${key} ${id}`, instructions: "Synthetic workspace acceptance only.",
    defaultCli: "codex", models: {}, mcp: [], skills: [],
  })) };
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config } })).ok()).toBe(true);
  return config;
}

async function chat(request: APIRequestContext, projectId: string, agentId: string, title: string) {
  const response = await request.post("/api/conversations", { data: { projectId, agentId, cli: "codex" } });
  expect(response.ok()).toBe(true);
  const conversation = await response.json();
  expect((await request.patch(`/api/conversations/${conversation.id}`, { data: { title } })).ok()).toBe(true);
  return conversation;
}

async function detail(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/conversations/${id}`)).json()).conversation;
}

test("cross-project views sort, archive and restore a shared Agent's conversations persistently", async ({ page, request, executionDirectory }) => {
  const config = await fixture(request, "library", executionDirectory);
  const titles = ["A Journey library", "B Journey library", "C Journey library"];
  const a = await chat(request, config.projects[0].id, "shared", titles[0]);
  const b = await chat(request, config.projects[1].id, "shared", titles[1]);
  const c = await chat(request, config.projects[1].id, "reviewer", titles[2]);
  expect(Date.parse(c.createdAt)).toBeGreaterThan(Date.parse(a.createdAt));
  expect((await request.post(`/api/conversations/${a.id}/messages`, { data: { text: "Library activity" } })).ok()).toBe(true);
  await expect.poll(async () => (await detail(request, a.id)).status).toBe("idle");
  await page.goto(`/?project=${config.projects[0].id}&conversation=${a.id}`);
  await expect(page.getByText("Fixture reply: Library activity", { exact: true })).toBeVisible();
  await page.getByLabel("搜索对话", { exact: true }).fill("Journey library");
  const view = page.getByRole("combobox", { name: "会话视图", exact: true });
  const sort = page.getByLabel("排序方式", { exact: true });
  const list = page.getByRole("navigation", { name: "会话列表", exact: true });
  const openingTitles = () => list.locator(".chat-link strong");
  await chooseOption(page, view, "recent");
  await chooseOption(page, sort, "activity");
  await expect(openingTitles()).toHaveText([titles[0], titles[2], titles[1]]);
  await expect(list.getByRole("button", { name: titles[0], exact: true }).locator("time"))
    .toHaveAttribute("datetime", (await detail(request, a.id)).updatedAt);
  await chooseOption(page, sort, "created");
  await expect(openingTitles()).toHaveText([titles[2], titles[1], titles[0]]);
  await expect(list.getByRole("button", { name: titles[0], exact: true }).locator("time"))
    .toHaveAttribute("datetime", a.createdAt);
  await chooseOption(page, sort, "name");
  await expect(openingTitles()).toHaveText(titles);
  await chooseOption(page, view, "projects");
  await expect(list.getByRole("region", { name: config.projects[0].name, exact: true }).locator(".chat-link strong"))
    .toHaveText([titles[0]]);
  await expect(list.getByRole("region", { name: config.projects[1].name, exact: true }).locator(".chat-link strong"))
    .toHaveText([titles[1], titles[2]]);
  await chooseOption(page, view, "agents");
  await expect(list.getByRole("region", { name: config.agents[0].name, exact: true }).locator(".chat-link strong"))
    .toHaveText([titles[0], titles[1]]);
  await expect(list.getByRole("region", { name: config.agents[1].name, exact: true }).locator(".chat-link strong"))
    .toHaveText([titles[2]]);
  await (await conversationMenu(page, titles[0])).getByRole("menuitem", { name: `归档对话 · ${titles[0]}`, exact: true }).click();
  await expect.poll(async () => (await detail(request, a.id)).archivedAt).toEqual(expect.any(String));
  expect((await detail(request, a.id)).status).toBe("idle");
  await chooseOption(page, view, "recent");
  await expect(openingTitles()).toHaveText([titles[1], titles[2]]);
  await expect(page.getByText("Fixture reply: Library activity", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`conversation=${a.id}(?:&|$)`));
  await page.reload();
  await expectSelection(view, "recent");
  await expectSelection(sort, "name");
  await page.getByLabel("搜索对话", { exact: true }).fill("Journey library");
  await expect(openingTitles()).toHaveText([titles[1], titles[2]]);
  await chooseOption(page, view, "archived");
  await (await conversationMenu(page, titles[0])).getByRole("menuitem", { name: `取消归档 · ${titles[0]}`, exact: true }).click();
  await expect.poll(async () => (await detail(request, a.id)).archivedAt).toBeNull();
  await chooseOption(page, view, "recent");
  await expect(openingTitles()).toHaveText(titles);
  await list.getByRole("button", { name: titles[1], exact: true }).click();
  await expect(page.getByLabel("当前项目", { exact: true })).toHaveCount(0);
  await expect(page.locator(".topbar")).toContainText(config.projects[1].name);
  await expect(page.locator(".topbar")).toContainText(config.agents[0].name);
  await expect(page.getByLabel("当前 智能体", { exact: true })).toHaveCount(0);
  expect((await detail(request, b.id)).agentId).toBe("shared");
});

test("archiving cannot stop or alter an executing conversation", async ({ page, request, executionDirectory }) => {
  const config = await fixture(request, "busy", executionDirectory);
  const a = await chat(request, config.projects[0].id, "shared", "Journey busy conversation");
  await request.post(`/api/conversations/${a.id}/messages`, { data: { text: "hold" } });
  await expect.poll(async () => (await detail(request, a.id)).status).toBe("running");
  try {
    await page.goto(`/?project=${config.projects[0].id}&conversation=${a.id}`);
    await expect((await conversationMenu(page, "Journey busy conversation")).getByRole("menuitem", { name: "归档对话 · Journey busy conversation", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    const before = await detail(request, a.id);
    expect((await request.post(`/api/conversations/${a.id}/archive`, { data: { archived: true } })).status()).toBe(409);
    expect(await detail(request, a.id)).toEqual(before);
    await expect(page.getByRole("button", { name: "停止执行", exact: true })).toBeEnabled();
    await expect(page.getByText("Fixture reply: hold", { exact: true })).toBeVisible();
  } finally {
    await request.post(`/api/conversations/${a.id}/stop`);
  }
});

test("general preferences preserve the unsent draft and preparation disappears after first send", async ({ page, request, executionDirectory }) => {
  const config = await fixture(request, "setup", executionDirectory);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?project=${config.projects[0].id}&agent=shared`);
  const setup = page.getByRole("region", { name: "新对话准备", exact: true });
  await expectSelection(setup.getByLabel("当前 智能体", { exact: true }), "shared");
  await expectSelection(setup.getByLabel("当前 CLI", { exact: true }), "codex");
  await page.getByRole("button", { name: "输入区设置", exact: true }).click();
  await expect(page.getByRole("group", { name: "输入区设置", exact: true }).getByLabel("模型", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("当前项目", { exact: true })).toContainText(config.projects[0].name);
  await page.getByLabel("消息", { exact: true }).fill("Journey preserved draft");
  const before = await (await request.get("/api/conversations")).json();
  await page.getByRole("button", { name: "会话列表", exact: true }).click();
  await expect(page.locator(".sidebar").getByLabel("Language / 语言")).toHaveCount(0);
  await expect(page.locator(".sidebar").getByRole("button", { name: "切换主题", exact: true })).toHaveCount(0);
  await openArea(page, "设置");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.getByRole("group", { name: "显示模式", exact: true }).getByRole("button", { name: "浅色", exact: true }).click();
  await chooseOption(page, page.getByLabel("Language / 语言"), "en");
  await openArea(page, "Chats");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Journey preserved draft");
  expect(await (await request.get("/api/conversations")).json()).toEqual(before);
  await expect(page.getByRole("region", { name: "New chat setup", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Fixture reply: Journey preserved draft", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "New chat setup", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Current agent", { exact: true })).toHaveCount(0);
  await expect(page.locator(".topbar")).toContainText(config.agents[0].name);
  await page.getByRole("button", { name: "Expand right sidebar", exact: true }).click();
  const effective = page.getByRole("dialog", { name: "Right sidebar", exact: true });
  await expect(effective).toBeVisible();
  await expect(effective).toContainText(config.projects[0].name);
  await expect(effective).toContainText(config.agents[0].name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByText("Fixture reply: Journey preserved draft", { exact: true })).toBeVisible();
});

test("runtime reference validation rejects literals without overwriting saved configuration", async ({ page, request, executionDirectory }) => {
  await fixture(request, "references", executionDirectory);
  const { config, revision } = await (await request.get("/api/config")).json();
  config.agents[0].runtime = { codex: { env: { JOURNEY_TOKEN: "${JOURNEY_SOURCE}" } } };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  const saved = await (await request.get("/api/config")).json();
  const invalid = structuredClone(saved.config);
  invalid.agents[0].runtime.codex.env.JOURNEY_TOKEN = "synthetic-literal-value";
  expect((await request.put("/api/config", { data: { config: invalid, revision: saved.revision } })).status()).toBe(400);
  expect(await (await request.get("/api/config")).json()).toEqual(saved);
  await page.goto("/settings/runtime");await pickDirectoryAgent(page, 'shared', '执行');
  await page.getByText("启动参数与环境变量", { exact: true }).click();
  const codex = page.getByRole("group", { name: "Codex 运行参数", exact: true });
  await expect(codex.getByLabel("变量名称", { exact: true })).toHaveValue("JOURNEY_TOKEN");
  await expect(codex.getByLabel("环境变量来源名称", { exact: true })).toHaveValue("JOURNEY_SOURCE");
});

test("pending first-send fixes the Agent, CLI and model until creation finishes", async ({ page, request, executionDirectory }) => {
  const config = await fixture(request, "pending-setup", executionDirectory);
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
  await page.goto(`/?project=${config.projects[1].id}&agent=shared`);
  const setup = page.getByRole("region", { name: "新对话准备", exact: true });
  const agent = setup.getByLabel("当前 智能体", { exact: true });
  const cli = setup.getByLabel("当前 CLI", { exact: true });
  const model = page.locator(".composer").getByLabel("模型", { exact: true });
  await expectSelection(agent, "shared");
  await agent.click();
  await expect(page.getByRole("listbox").getByRole("option"))
    .toHaveCount(config.agents.length + 1);
  await expect(page.getByRole("option", { name: "不使用 智能体", exact: true })).toBeVisible();
  for (const item of config.agents) {
    await expect(page.getByRole("option", { name: item.name, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expectSelection(cli, "codex");
  await expectSelection(model, "");
  await page.getByLabel("消息", { exact: true }).fill("Journey pending identity");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await creating;
  try {
    await expect(agent).toBeDisabled();
    await expect(cli).toBeDisabled();
    await expect(model).toBeDisabled();
    await expectSelection(agent, "shared");
    await expectSelection(cli, "codex");
    await expectSelection(model, "");
  } finally { release(); }
  await expect(page.getByText("Fixture reply: Journey pending identity", { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("conversation");
  expect(await detail(request, id!)).toMatchObject({ projectId: config.projects[1].id, agentId: "shared", cli: "codex", model: "model-fixture" });
  await expect(setup).toHaveCount(0);
});

test("MANA retains legacy candidates in read-only history across project filters without an adoption queue", async ({ page, request, executionDirectory }) => {
  const config=await fixture(request,"knowledge",executionDirectory),source=await chat(request,config.projects[0].id,"shared","Journey knowledge source");
  const entries:KnowledgeEntry[]=[];
  for(const project of config.projects){const response=await request.post("/api/knowledge",{data:{kind:"memory",title:`Memory for ${project.name}`,content:"Synthetic review notes.",scope:"project",projectId:project.id,level:"L2",status:"candidate",...(project.id===config.projects[0].id?{sourceConversationId:source.id}:{})}});expect(response.ok()).toBe(true);entries.push(await response.json());}
  const records=(await(await request.get('/api/v2/memory/records')).json()).records,chosenRecord=records.find((r:any)=>r.legacyId===entries[0].id);
  await page.goto('/mana?tab=memory&project='+config.projects[0].id);await page.locator('summary').filter({hasText:'高级筛选'}).click();await chooseOption(page,'状态','all');
  const history=page.locator('.memory-history');await history.locator(':scope > summary').click();
  const chosen=history.getByRole('article',{name:entries[0].title,exact:true});await expect(chosen).toContainText('旧版候选');await expect(chosen).toContainText('旧版未采用记录，仅保留历史，不会提供给对话。');
  await expect(chosen.getByRole('button',{name:/确认|纠正|撤回/})).toHaveCount(0);await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(0);await expect(page.getByRole('article',{name:entries[1].title,exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'确认采用',exact:true})).toHaveCount(0);
  for(const action of ['confirm','correct']){const response=await request.post('/api/v2/memory/records/'+chosenRecord.recordId+'/'+action,{data:{expectedRevision:chosenRecord.revision,...action==='correct'?{text:'Forbidden adoption'}:{}}});expect(response.status()).toBe(410);expect(await response.json()).toMatchObject({error:'legacy_memory_confirmation_retired'});}
  await chooseOption(page,page.getByRole('combobox',{name:'项目范围',exact:true}),config.projects[1].id);await expect(history.getByRole('article',{name:entries[1].title,exact:true})).toContainText('旧版候选');await page.reload();await page.locator('summary').filter({hasText:'高级筛选'}).click();await chooseOption(page,'状态','all');await history.locator(':scope > summary').click();await expect(history.getByRole('article',{name:entries[1].title,exact:true})).toBeVisible();
  const readback=await request.get('/api/knowledge',{maxRetries:1}),stored=await readback.json();expect(readback.ok(),JSON.stringify({status:readback.status(),body:stored})).toBe(true);expect(Array.isArray(stored)).toBe(true);for(const entry of entries)expect(stored.find((r:KnowledgeEntry)=>r.id===entry.id)).toMatchObject({status:'candidate',projectId:entry.projectId,content:entry.content,level:'L2'});
  expect((await(await request.get('/api/v2/memory/records/'+chosenRecord.recordId)).json())).toEqual(chosenRecord);
  await chooseOption(page,page.getByRole('combobox',{name:'项目范围',exact:true}),config.projects[0].id);await chosen.getByRole('button',{name:'查看来源对话',exact:true}).click();await expect(page).toHaveURL(new RegExp(`conversation=${source.id}(?:&|$)`));await expect(page.locator('.chat-title-bar')).toContainText('Journey knowledge source');
});
