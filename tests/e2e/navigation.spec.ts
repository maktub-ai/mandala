import { storedUiState } from './helpers/preferences';
import { openProjectOverview } from './helpers/navigation';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArea, openProject } from "./helpers/navigation";
import { chooseOption, expectSelection } from "./helpers/select";
import { test, expect } from "@playwright/test";

for (const locale of ["zh-CN", "en-US"]) {
  for (const width of [1280, 390]) {
    test.describe(`${locale} at ${width}px`, () => {
      test.use({ locale, storageState: storedUiState(locale.startsWith("zh") ? "zh-CN" : "en"), viewport: { width, height: 850 } });
      test("browses projects and starts a chat without changing the running conversation", async ({ page, request }) => {
        const labels = locale === "zh-CN"
          ? { project: "当前项目", agent: "当前 智能体", cli: "当前 CLI", workbench: "项目",
              start: "开始对话", message: "消息", send: "发送消息", stop: "停止执行", menu: "会话列表", search: "搜索对话", running: "执行中" }
          : { project: "Current project", agent: "Current agent", cli: "Current CLI", workbench: "Project",
              start: "Start chat", message: "Message", send: "Send message", stop: "Stop execution", menu: "Chat list", search: "Search chats", running: "Running" };
        const suffix = `${locale}-${width}`;
        const root = mkdtempSync(join(tmpdir(), "openmana-navigation-"));
        for (const directory of ["a", "b"]) mkdirSync(join(root, directory));
        const projectA = `navigation-a-${suffix}`, projectB = `navigation-b-${suffix}`;
        const sourceTitle = `Navigation A ${suffix}`, reply = `Navigation B ${suffix}`;
        const { revision } = await (await request.get("/api/config")).json();
        const config = {
          version: 2,
          projects: [projectA, projectB].map((id, index) => ({
            id, name: `Project ${index ? "B" : "A"}`, cwd: join(root, index ? "b" : "a"), agentIds: ["shared"],
            resources: [], mcp: [], skills: [],
          })),
          agents: [{ id: "shared", name: "Shared worker", instructions: "Synthetic navigation only.",
            defaultCli: "codex", models: {}, mcp: [], skills: [] }],
        };
        expect((await request.put("/api/config", { data: { revision, config } })).ok()).toBe(true);
        const source = await (await request.post("/api/conversations", {
          data: { projectId: projectA, agentId: "shared", model: "model-fixture", cli: "codex" },
        })).json();
        await request.post(`/api/conversations/${source.id}/messages`, { data: { text: "hold" } });
        await request.patch(`/api/conversations/${source.id}`, { data: { title: sourceTitle } });
        await expect.poll(async () => (await (await request.get(`/api/conversations/${source.id}`)).json()).conversation.status)
          .toBe("running");
        const conversations = async () => (await (await request.get("/api/conversations")).json()) as { id: string; projectId: string; agentId: string; cli: string }[];
        const before = await conversations();
        const expectNoCreatedChat = async () => expect((await conversations()).map((chat) => chat.id)).toEqual(before.map((chat) => chat.id));
        try {
          await page.goto(`/?project=${projectA}&conversation=${source.id}`);
          await expect(page.getByTestId("chat-status")).toHaveText(labels.running);
          await expect(page.getByText("Fixture reply: hold", { exact: true })).toBeVisible();
          const original = (await (await request.get(`/api/conversations/${source.id}`)).json()).conversation;
          if (width === 390) await page.getByRole("button", { name: labels.menu, exact: true }).click();
          await page.locator(".chat-link").filter({ hasText: sourceTitle }).click();
          await expect(page.getByText("Fixture reply: hold", { exact: true })).toBeVisible();
          await expect(page.getByTestId("chat-status")).toHaveText(labels.running);
          await expect(page.getByRole("button", { name: labels.stop, exact: true })).toBeEnabled();
          await expect(page.getByRole("combobox", { name: labels.project, exact: true })).toHaveCount(0);
          await expect(page.locator(".topbar")).toContainText("Project A");
          await openProject(page, projectB);
          await expect(page.getByRole("heading",{level:1})).toHaveText(locale === "zh-CN" ? "团队" : "Team");
          await expect(page.locator(".object-detail-heading h2")).toHaveText("Project B");
          await expectNoCreatedChat();
          await openProjectOverview(page);
          await expect(page).toHaveURL(new RegExp(`/projects/${projectB}/workbench$`));
          await expect(page.getByRole("heading", { name: locale === "zh-CN" ? "项目" : "Project", level: 1, exact: true })).toBeVisible();
          await expect(page.locator("main .project-context")).toHaveText("Project B");
          await expect(page.locator("main .project-context")).not.toHaveText("Project A");
          await expect(page.getByRole("dialog", { name: labels.workbench, exact: true })).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.reload();
          await expectSelection(page.getByRole("combobox", { name: labels.project, exact: true }), projectB);
          await expect(page.locator("main .project-context")).toHaveText("Project B");
          await expect(page.getByRole("heading", { name: locale === "zh-CN" ? "项目" : "Project", level: 1, exact: true })).toBeVisible();
          await expectNoCreatedChat();
          await page.locator(".workbench-agent-card").filter({ hasText: "Shared worker" })
            .getByRole("button", { name: labels.start, exact: true }).click();
          await expect(page).toHaveURL(new RegExp(`\\?project=${projectB}&agent=shared$`));
          await expectSelection(page.getByRole("combobox", { name: labels.agent, exact: true }), "shared");
          await expectSelection(page.getByRole("combobox", { name: labels.cli, exact: true }), "codex");
          await page.goBack();
          await expect(page).toHaveURL(new RegExp(`/projects/${projectB}/workbench$`));
          await expect(page.getByRole("heading", { name: locale === "zh-CN" ? "项目" : "Project", level: 1, exact: true })).toBeVisible();
          await expect(page.locator("main .project-context")).toHaveText("Project B");
          await page.goForward();
          await expectSelection(page.getByRole("combobox", { name: labels.project, exact: true }), projectB);
          await expectSelection(page.getByRole("combobox", { name: labels.agent, exact: true }), "shared");
          await page.getByRole("textbox", { name: labels.message, exact: true }).fill(reply);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await expectNoCreatedChat();
          expect((await (await request.get(`/api/conversations/${source.id}`)).json()).conversation).toEqual(original);
          await page.getByRole("button", { name: labels.send, exact: true }).click();
          await expect(page.getByText(`Fixture reply: ${reply}`, { exact: true })).toBeVisible();
          const created = (await conversations()).filter((chat) => !before.some((previous) => previous.id === chat.id));
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({ projectId: projectB, agentId: "shared", cli: "codex" });
          if (width === 390) await page.getByRole("button", { name: labels.menu, exact: true }).click();
          await expect(page.locator(".chat-link").filter({ hasText: sourceTitle })).toHaveCount(1);
          await page.getByLabel(labels.search, { exact: true }).fill(sourceTitle);
          await page.locator(".chat-link").filter({ hasText: sourceTitle }).click();
          await expect(page).toHaveURL(new RegExp(`conversation=${source.id}(?:&|$)`));
          await expect(page.getByRole("combobox", { name: labels.project, exact: true })).toHaveCount(0);
          await expect(page.locator(".topbar")).toContainText("Project A");
          await expect(page.getByRole("combobox", { name: labels.agent, exact: true })).toHaveCount(0);
          await expect(page.locator(".topbar")).toContainText("Shared worker");
          await expect(page.locator(".topbar")).toContainText("Codex");
          await expect(page.getByTestId("chat-status")).toHaveText(labels.running);
          await expect(page.getByText("Fixture reply: hold", { exact: true })).toBeVisible();
          await expect(page.getByText(`Fixture reply: ${reply}`, { exact: true })).toHaveCount(0);
          await page.reload();
          await expect(page.getByRole("combobox", { name: labels.project, exact: true })).toHaveCount(0);
          await expect(page.locator(".topbar")).toContainText("Project A");
          await expect(page.getByTestId("chat-status")).toHaveText(labels.running);
          expect((await (await request.get(`/api/conversations/${source.id}`)).json()).conversation).toEqual(original);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } finally {
          await request.post(`/api/conversations/${source.id}/stop`);
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  }
}
