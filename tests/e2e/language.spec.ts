import {waitForAutosave} from "./helpers/settings";
import { openArea } from "./helpers/navigation";
import { chooseOption } from "./helpers/select";
import { test, expect, type Page } from "@playwright/test";

async function changeLanguage(page: Page, language: "zh-CN" | "en") {
  await openArea(page, /^(设置|Settings)$/);
  await expect(page).toHaveURL(/\/settings\/general$/);
  await chooseOption(page, page.getByLabel("Language / 语言"), language);
  await openArea(page, /^(对话|Chats?)$/);
}

test.use({ locale: "en-US", storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ request }) => {
  const { revision, config } = await (await request.get("/api/config")).json();
  const saved = await request.put("/api/config", {
    data: {
      revision,
      config: {
        ...config,
        projects: [{ id: "personal", name: "个人阅读", cwd: "", agentIds: ["reader"], resources: [], mcp: [], skills: [] }],
        agents: [
          ...config.agents.filter((agent: {systemRole?: string}) => agent.systemRole),
          {
            id: "reader",
            name: "阅读助手",
            instructions: "Personal example only.",
            defaultCli: "codex",
            models: {},
            mcp: [],
            skills: [],
          },
        ],
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
});

test("defaults to English and keeps the selected language across reload without changing conversation content", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?project=personal&agent=reader");
  await expect(
    page.getByRole("button", { name: "Start chat", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const original = "中文资料\n\n```js\nconst count = 3;\n```";
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(original);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copy code", exact: true }),
  ).toHaveText("Copied");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("const count = 3;");
  const before = await (await request.get("/api/conversations")).json();
  await changeLanguage(page, "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("const count = 3;");
  await page.getByRole("button", { name: "复制代码", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制代码", exact: true })).toHaveText("已复制");
  await expect(page.locator(".message.user")).toContainText("中文资料");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "开始对话", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.user")).toContainText("中文资料");
  await expect(page.getByLabel("当前项目")).toHaveCount(0);
  await expect(page.locator(".topbar")).toContainText("个人阅读");
  expect(await (await request.get("/api/conversations")).json()).toEqual(
    before,
  );
  await changeLanguage(page, "en");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("tool-flow");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Ready");
  await expect(page.locator(".turn-process").last()).toContainText("3 operations");
  await page.getByRole("button", { name: "Expand this turn's activity", exact: true }).last().click();
  const command = page
    .locator(".operation-card")
    .filter({ hasText: "cat tags.txt" });
  await command.locator("summary").first().click();
  await expect(command).toContainText("Working directory");
  await expect(command).toContainText("Exit code 0");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("approval");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Awaiting approval");
  await expect(page.locator(".approval-card")).toContainText(
    "Codex requests permission to run a command",
  );
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Ready");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("hold");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Running");
  await page
    .getByRole("button", { name: "Stop execution", exact: true })
    .click();
  await expect(page.getByTestId("chat-status")).toHaveText("Interrupted");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("continue");
  await page
    .getByRole("button", { name: "Continue execution", exact: true })
    .click();
  await expect(page.getByTestId("chat-status")).toHaveText("Ready");
  await expect(
    page.getByText("Fixture reply: continue", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("preserves unknown native error text instead of treating it as a translation key", async ({
  page,
}) => {
  await page.route("**/api/models*", (route) =>
    route.fulfill({ status: 500, json: { error: "constructor" } }),
  );
  await page.goto("/?project=personal&agent=reader");
  await expect(page.getByRole("alert")).toContainText("constructor");
  await changeLanguage(page, "zh-CN");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("constructor");
});

test("closes mobile navigation after switching language and keeps the unsent draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=personal&agent=reader");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("未发送的草稿");
  await changeLanguage(page, "zh-CN");
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("未发送的草稿");
  await expect(page.locator(".sidebar").getByLabel("Language / 语言")).toHaveCount(0);
  await page.getByRole("button", { name: "会话列表", exact: true }).click();
  await page.getByRole("button", { name: "关闭会话列表", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "设置", exact: true })).toHaveCount(0);
  await changeLanguage(page, "en");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("未发送的草稿");
});

for (const [language, required, conflict] of [
  ["en", "Project name is required", "Configuration changed elsewhere"],
  ["zh-CN", "项目名称不能为空", "配置已被其他窗口或文件修改"],
] as const) test(`translates configuration conflicts in ${language} and preserves user entered values`, async ({
  page,
  request,
}) => {
  await page.addInitScript(language => localStorage.setItem("mana-language", language), language);
  await page.goto("/projects/personal/settings");
  const editName = async () => {
    await page.getByRole("button", { name: /^(对象操作|Object actions)$/, exact: true }).click();
    await page.getByRole("menuitem", { name: /^(编辑名称与外观|Edit name and appearance)$/, exact: true }).click();
  };
  const name = page.getByLabel(/^(名称|Name)$/, { exact: true });
  const close = page.getByRole("button", { name: /^(关闭|Close)$/, exact: true });
  await editName();
  await name.fill(" ");
  await close.click();
  await expect(page.getByRole("alert")).toContainText(required);
  const { config, revision } = await (await request.get("/api/config")).json();
  config.projects[0].name = "Changed outside the page";
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  await editName();
  await name.fill("My 阅读");
  await close.click();
  await expect(page.getByRole("alert")).toContainText(conflict);
  await expect(page.getByRole("button", { name: /^(用户菜单|User menu)$/, exact: true })).toBeDisabled();
  await editName();
  await expect(name).toHaveValue("My 阅读");
  expect((await (await request.get("/api/config")).json()).config.projects[0].name).toBe("Changed outside the page");
});

test("traps keyboard focus in dialogs and restores it on Escape", async ({
  page,
}) => {
  await page.goto("/?project=personal&agent=reader");
  const statusTrigger = page.getByRole("button", {
    name: /CLI status|执行端状态/,
    exact: true,
  });
  await statusTrigger.click();
  const status = page.getByRole("dialog", {
    name: /CLI status|执行端状态/,
  });
  await expect(
    status.getByRole("button", {
      name: /Close engine status|关闭执行端状态/,
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(status).toBeHidden();
  await expect(statusTrigger).toBeFocused();
});
