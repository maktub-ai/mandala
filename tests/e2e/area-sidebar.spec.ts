import { pickDirectoryAgent, openProjectOverview, openTeamDirectory } from './helpers/navigation';
import { test, expect } from "@playwright/test";
import { openArea, openProject } from "./helpers/navigation";

for (const width of [1280, 390]) {
  test(`each area keeps permanent conversations and local content controls and preserves chat drafts at ${width}px`, async ({ page, request }) => {
    const { revision } = await (await request.get("/api/config")).json();
    expect((await request.put("/api/config", { data: { revision, config: { version: 2,
      projects: ["one", "two"].map(id => ({ id, name: `Project ${id}`, cwd: "/tmp", agentIds: ["writer"], resources: [], mcp: [], skills: [] })),
      agents: ["writer", "reviewer"].map(id => ({ id, name: `Agent ${id}`, instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] })),
    } } })).ok()).toBe(true);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?project=one&agent=writer");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("Keep my draft");
    const sidebar = page.locator("aside.sidebar");
    const reveal = async () => {
      if (!await sidebar.isVisible()) await page.getByRole("button", { name: /^(打开侧栏|会话列表)$/, exact: true }).click();
    };
    await openArea(page, "MANA 工作区");
    await reveal();
    await expect(sidebar.locator("#navigation-chat").getByRole("searchbox", { name: "搜索对话" })).toHaveCount(1);
    await expect(sidebar.locator("#navigation-chat").getByRole("button", { name: "新对话", exact: true })).toHaveCount(1);
    if (width === 390) await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
    await openArea(page, "资料");
    await expect(page.getByRole("heading", { level: 1, name: "文件", exact: true })).toBeVisible();
    if (width === 390) await expect(sidebar).not.toBeVisible();
    await openArea(page, "项目");
    await openTeamDirectory(page);
    await page.locator(".directory-projects").getByRole("link", { name: "Project two", exact: true }).click();
    await expect(page.getByRole("heading", {level:1})).toHaveText("团队");
    await expect(page.locator(".object-detail-heading")).toContainText("Project two");
    if (width === 390) await expect(sidebar).not.toBeVisible();
    await openArea(page, "Agent");
    await pickDirectoryAgent(page, 'reviewer');
    await expect(page.getByRole("textbox", { name: "智能体 名称", exact: true })).toHaveValue("Agent reviewer");
    await openArea(page, "设置");
    await expect(page.locator("main .content-navigation")).toBeVisible();
    await page.locator("main .content-navigation").getByRole("link", { name: "执行端接入", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "执行端接入" })).toBeVisible();
    if (width === 390) {
      await expect(sidebar).not.toBeVisible();
      await reveal();
      await page.keyboard.press("Escape");
      await expect(sidebar).not.toBeVisible();
      await expect(page.getByRole("button", { name: "打开侧栏", exact: true })).toBeFocused();
    }
    await openArea(page, "团队");
    await openTeamDirectory(page);
    await page.getByRole("link", { name: "技能库", exact: true }).click();
    await expect(page).toHaveURL(/\/mana\/skills$/);
    await expect(page.getByRole("heading", { name: "技能库", exact: true })).toBeVisible();
    await openArea(page, "MANA 工作区");
    await expect(page.getByRole("heading", { level: 1, name: "记忆", exact: true })).toBeVisible();
    await openProject(page, "two");
    await openProjectOverview(page);
    await reveal();
    await expect(sidebar.locator("#navigation-chat").getByRole("searchbox", { name: "搜索对话" })).toHaveCount(1);
    if (width === 390) await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
    await page.locator("main").getByRole("navigation", { name: "项目导航", exact: true }).getByRole("link", { name: "概览", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/two\/workbench$/);
    await openArea(page, "对话");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("Keep my draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
