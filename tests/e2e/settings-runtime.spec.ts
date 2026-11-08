import {pickDirectoryAgent, pickDirectoryProject} from './helpers/navigation';
import {waitForAutosave} from './helpers/settings';
import { chooseOption, enterModelId, expectSelection } from "./helpers/select";
import { test, expect, type APIRequestContext } from "@playwright/test";

async function fixture(request: APIRequestContext) {
  const { revision } = await (await request.get("/api/config")).json();
  const config = { version: 2,
    projects: [{ id: "runtime-project", name: "Runtime project", cwd: "/tmp", agentIds: ["runtime-agent"], resources: [], mcp: [], skills: [] }],
    agents: ["runtime-agent", "runtime-agent-other"].map((id) => ({ id, name: id === "runtime-agent" ? "Runtime agent" : "Other agent", instructions: "Read personal examples", defaultCli: "codex", models: {}, mcp: [], skills: [] })) };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
}

test("general settings persist language and theme", async ({ page, request }) => {
  await fixture(request);
  await page.goto("/settings/general");
  await expect(page.getByRole("heading", { name: "通用设置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await chooseOption(page, page.getByLabel("Language / 语言"), "en");
  await expect(page.getByRole("heading", { name: "General settings", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("runtime arguments and environment references save independently for each CLI", async ({ page, request }) => {
  await fixture(request);
  await page.goto("/settings/runtime");await pickDirectoryAgent(page, 'runtime-agent', '执行');
  await page.getByText("启动参数与环境变量", { exact: true }).click();
  await expect(page.getByText("参数与环境变量随此 智能体 使用，按所选 CLI 分别加载。", { exact: true })).toBeVisible();
  await expect(page.getByText("Project 启动参数整组覆盖 智能体；环境变量按名称覆盖，其他变量继续继承。", { exact: true })).toHaveCount(0);
  const agentCodex = page.getByRole("group", { name: "Codex 运行参数", exact: true });
  await agentCodex.getByLabel("启动参数（每行一个）", { exact: true }).fill("--profile\npersonal");
  await agentCodex.getByRole("button", { name: "添加环境变量引用", exact: true }).click();
  await agentCodex.getByLabel("变量名称", { exact: true }).fill("CUSTOM_SERVICE_TOKEN");
  await agentCodex.getByLabel("环境变量来源名称", { exact: true }).fill("PERSONAL_TOKEN");
  await chooseOption(page, "默认执行端", "omp");
  const projectOmp = page.getByRole("group", { name: "OMP 运行参数", exact: true });
  await projectOmp.getByLabel("启动参数（每行一个）", { exact: true }).fill("--thinking\nlow");
  await waitForAutosave(page);
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.agents[0].runtime.codex).toEqual({ args: ["--profile", "personal"], env: { CUSTOM_SERVICE_TOKEN: "${PERSONAL_TOKEN}" } });
  expect(saved.agents[0].runtime.omp).toEqual({ args: ["--thinking", "low"] });
  expect(saved.projects[0].runtime).toBeUndefined();
  await page.getByRole("group", { name: "OMP 运行参数", exact: true }).getByRole("button", { name: "清除此 CLI 配置", exact: true }).click();
  await expect(projectOmp.getByLabel("启动参数（每行一个）", { exact: true })).toHaveValue("");
});

test("deep-memory controls default on, titles default off, and independent opt-outs persist with CLI and model", async ({ page, request }) => {
  await fixture(request);
  await page.goto("/settings/system");
  await expect(page.getByLabel("自动生成对话标题", { exact: true })).not.toBeChecked();
  for (const label of ["请求记忆生成", "请求记忆读取"]) await expect(page.getByLabel(label, { exact: true })).toBeChecked();
  await expect(page.getByLabel("会话闲置小时数", {exact:true})).toHaveCount(0);
  await expect(page.getByText("请求结束后提炼事实，整合场景知识与长期上下文。生成与读取可独立控制。",{exact:true})).toBeVisible();
  await expect(page.getByText("记忆绑定来源 智能体。自动提炼的 L1/L2 默认采用，L3/L4 与同名冲突需确认；仅已采用记忆按范围加载。",{exact:true})).toHaveCount(0);
  await page.getByText("系统默认与运行说明", { exact: true }).click();
  await chooseOption(page, page.getByLabel("系统任务执行端", { exact: true }), "omp");
  await enterModelId(page, page.getByLabel("系统任务模型", { exact: true }), "custom-system-model");
  await page.getByLabel("自动生成对话标题", { exact: true }).check();
  await page.getByLabel("请求记忆生成", { exact: true }).uncheck();
  await waitForAutosave(page);
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.system).toMatchObject({ cli: "omp", model: "custom-system-model", automaticTitles: true, memory: {request:{generate:false,read:true}} });
  expect(saved.agents[0].models).toEqual({});
  await page.reload();
  await page.getByText("系统默认与运行说明", { exact: true }).click();
  await expect(page.getByLabel("请求记忆生成", {exact:true})).not.toBeChecked();
  await expect(page.getByLabel("会话记忆读取", {exact:true})).toHaveCount(0);
  await expect(page.getByLabel("请求记忆读取", {exact:true})).toBeChecked();
  await expect(page.getByLabel("会话记忆生成", {exact:true})).toHaveCount(0);
  await expect(page.getByLabel("自动生成对话标题", {exact:true})).toBeChecked();
  await expectSelection(page.getByLabel("系统任务执行端", { exact: true }), "omp");
  await expectSelection(page.getByLabel("系统任务模型", { exact: true }), "custom-system-model");
});

test("runtime settings remain usable on a narrow screen without storing secret values", async ({ page, request }) => {
  await fixture(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/runtime");await pickDirectoryAgent(page, 'runtime-agent', '执行');
  await page.getByText("启动参数与环境变量", { exact: true }).click();
  const codex = page.getByRole("group", { name: "Codex 运行参数", exact: true });
  await codex.getByRole("button", { name: "添加环境变量引用", exact: true }).click();
  await codex.getByLabel("变量名称", { exact: true }).fill("PERSONAL_KEY");
  await codex.getByLabel("环境变量来源名称", { exact: true }).fill("PERSONAL_KEY_SOURCE");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await waitForAutosave(page);
  expect((await (await request.get("/api/config")).json()).config.agents[0].runtime.codex.env.PERSONAL_KEY).toBe("${PERSONAL_KEY_SOURCE}");
});

test("legacy Project parameters remain inactive until migrated to a chosen Agent", async ({ page, request }) => {
  await fixture(request);
  const { config, revision } = await (await request.get("/api/config")).json();
  config.projects[0].runtime = { codex: { args: ["--profile", "legacy"] } };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  await page.goto("/projects/manage");await pickDirectoryProject(page);
  await page.getByText("待迁移的旧运行参数", { exact: true }).click();
  await expect(page.getByRole("button", { name: "替换 智能体 参数并移除旧配置" })).toBeDisabled();
  await chooseOption(page, "迁移到 智能体", "runtime-agent");
  await page.getByRole("button", { name: "替换 智能体 参数并移除旧配置" }).click();
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.agents[0].runtime?.codex.args).toEqual(["--profile", "legacy"]);
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.projects[0].legacyRuntime).toBeUndefined();
  expect(saved.agents[1].runtime).toBeUndefined();
});

test("rejects duplicate environment names without losing either original reference", async ({ page, request }) => {
  await fixture(request);
  const { config, revision } = await (await request.get("/api/config")).json();
  config.agents[0].runtime = { codex: { env: { X: "${A}", Y: "${B}" } } };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  await page.goto("/settings/runtime");await pickDirectoryAgent(page, 'runtime-agent', '执行');
  await page.getByText("启动参数与环境变量", { exact: true }).click();
  const codex = page.getByRole("group", { name: "Codex 运行参数", exact: true });
  await codex.getByLabel("变量名称", { exact: true }).nth(1).fill("X");
  await expect(codex.getByRole("alert")).toContainText("修改未应用，原引用已保留");
  await expect(codex.getByLabel("变量名称", { exact: true }).nth(0)).toHaveValue("X");
  await expect(codex.getByLabel("变量名称", { exact: true }).nth(1)).toHaveValue("Y");
  await expect(codex.getByLabel("环境变量来源名称", { exact: true }).nth(0)).toHaveValue("A");
  await expect(codex.getByLabel("环境变量来源名称", { exact: true }).nth(1)).toHaveValue("B");
  await waitForAutosave(page);
  expect((await (await request.get("/api/config")).json()).config.agents[0].runtime.codex.env).toEqual({ X: "${A}", Y: "${B}" });
});


test("switching Agents keeps separate CLI arguments and memory owner references", async ({ page, request }) => {
  await fixture(request);
  await page.goto("/settings/runtime");await pickDirectoryAgent(page, 'runtime-agent', '执行');
  await page.getByText("启动参数与环境变量", { exact: true }).click();
  const codex = page.getByRole("group", { name: "Codex 运行参数", exact: true });
  await codex.getByLabel("启动参数（每行一个）", { exact: true }).fill("--profile\npersonal-a");
  await codex.getByRole("button", { name: "添加环境变量引用", exact: true }).click();
  await codex.getByLabel("变量名称", { exact: true }).fill("MEMORY_OWNER");
  await codex.getByLabel("环境变量来源名称", { exact: true }).fill("OWNER_A");
  await pickDirectoryAgent(page, 'runtime-agent-other', '执行');
  await page.getByText('启动参数与环境变量',{exact:true}).click();
  await expect(codex.getByLabel("启动参数（每行一个）", { exact: true })).toHaveValue("");
  await expect(codex.getByLabel("变量名称", { exact: true })).toHaveCount(0);
  await chooseOption(page, "默认执行端", "omp");
  const omp = page.getByRole("group", { name: "OMP 运行参数", exact: true });
  await omp.getByLabel("启动参数（每行一个）", { exact: true }).fill("--thinking\nlow");
  await omp.getByRole("button", { name: "添加环境变量引用", exact: true }).click();
  await omp.getByLabel("变量名称", { exact: true }).fill("MEMORY_OWNER");
  await omp.getByLabel("环境变量来源名称", { exact: true }).fill("OWNER_B");
  await pickDirectoryAgent(page, 'runtime-agent', '执行');
  await page.getByText('启动参数与环境变量',{exact:true}).click();
  await expect(codex.getByLabel("启动参数（每行一个）", { exact: true })).toHaveValue("--profile\npersonal-a");
  await expect(codex.getByLabel("环境变量来源名称", { exact: true })).toHaveValue("OWNER_A");
  await chooseOption(page, "默认执行端", "omp");
  await expect(omp.getByLabel("启动参数（每行一个）", { exact: true })).toHaveValue("");
  await chooseOption(page, "默认执行端", "codex");
  await waitForAutosave(page);
  const saved = (await (await request.get("/api/config")).json()).config;
  expect(saved.agents[0].runtime).toEqual({ codex: { args: ["--profile", "personal-a"], env: { MEMORY_OWNER: "${OWNER_A}" } } });
  expect(saved.agents[1].runtime).toEqual({ omp: { args: ["--thinking", "low"], env: { MEMORY_OWNER: "${OWNER_B}" } } });
  expect(saved.projects[0].runtime).toBeUndefined();
});

for (const english of [false,true]) test(`saves and revokes full file/network access for one Agent${english?' in narrow English':''}`,async({page,request})=>{
 await fixture(request);
 if(english){await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.setViewportSize({width:390,height:844});}
 await page.goto('/settings/runtime');await pickDirectoryAgent(page, 'runtime-agent', '执行');
 await page.getByText(english?'Arguments and environment variables':'启动参数与环境变量',{exact:true}).click();
 const control=page.getByLabel(english?'File and network access':'文件和网络权限',{exact:true});
 await expectSelection(control,'full');
 await expect(page.getByText(english?'Platform default: full access':'平台默认：完整访问',{exact:true})).toBeVisible();
 await chooseOption(page,control,'full');
 await waitForAutosave(page);
 await expect.poll(async()=>((await (await request.get('/api/config')).json()).config.agents[0].runtime?.codex?.fullAccess)).toBe(true);
 const saved=(await (await request.get('/api/config')).json()).config;
 expect(saved.agents[1].runtime).toBeUndefined();expect(saved.projects[0].runtime).toBeUndefined();
 await page.reload();await page.getByText(english?'Arguments and environment variables':'启动参数与环境变量',{exact:true}).click();
 await expectSelection(control,'full');
 await chooseOption(page,control,'native');
 await waitForAutosave(page);
 await expect.poll(async()=>((await (await request.get('/api/config')).json()).config.agents[0].runtime?.codex?.fullAccess)).toBe(false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
