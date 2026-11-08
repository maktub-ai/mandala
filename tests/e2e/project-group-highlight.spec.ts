import { storedUiState } from './helpers/preferences';
import { expect, test } from "@playwright/test";
import { openSidebar } from "./helpers/navigation";
import { chooseOption } from "./helpers/select";

for (const locale of ["zh-CN", "en-US"]) for (const width of [1280, 390]) {
  test.describe(`${locale} ${width}`, () => {
    test.use({ locale, storageState: storedUiState(locale.startsWith("zh") ? "zh-CN" : "en"), viewport: { width, height: 850 } });
    test("chat selection does not highlight its project group", async ({ page, request }) => {
      const zh = locale === "zh-CN", suffix = `${locale}-${width}`;
      const projectId = `highlight-${suffix}`, agentId = `highlight-agent-${suffix}`;
      const { revision } = await (await request.get("/api/config")).json();
      expect((await request.put("/api/config", { data: { revision, config: {
        version: 2,
        projects: [{ id: projectId, name: "Synthetic project", cwd: "/tmp", agentIds: [agentId], resources: [], mcp: [], skills: [] }],
        agents: [{ id: agentId, name: "Synthetic Agent", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
      } } })).ok()).toBe(true);
      const chat = await (await request.post("/api/conversations", { data: { projectId, agentId, cli: "codex" } })).json();
      expect((await request.patch(`/api/conversations/${chat.id}`, { data: { title: "Synthetic conversation" } })).ok()).toBe(true);
      const before = await (await request.get(`/api/conversations/${chat.id}`)).json();
      await page.goto(`/?project=${projectId}&conversation=${chat.id}`);
      await openSidebar(page);
      await chooseOption(page, zh ? "会话视图" : "Chat view", "projects");
      const group = page.getByRole("region", { name: "Synthetic project", exact: true });
      const heading = group.locator(".library-group-heading");
      const row = group.getByRole("button", { name: "Synthetic conversation", exact: true });
      const countColor = await heading.locator("span:last-child").evaluate(element => getComputedStyle(element).color);
      await expect(heading.locator("strong")).toHaveCSS("color", countColor);
      await expect(row).toHaveAttribute("aria-current", "page");
      await heading.click();
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await expect(row).toHaveCount(0);
      await heading.click();
      await expect(row).toHaveAttribute("aria-current", "page");
      await page.reload();
      await openSidebar(page);
      await expect(heading.locator("strong")).toHaveCSS("color", countColor);
      await expect(row).toHaveAttribute("aria-current", "page");
      expect(await (await request.get(`/api/conversations/${chat.id}`)).json()).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}
