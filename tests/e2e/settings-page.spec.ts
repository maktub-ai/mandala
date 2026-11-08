import {enterModelId} from './helpers/select';
import {pickDirectoryAgent, pickDirectoryProject, editAgentProfile} from './helpers/navigation';
import {openProjectBackground} from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { openConfigSection } from "./helpers/navigation";
import { openArea, openSidebar } from "./helpers/navigation";
import { chooseOption } from "./helpers/select";
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";


async function expectCatalog(page: import("@playwright/test").Page, cli: "Codex" | "OMP", value?: string) {
  const control = page.getByRole("combobox", { name: `${cli} 默认模型`, exact: true });
  await expect(control).toBeEnabled();
  await control.click();
  const current=await control.getAttribute("data-value");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(current&&current!==value?3:2);
  if (value) await expect(page.getByRole("listbox").locator(`[role="option"][data-value=${JSON.stringify(value)}]`)).toBeVisible();
  await page.keyboard.press("Escape");
}

test("many settings objects keep the selected configuration in the narrow viewport", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  const agents = Array.from({ length: 12 }, (_, index) => ({ id: `compact-agent-${index}`, name: `Synthetic worker ${index + 1}`,
    instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] }));
  const projects = Array.from({ length: 12 }, (_, index) => ({ id: `compact-project-${index}`, name: `Synthetic workspace ${index + 1}`,
    cwd: "/tmp", agentIds: [agents[index].id], resources: [], mcp: [], skills: [] }));
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, agents, projects } } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/agents");
  await expect(page.locator('.workspace-directory-row')).toHaveCount(12);
  await page.locator('.workspace-directory').getByRole('searchbox').fill('12');
  await page.locator('.workspace-directory-row').click();await editAgentProfile(page);
  await expect(page.locator('.identity-preview')).toBeInViewport();
  await expect(page.getByRole('textbox',{name:'智能体 名称',exact:true})).toHaveValue(agents[11].name);
  await pickDirectoryProject(page,projects[11].id);
  await expect(page.getByRole('textbox',{name:'项目名称',exact:true})).toHaveValue(projects[11].name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("navigation waits for the authenticated application before deciding sidebar visibility", async ({ page }) => {
  test.setTimeout(5000);
  await page.route('**/auth/session', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({json:{mode:'fixture',user:null}});
  });
  await page.goto('/');
  await openArea(page, '设置');
  await expect(page).toHaveURL(/\/settings\/general$/);
});

test("settings have separate pages and preserve edits between sections", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects: [], agents: [] } } })).ok()).toBe(true);
  await page.goto("/");
  await openArea(page, "设置");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await openConfigSection(page, "projects");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("dialog", { name: "项目与 智能体 配置" })).toHaveCount(0);
  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill("Synthetic project");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await openConfigSection(page, "agents");
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByRole("button", { name: "添加智能体" }).click();
  await page.getByRole("textbox", { name: "智能体 名称" }).fill("Synthetic agent");
  await chooseOption(page,'执行端','codex');await page.getByRole('button',{name:'创建智能体',exact:true}).click();
  await openConfigSection(page, "mcp");
  await expect(page).toHaveURL(/\/settings\/mcp$/);
  await openConfigSection(page, "skills");
  await expect(page).toHaveURL(/\/mana\/skills$/);
  await openConfigSection(page, "projects");
  await openProjectBackground(page);
  await expect(page.getByRole("textbox", { name: "项目名称" })).toHaveValue("Synthetic project");
  await waitForAutosave(page);
  await expect.poll(async () => {
    const { config } = await (await request.get("/api/config")).json();
    return [config.projects.map((item: { name: string }) => item.name), config.agents.map((item: { name: string }) => item.name)];
  }).toEqual([["Synthetic project"], ["Synthetic agent"]]);
  const { config } = await (await request.get("/api/config")).json();
  expect(config.projects.some((item: { name: string }) => item.name === "Synthetic project")).toBe(true);
  expect(config.agents.some((item: { name: string }) => item.name === "Synthetic agent")).toBe(true);
  await page.reload();
  await pickDirectoryProject(page);
  await openProjectBackground(page);
  await expect(page.getByRole("textbox", { name: "项目名称" })).toHaveValue("Synthetic project");
});

test("MCP and Skills definitions live in shared catalogs on a narrow screen", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  const config = { version: 2,
    projects: [{ id: "page-project", name: "Synthetic workspace", cwd: "/tmp", agentIds: ["page-agent"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "page-agent", name: "Synthetic worker", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] }] };
  await request.put("/api/config", { data: { config, revision } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/mcp");
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加 Skill" })).toHaveCount(0);
  await page.getByRole("button", { name: "添加 MCP" }).click();
  await page.getByRole("textbox", { name: "MCP 名称" }).fill("synthetic-project-mcp");
  await page.getByRole("textbox", { name: "启动命令" }).fill("node");
  await page.getByRole("button", { name: "创建 MCP", exact: true }).click();
  await openConfigSection(page, "skills");
  await expect(page.getByRole("button", { name: "添加 MCP" })).toHaveCount(0);
  await page.getByRole("button", { name: "注册技能", exact: true }).click();
  const register = page.getByRole("dialog", { name: "注册技能", exact: true });
  await register.getByRole("textbox", { name: "技能标识", exact: true }).fill("synthetic-agent-skill");
  await register.getByRole("textbox", { name: "SKILL.md 内容", exact: true }).fill("---\nname: synthetic-agent-skill\ndescription: Shared synthetic instructions\n---\n\n# Synthetic skill\n\nShared instructions.");
  const savedSkill = page.waitForResponse(response => response.url().endsWith("/api/config") && response.request().method() === "PUT");
  await register.getByRole("button", { name: "注册技能", exact: true }).click();
  const savedSkillResponse = await savedSkill;
  expect(savedSkillResponse.ok(), await savedSkillResponse.text()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.connections?.[0]?.name).toBe("synthetic-project-mcp");
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.connections[0].name).toBe("synthetic-project-mcp");
  expect(saved.skillLibrary[0]).toMatchObject({ name: "synthetic-agent-skill", content: "---\nname: synthetic-agent-skill\ndescription: Shared synthetic instructions\n---\n\n# Synthetic skill\n\nShared instructions." });
});

test("chooses existing local folders for the project and a linked resource before saving", async ({ page, request }) => {
  const root = mkdtempSync(join(tmpdir(), "mana-picker-"));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "private.txt"), "fixture");
  try {
    const { revision } = await (await request.get("/api/config")).json();
    const config = { version: 2,
      projects: [{ id: "folder-project", name: "Folder project", cwd: tmpdir(), agentIds: [], resources: [], mcp: [], skills: [] }],
      agents: [] };
    await request.put("/api/config", { data: { config, revision } });
    await page.goto("/settings/projects");await pickDirectoryProject(page);
    await openProjectBackground(page);
    await page.getByRole("tab", { name: "资源", exact: true }).click();
    await page.getByRole("button", { name: "浏览文件夹" }).click();
    const picker = page.getByRole("dialog", { name: "选择文件夹" });
    await expect(picker.getByRole("button", { name: basename(root) })).toBeVisible();
    await expect(picker).not.toContainText("private.txt");
    await picker.getByRole("button", { name: basename(root) }).click();
    await picker.getByRole("button", { name: "使用此文件夹" }).click();
    await expect(page.getByRole("textbox", { name: "主工作目录" })).toHaveValue(root);
    expect((await (await request.get("/api/config")).json()).config.projects[0].cwd).toBe(tmpdir());

    await page.getByRole("button", { name: "添加资源" }).click();
    await page.getByRole("button", { name: "浏览本地目录" }).click();
    await picker.getByRole("textbox", { name: "目录路径" }).fill(join(root, "notes"));
    await expect(picker.getByRole("textbox", { name: "目录路径" })).toHaveValue(join(root, "notes"));
    await picker.getByRole("button", { name: "前往" }).click();
    await expect(picker.locator(".settings-footer span")).toHaveText(join(root, "notes"));
    await picker.getByRole("button", { name: "使用此文件夹" }).click();
    await expect(page.getByRole("textbox", { name: "资源位置" })).toHaveValue(join(root, "notes"));
    await expect(page.getByRole("textbox", { name: "资源名称" })).toHaveValue("notes");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "浏览文件夹" }).click();
    await picker.getByRole("textbox", { name: "目录路径" }).fill(join(root, "missing"));
    await picker.getByRole("button", { name: "前往" }).click();
    await expect(picker.getByRole("alert")).toContainText("无法打开这个目录");
    await expect(picker.getByRole("button", { name: "使用此文件夹" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await picker.getByRole("button", { name: "关闭文件夹选择" }).click();
    await waitForAutosave(page);
    await expect.poll(async () => (await (await request.get("/api/config")).json()).config.projects[0].resources[0]?.location).toBe(join(root, "notes"));
    const saved = (await (await request.get("/api/config")).json()).config;
    expect(saved.projects[0].cwd).toBe(root);
    expect(saved.projects[0].resources[0]).toMatchObject({ kind: "local", location: join(root, "notes"), label: "notes" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function sharedSettings(request: import('@playwright/test').APIRequestContext) {
  const { revision } = await (await request.get('/api/config')).json();
  const config = { version: 2,
    projects: ['one', 'two'].map((id) => ({ id, name: `Project ${id}`, cwd: '/tmp', agentIds: ['shared'], resources: [], mcp: [], skills: [] })),
    agents: [{ id: 'shared', name: 'Shared reader', instructions: '# Reading\n\nReview carefully.', defaultCli: 'omp', models: {}, mcp: [], skills: [] }] };
  await request.put('/api/config', { data: { config, revision } });
  return config;
}
test('Agent picker completes delayed navigation before opening the next settings page',async({page,request})=>{
 await sharedSettings(request);await page.setViewportSize({width:390,height:844});await page.goto('/agents');
 await expect(page.locator('.workspace-directory-row[href="/agents/shared"]')).toBeVisible();
 await page.route('**/api/config',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.continue();});
 await pickDirectoryAgent(page,'shared');
 expect(new URL(page.url()).pathname).toBe('/agents/shared');
 await openConfigSection(page,'general');await expect(page).toHaveURL(/\/settings\/general$/);
});

test('adding a global agent keeps project associations unchanged', async ({ page, request }) => {
  const before = await sharedSettings(request);
  await page.goto('/settings/agents');
  await expect(page.locator('.workspace-directory')).toBeVisible();
  await page.getByRole('button', { name: '添加智能体', exact: true }).click();
  await page.getByLabel('智能体 名称', { exact: true }).fill('Independent agent');
  await chooseOption(page,'执行端','codex');await page.getByRole('button',{name:'创建智能体',exact:true}).click();
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.agents.length).toBe(2);
  const saved = (await (await request.get('/api/config')).json()).config;
  expect(saved.projects.map((p: { agentIds: string[] }) => p.agentIds)).toEqual(before.projects.map((p) => p.agentIds));
});

test('waits for saved configuration before allowing a new object', async ({ page, request }) => {
  await sharedSettings(request);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/config', async route => { await gate; await route.continue(); });
  await page.goto('/agents');
  try { await expect(page.getByRole('status', { name: '正在读取配置…', exact: true }).first()).toBeVisible();await expect(page.getByRole('button', { name: '添加智能体', exact: true })).toHaveCount(0); }
  finally { release(); }
  await expect(page.locator('.workspace-directory')).toBeVisible();
  await page.getByRole('button', { name: '添加智能体', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消新增 智能体', exact: true })).toBeVisible();
});

test('cancels an accidental new object before saving another agent', async ({ page, request }) => {
  await sharedSettings(request);
  await page.goto('/agents');
  await page.getByRole('button', { name: '添加智能体', exact: true }).click();
  await page.getByRole('button', { name: '取消新增 智能体', exact: true }).click();await pickDirectoryAgent(page,'shared');
  await page.getByLabel('智能体 名称', { exact: true }).fill('Renamed shared reader');
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.agents[0].name).toBe('Renamed shared reader');
  expect((await (await request.get('/api/config')).json()).config.agents).toHaveLength(1);
});

test('shows shared agent relationships and readable instructions on a narrow screen', async ({ page, request }) => {
  await sharedSettings(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/agents');await pickDirectoryAgent(page);
  const relationships = page.getByRole('region', { name: '关联项目', exact: true });
  await expect(relationships).toContainText('Project one');
  await expect(relationships).toContainText('Project two');
  await page.getByRole('button', { name: '预览指令', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('loads CLI-specific candidates independently of the OMP chat', async ({ page, request }) => {
  await sharedSettings(request);
  const conversation = await (await request.post('/api/conversations', { data: { projectId: 'one', agentId: 'shared', cli: 'omp' } })).json();
  await page.addInitScript((id) => localStorage.setItem('mana-chat', id), conversation.id);
  await page.route('**/api/models?*', async (route) => {
    const cli = new URL(route.request().url()).searchParams.get('cli');
    await route.fulfill({ json: [{ id: `${cli}-only`, label: `${cli} catalog` }] });
  });
  await page.goto('/?conversation='+conversation.id+'&project=one');
  await openArea(page, "设置");
  await openArea(page, '团队');await pickDirectoryAgent(page, 'shared');
  await page.getByRole("tab", { name: "执行", exact: true }).click();
  await expectCatalog(page, "OMP", 'omp-only');
  await chooseOption(page, "默认执行端", "codex");
  await expectCatalog(page, "Codex", 'codex-only');
  await expect(page.getByRole('combobox', { name: '模型目录读取环境' })).toHaveCount(0);
});

test('Agent catalogs preserve associations and custom defaults', async ({ page, request }) => {
  const before = await sharedSettings(request);
  await page.route('**/api/models?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: [{ id: `${params.get('agentId')}-${params.get('cli')}`, label: 'Synthetic catalog' }] });
  });
  await page.goto('/settings/agents');await pickDirectoryAgent(page);
  await page.getByRole('tab', { name: '执行', exact: true }).click();
  await enterModelId(page,page.getByLabel('OMP 默认模型', { exact: true }),'custom-omp-model');
  await expectCatalog(page, "OMP", 'shared-omp');
  await chooseOption(page, "默认执行端", "codex");
  await enterModelId(page,page.getByLabel('Codex 默认模型', { exact: true }),'custom-codex-model');
  await expectCatalog(page, "Codex", 'shared-codex');
  await expect(page.getByLabel('Codex 默认模型', { exact: true })).toHaveAttribute('data-value','custom-codex-model');
  await chooseOption(page, "默认执行端", "omp");
  await expect(page.getByLabel('OMP 默认模型', { exact: true })).toHaveAttribute('data-value','custom-omp-model');
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.agents[0].models.omp).toBe('custom-omp-model');
  expect((await (await request.get('/api/config')).json()).config.projects.map((p: { agentIds: string[] }) => p.agentIds)).toEqual(before.projects.map((p) => p.agentIds));
});

test('unassociated agents can use defaults and custom IDs without an invented environment', async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  await request.put('/api/config', { data: { revision, config: { version: 2, projects: [],
    agents: [{ id: 'solo', name: 'Solo', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }] } } });
  const modelRequests: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/models') modelRequests.push(r.url()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/agents');await pickDirectoryAgent(page);
  await openConfigSection(page, "general");
  await chooseOption(page, page.getByLabel('Language / 语言'), 'en');
  await openConfigSection(page, "agents");await pickDirectoryAgent(page, 'solo');
  await page.getByRole('tab', { name: 'Execution', exact: true }).click();
  await expect(page.getByLabel('Model catalog environment', { exact: true })).toHaveCount(0);
  await enterModelId(page,page.getByLabel('Codex default model', { exact: true }),'custom-id');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();await editAgentProfile(page);
  await page.getByLabel('Responsibilities & instructions', { exact: true }).fill('# My notes\n\n' + 'Long instructions. '.repeat(40));
  await page.getByRole('button', { name: 'Preview instructions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My notes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit instructions', exact: true }).click();
  await expect(page.getByLabel('Responsibilities & instructions', { exact: true })).toHaveValue(/Long instructions\./);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(modelRequests.some(url => new URL(url).searchParams.get("agentId") === "solo")).toBe(true);
});

test('cancels only unsaved projects and preserves changes to existing objects', async ({ page, request }) => {
  await sharedSettings(request);
  await page.goto('/settings/agents');await pickDirectoryAgent(page);
  await page.getByLabel('职责与指令', { exact: true }).fill('Keep my existing edit');
  await openArea(page, '项目');
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByRole('button', { name: '取消新增项目', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消新增项目', exact: true })).toHaveCount(0);
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.agents[0].instructions).toBe('Keep my existing edit');
  expect((await (await request.get('/api/config')).json()).config.projects).toHaveLength(2);
});

test('reloads model catalogs after saving Agent configuration', async ({ page, request }) => {
  await sharedSettings(request);
  const requests = { codex: 0, omp: 0 };
  await page.route('**/api/models?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const cli = params.get('cli') as 'codex' | 'omp';
    requests[cli] += 1;
    await route.fulfill({ json: [{ id: `${cli}-${requests[cli]}`, label: 'Synthetic catalog' }] });
  });
  await page.goto('/agents');await pickDirectoryAgent(page);
  await page.getByRole('tab', { name: '执行', exact: true }).click();
  await expectCatalog(page, "OMP");
  await chooseOption(page, "默认执行端", "codex");
  await expectCatalog(page, "Codex");
  await page.getByText('启动参数与环境变量', { exact: true }).click();
  await page.getByRole('group', { name: 'Codex 运行参数' }).getByLabel('启动参数（每行一个）').fill('--profile\npersonal');
  const before = { ...requests };
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.agents[0].runtime?.codex?.args).toEqual(['--profile', 'personal']);
  await expect.poll(() => requests.codex).toBeGreaterThan(before.codex);
  await expect.poll(() => requests.omp).toBeGreaterThan(before.omp);
  await expectCatalog(page, "Codex", `codex-${requests.codex}`);
  await chooseOption(page, "默认执行端", "omp");
  await expectCatalog(page, "OMP", `omp-${requests.omp}`);
});
