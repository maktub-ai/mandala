import { chooseOption } from "./helpers/select";
import { test, expect, type Page } from "@playwright/test";

const config = { version: 2,
  projects: [{ id: "effective-project", name: "Reading project", cwd: "/tmp", agentIds: ["effective-agent"], resources: [], mcp: [], skills: [] }],
  agents: [{ id: "effective-agent", name: "Reader", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] }] };
const effective = {
  mcp: [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `native-${String(i).padStart(2, "0")}`,
      source: "native", scope: "codex", overridden: [], status: "available",
      definition: { path: `/tmp/native/long-private-directory/skills/native-${i}/SKILL.md` } })),
    { name: "project-failure", source: "project", scope: "Reading project", overridden: ["agent", "native"], status: "error" },
    { name: "agent-pending", source: "agent", scope: "Reader", overridden: [], status: "pending" },
    { name: "system-loaded", source: "system", scope: "OpenMana", overridden: [], status: "effective" },
  ],
  skills: [
    { name: "project-restart", source: "project", scope: "Reading project", overridden: [], status: "restart" },
    { name: "native-unverified", source: "native", scope: "codex", overridden: [], status: "unverified" },
  ],
  resources: [
    { id: "local", label: "Reading notes", kind: "local", location: "/tmp/notes", access: "passed-to-cli" },
    { id: "remote", label: "Remote reading list", kind: "remote-git", location: "https://example.test/readings.git", access: "not-checked-out" },
  ],
};

async function openPanel(page: Page, language = "zh-CN", payload = effective) {
  await page.addInitScript((value) => localStorage.setItem("mana-language", value), language);
  await page.route("**/api/config", (route) => route.fulfill({ json: { config, revision: "synthetic" } }));
  await page.route("**/api/conversations", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/tasks", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/models?*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/cli/status?*", (route) => route.fulfill({ json: { status: "ready", version: "synthetic" } }));
  await page.route("**/api/effective?*", (route) => route.fulfill({ json: payload }));
  await page.goto("/?project=effective-project&agent=effective-agent");
  await page.getByRole("button", { name: language === "en" ? "Context and capabilities" : "上下文与能力", exact: true }).click();
  return page.getByRole((page.viewportSize()?.width??1280)<=1100?"dialog":"region", { name: language === "en" ? "Context and capabilities" : "上下文与能力", exact: true });
}

test("counts observed states and prioritizes failures in a collapsible long inventory", async ({ page }) => {
  const dialog = await openPanel(page);
  const summary = dialog.getByRole("region", { name: "配置状态摘要" });
  for (const [label, count] of [["已发现", 12], ["已验证加载", 1], ["待应用 / 需重启", 2], ["加载失败", 1], ["未验证", 1]] as const)
    await expect(summary.getByText(label, { exact: true }).locator("..")).toContainText(String(count));
  const mcp = dialog.getByRole("region", { name: "MCP", exact: true });
  await expect(mcp.getByRole("listitem")).toHaveCount(6);
  await expect(mcp.getByRole("listitem").first()).toContainText("project-failure");
  await expect(mcp).toContainText("覆盖: 智能体 层, CLI 原生");
  await mcp.getByRole("button", { name: "展开全部", exact: true }).click();
  await expect(mcp.getByRole("listitem")).toHaveCount(15);
  await mcp.getByRole("button", { name: "收起清单", exact: true }).click();
  await expect(mcp.getByRole("listitem")).toHaveCount(6);
  await expect(dialog).toContainText("保存不等于生效");
  await expect(dialog).toContainText("已传给 CLI，访问未验证");
  await expect(dialog).toContainText("尚无工作副本");
});

test("combines capability name, source and attention filters without changing the summary", async ({ page }) => {
  const dialog = await openPanel(page);
  await chooseOption(page, dialog.getByRole("combobox", { name: "来源筛选" }), "project");
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await dialog.getByRole("searchbox", { name: "能力名称搜索" }).fill(" PROJECT-FAIL ");
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByRole("listitem")).toContainText("project-failure");
  await dialog.getByRole("searchbox", { name: "能力名称搜索" }).fill("missing-capability");
  await expect(dialog.getByRole("listitem")).toHaveCount(0);
  await expect(dialog).toContainText("没有匹配的能力。");
  await dialog.getByRole("searchbox", { name: "能力名称搜索" }).fill("");
  await chooseOption(page, dialog.getByRole("combobox", { name: "来源筛选" }), "all");
  await chooseOption(page, dialog.getByRole("combobox", { name: "状态筛选" }), "attention");
  await expect(dialog.getByRole("listitem")).toHaveCount(3);
  await expect(dialog.getByRole("region", { name: "配置状态摘要" }).getByText("已发现", { exact: true }).locator("..")).toContainText("12");
  await chooseOption(page, dialog.getByRole("combobox", { name: "状态筛选" }), "unverified");
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByRole("listitem")).toContainText("native-unverified");
});

for (const language of ["zh-CN", "en"]) {
  test(`supports long capability names and filters at 390px in ${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const payload = { ...effective, mcp: effective.mcp.map((item) => item.name === "project-failure"
      ? { ...item, name: "project-failure-with-a-very-long-unbroken-capability-name-that-must-wrap-within-the-dialog" } : item) };
    const dialog = await openPanel(page, language, payload);
    const search = dialog.getByRole("searchbox", { name: language === "en" ? "Search capability names" : "能力名称搜索" });
    await search.fill("project-failure");
    await expect(dialog.getByRole("listitem")).toHaveCount(1);
    await expect(dialog.getByRole("listitem")).toBeVisible();
    if (language === "en") await expect(dialog).not.toContainText("配置状态摘要");
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("distinguishes an empty inventory from no filter matches", async ({ page }) => {
  const dialog = await openPanel(page, "zh-CN", { mcp: [], skills: [], resources: [] });
  await expect(dialog.getByRole("region", { name: "MCP", exact: true })).toContainText("未发现能力");
  await expect(dialog.getByRole("region", { name: "Skills", exact: true })).toContainText("未发现能力");
  await expect(dialog.getByRole("heading",{name:"关联资源",exact:true})).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "展开全部" })).toHaveCount(0);
});

test("does not label an old Agent inventory as the newly selected Agent while loading", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const next = { ...config.agents[0], id: "next-agent", name: "Second reader" };
  await page.route("**/api/config", route => route.fulfill({ json: { revision: "synthetic", config: { ...config,
    projects: [{ ...config.projects[0], agentIds: [config.agents[0].id, next.id] }], agents: [...config.agents, next] } } }));
  await page.route("**/api/conversations", route => route.fulfill({ json: [] }));
  await page.route("**/api/tasks", route => route.fulfill({ json: [] }));
  await page.route("**/api/models?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/cli/status?*", route => route.fulfill({ json: { status: "ready", version: "synthetic" } }));
  await page.route("**/api/effective?*", async route => {
    if (new URL(route.request().url()).searchParams.get("agentId") === next.id) {
      await held;
      await route.fulfill({ json: { mcp: [{ name: "second-agent-only", source: "agent", scope: next.name,
        status: "pending", overridden: [] }], skills: [], resources: [] } });
    } else await route.fulfill({ json: effective });
  });
  await page.goto("/?project=effective-project&agent=effective-agent");
  await page.getByRole("button", { name: "上下文与能力", exact: true }).click();
  const panel = page.getByRole("region", { name: "上下文与能力", exact: true });
  await expect(panel).toContainText("project-failure");
  try {
    await chooseOption(page, "当前 智能体", next.id);
    await expect(panel).toContainText(next.name);
    await expect(panel).not.toContainText("project-failure");
  } finally { release(); }
  await expect(panel).toContainText("second-agent-only");
});
