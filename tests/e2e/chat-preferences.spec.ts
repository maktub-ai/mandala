import {enterModelId} from './helpers/select';
import {waitForAutosave} from './helpers/settings';
import { test, expect } from "./helpers/execution-fixture";
import { chooseOption } from "./helpers/select";
import { openArea, openSidebar } from "./helpers/navigation";

test.beforeEach(async ({ request, executionDirectory }) => {
  const { config, revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: {
    ...config, version: 2, runtimes: ["codex", "omp"],
    projects: [{ id: "personal", name: "Personal project", cwd: executionDirectory, resources: [], agentIds: ["writer", "reviewer"], mcp: [], skills: [] }],
    agents: [
      config.agents.find((agent: { id: string }) => agent.id === config.mandala.agentId),
      { id: "writer", name: "Writer", instructions: "Synthetic writer.", defaultCli: "omp", models: { codex: "model-fixture" }, mcp: [], skills: [] },
      { id: "reviewer", name: "Reviewer", instructions: "Synthetic reviewer.", defaultCli: "codex", models: { codex: "model-fixture" }, mcp: [], skills: [] },
    ],
  } } })).ok()).toBe(true);
});

for (const cli of ["codex", "omp"]) test(`${cli} new chats retain the current project, Agent and execution choices across reload`, async ({ page, request }) => {
  if (cli === "omp") {
    // This frontend regression uses a synthetic catalog, without starting a real OMP turn.
    await page.route("**/api/models?**", route => new URL(route.request().url()).searchParams.get("cli") === "omp" ? route.fulfill({ json: [
      { id: "model-second", label: "Second fixture", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "high"] },
    ] }) : route.continue());
    await page.route("**/api/conversations/*/queue", route => route.request().method() === "POST" ? route.fulfill({ json: {} }) : route.continue());
    const seeded = await (await request.post("/api/conversations", { data: { projectId: "personal", agentId: "writer", cli, model: "model-second", effort: "high" } })).json();
    await page.goto(`/?project=personal&conversation=${seeded.id}`);
    await expect(page.getByRole("combobox", { name: "思考强度", exact: true })).toHaveAttribute("data-value", "high");
  } else {
    await page.goto("/?project=personal&agent=writer");
    await chooseOption(page, "当前 CLI", cli);
    await chooseOption(page, "模型", "model-second");
    await chooseOption(page, "思考强度", "high");
    await page.getByLabel("消息", { exact: true }).fill("First personal task");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("Fixture reply: First personal task", { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.reload();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await openSidebar(page);
  await page.locator(".new-chat").click();
  for (const [name, value] of [["当前项目", "personal"], ["当前 智能体", "writer"], ["当前 CLI", cli], ["模型", "model-second"], ["思考强度", "high"]]) {
    await expect(page.getByRole("combobox", { name, exact: true })).toHaveAttribute("data-value", value);
  }
  await page.reload();
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveAttribute("data-value", "model-second");
  await expect(page.getByRole("combobox", { name: "思考强度", exact: true })).toHaveAttribute("data-value", "high");
  await page.getByLabel("消息", { exact: true }).fill("Next personal task");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  if (cli === "codex") await expect(page.getByText("Fixture reply: Next personal task", { exact: true })).toBeVisible();
  else await expect(page).toHaveURL(/conversation=/);
  const id = new URL(page.url()).searchParams.get("conversation");
  expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation)
    .toMatchObject({ projectId: "personal", agentId: "writer", cli, model: "model-second", effort: "high" });
  await openSidebar(page);
  await page.locator(".new-chat").click();
  await chooseOption(page, "当前 智能体", "reviewer");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("Fixture");
  await expect(page.getByRole("combobox", { name: "思考强度", exact: true })).toHaveAttribute("data-value", "medium");
});

test("Agent defaults are configured from Agent management rather than the composer", async ({ page, request }) => {
  await page.goto("/?project=personal&agent=reviewer");
  await expect(page.getByRole("combobox", { name: "当前 智能体", exact: true })).toContainText("Reviewer");
  await expect(page.getByRole("button", { name: "智能体 默认模型", exact: true })).toHaveCount(0);
  await openArea(page, "Agent");
  await page.locator('.workspace-directory-row[href="/agents/reviewer"]').click();
  await page.getByRole("tab", { name: /^(设置|Settings)$/, exact: true }).click();
  await page.locator(".object-row").filter({hasText:/执行配置|Execution configuration/}).getByRole("button",{name:/配置|Configure/}).click();
  await expect(page).toHaveURL(/\/agents\/reviewer\?tab=execution$/);
  await expect(page.getByRole("tab", { name: "设置", exact: true })).toHaveAttribute("aria-selected", "true");
  await enterModelId(page,page.getByLabel("Codex 默认模型", { exact: true }),"model-second");
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.agents.find((a: any) => a.id === "reviewer").models.codex).toBe("model-second");
  await page.reload();
  await expect(page.getByLabel("Codex 默认模型", { exact: true })).toHaveAttribute('data-value',"model-second");
});

test("explicit empty context overrides remembered choices", async ({ page }) => {
  await page.goto("/?project=personal&agent=reviewer");
  await chooseOption(page, "模型", "model-second");
  await chooseOption(page, "思考强度", "high");
  await page.goto("/?project=&agent=");
  await expect(page.getByRole("combobox", { name: "当前项目", exact: true })).toHaveAttribute("data-value", "");
  await expect(page.getByRole("combobox", { name: "当前 智能体", exact: true })).toHaveAttribute("data-value", "");
  await expect(page.getByRole("button", { name: "智能体 默认模型", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "思考强度", exact: true })).toHaveAttribute("data-value", "medium");
});

test("Agent default model settings are visible in narrow English", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
  await page.goto("/?project=personal&agent=reviewer");
  await expect(page.getByRole("combobox", { name: "Current agent", exact: true })).toContainText("Reviewer");
  await expect(page.getByRole("button", { name: "Agent default model", exact: true })).toHaveCount(0);
  await openArea(page, "Agent");
  await page.locator('.workspace-directory-row[href="/agents/reviewer"]').click();
  await page.getByRole("tab", { name: /^(设置|Settings)$/, exact: true }).click();
  await page.locator(".object-row").filter({hasText:/执行配置|Execution configuration/}).getByRole("button",{name:/配置|Configure/}).click();
  await expect(page.getByLabel("Codex default model", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("an untouched draft follows the Agent default after refresh and saving settings", async ({ page, request }) => {
  await page.goto("/?project=personal&agent=reviewer");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("Fixture");
  await page.reload();
  await openArea(page, "Agent");
  await page.locator('.workspace-directory-row[href="/agents/reviewer"]').click();
  await page.getByRole("tab", { name: /^(设置|Settings)$/, exact: true }).click();
  await page.locator(".object-row").filter({hasText:/执行配置|Execution configuration/}).getByRole("button",{name:/配置|Configure/}).click();
  await enterModelId(page,page.getByLabel("Codex 默认模型", { exact: true }),"model-second");
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.agents.find((a: any) => a.id === "reviewer").models.codex).toBe("model-second");
  await openArea(page, "对话");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("Second fixture");
  await page.getByLabel("消息", { exact: true }).fill("Use the new Agent default");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("Fixture reply: Use the new Agent default", { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get("conversation");
  expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation.model).toBe("model-second");
});

test("a model catalog failure does not erase remembered reasoning effort", async ({ page }) => {
  await page.goto("/?project=personal&agent=reviewer");
  await chooseOption(page, "模型", "model-second");
  await chooseOption(page, "思考强度", "high");
  await page.route("**/api/models?**", route => route.abort());
  await page.reload();
  await expect(page.getByRole("button", { name: "关闭错误", exact: true })).toBeVisible();
  await page.unroute("**/api/models?**");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "思考强度", exact: true })).toHaveAttribute("data-value", "high");
});


test('new chat retains execution choices while conversation details are delayed', async ({page,request}) => {
 const seeded=await (await request.post('/api/conversations',{data:{projectId:'personal',agentId:'writer',cli:'codex',model:'model-second',effort:'high'}})).json();
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/conversations/'+seeded.id,async route=>{await held;await route.continue();});
 try {
  await page.goto('/?project=personal&conversation='+seeded.id);
  await expect(page.getByRole('button',{name:'展开右侧栏',exact:true})).toBeVisible();
  await openSidebar(page);await page.locator('.new-chat').click();
  await expect(page.getByRole('combobox',{name:'模型',exact:true})).toHaveAttribute('data-value','model-second');
  await expect(page.getByRole('combobox',{name:'思考强度',exact:true})).toHaveAttribute('data-value','high');
 } finally {release();}
});
