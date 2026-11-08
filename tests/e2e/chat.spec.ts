import {chooseOption} from './helpers/select';
import {openProjectBackground, editAgentProfile} from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { openConfigSection } from "./helpers/navigation";
import { openArea } from "./helpers/navigation";
import { test, expect } from "@playwright/test";
test("saves config, chats, approves, stops, continues, reloads and changes theme", async ({
  page,
  request,
}) => {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", {
    data: { revision, config: { version: 2, projects: [], agents: [] } },
  })).ok()).toBe(true);
  await page.goto("/?project=&agent=");
  await openArea(page, "设置");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await openConfigSection(page, "projects");
  await page.getByRole("button", { name: "添加项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("Reading list");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await openConfigSection(page, "agents");
  await page.getByRole("button", { name: "添加智能体", exact: true }).click();
  await page.getByLabel("智能体 名称").fill("Developer");
  await chooseOption(page,'执行端','codex');await page.getByRole('button',{name:'创建智能体',exact:true}).click();await editAgentProfile(page);
  await page.getByLabel("职责与指令").fill("Build a personal reading list.");
  await openConfigSection(page, "projects");
  await openProjectBackground(page);
  await page.getByRole("tab", { name: "参与者", exact: true }).click();
  await page.getByRole("checkbox", { name: "Developer", exact: true }).check();
  await waitForAutosave(page);
  await openArea(page, "对话");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("hello");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page.getByText("Fixture reply: hello", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("approval");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("button", { name: "允许本次" })).toBeVisible();
  await page.getByRole("button", { name: "允许本次" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByRole("button", { name: "停止执行" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("已中断");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("continue");
  await page.getByRole("button", { name: "继续执行" }).click();
  await expect(
    page.getByText("Fixture reply: continue", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Fixture reply: hello", { exact: true }),
  ).toBeVisible();
  await openArea(page, "设置");
  await page.getByRole("group", { name: "显示模式", exact: true }).getByRole("button", { name: "浅色", exact: true }).click();

  await openArea(page, "对话");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: "/tmp/compact-chat-light.png",
  });
  await openArea(page, "设置");
  await page.getByRole("group", { name: "显示模式", exact: true }).getByRole("button", { name: "深色", exact: true }).click();

  await openArea(page, "对话");
  await page.screenshot({
    path: "/tmp/compact-chat-dark.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/compact-chat-mobile.png",
  });
});
