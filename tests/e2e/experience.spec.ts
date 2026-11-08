import {openProjectBackground} from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { pickDirectoryAgent, openConfigSection } from "./helpers/navigation";
import { openArea } from "./helpers/navigation";
import { chooseOption } from "./helpers/select";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", {
    data: {
      revision,
      config: {
        version: 1,
        projects: [{ id: "personal", name: "个人阅读", cwd: "" }],
        agents: [
          {
            id: "reader",
            name: "阅读助手",
            instructions: "Personal example only.",
            defaultCli: "codex",
            models: {},
          },
        ],
      },
    },
  });
});

test("formats replies, copies code, renames and searches persisted history", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?project=personal&agent=reader");
  const message =
    "整理阅读资料\n\n## 阅读计划\n\n- 整理标签\n- 按主题筛选\n\n```js\nconst count = 3;\n```\n\n| 阶段 | 状态 |\n| --- | --- |\n| 整理 | 完成 |\n\n[来源](https://example.com/)\n\n<script>window.injection = true</script>\n\n[危险链接](javascript:alert(1))";
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(message);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page.getByRole("heading", { name: "阅读计划", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "完成", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.text script")).toHaveCount(0);
  await expect(page.locator(".message.text").getByText("危险链接", { exact: true })).toBeVisible();
  await expect(page.locator(".message.text").getByRole("link", { name: "危险链接", exact: true })).toHaveCount(0);
  await expect(page.locator('.message.text a[href^="javascript:" i]')).toHaveCount(0);
  await expect(
    page.locator(".message.text").getByRole("link", { name: "来源", exact: true }),
  ).toHaveAttribute("rel", /noopener/);
  await page.getByRole("button", { name: "复制代码", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("const count = 3;");
  await page.getByRole("button", { name: "重命名对话" }).click();
  await page.getByRole("textbox", { name: "对话标题" }).fill("本周阅读计划");
  await page.getByRole("button", { name: "保存标题" }).click();
  await page.reload();
  await expect(page.locator(".chat-link.active")).toContainText("本周阅读计划");
  await expect(
    page.getByRole("heading", { name: "阅读计划", exact: true }),
  ).toBeVisible();
  await page.getByLabel("搜索对话", { exact: true }).fill("不存在的会话");
  await expect(page.locator(".chat-link")).toHaveCount(0);
  await page.getByLabel("搜索对话", { exact: true }).fill("本周");
  await expect(page.locator(".chat-link")).toHaveCount(1);
  await page.getByLabel("搜索对话", { exact: true }).fill("阅读助手");
  await expect(page.locator(".chat-link.active")).toContainText("本周阅读计划");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("validates names, retains the current model and applies Agent defaults on reselection", async ({
  page, request,
}) => {
  await page.goto("/?project=personal&agent=reader");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("Fixture");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("默认模型前的对话");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await openArea(page, "设置");
  await openConfigSection(page, "projects");
  await openProjectBackground(page);
  await page.getByLabel("项目名称").fill(" ");
  await expect(page.getByRole("alert")).toContainText("项目名称不能为空");
  await page.getByLabel("项目名称").fill("个人阅读");
  await pickDirectoryAgent(page, 'reader');
  await page.getByRole("tab", { name: "执行", exact: true }).click();
  await chooseOption(page, "Codex 默认模型", "model-second");
  await expect(page.getByLabel("Codex 默认模型")).toHaveAttribute('data-value',"model-second");
  await waitForAutosave(page);
  await openArea(page, "对话");
  const previousId = new URL(page.url()).searchParams.get("conversation");
  expect((await (await request.get(`/api/conversations/${previousId}`)).json()).conversation.model).toBe("model-fixture");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("Fixture");
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await expect(page.getByLabel("模型", { exact: true })).toContainText("Fixture");
  await chooseOption(page, "当前 智能体", "");
  await chooseOption(page, "当前 智能体", "reader");
  await expect(page.getByLabel("模型", { exact: true })).toContainText(
    "Second fixture",
  );
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("使用默认模型的新对话");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const currentId = new URL(page.url()).searchParams.get("conversation");
  expect(currentId).not.toBe(previousId);
  expect((await (await request.get(`/api/conversations/${currentId}`)).json()).conversation.model).toBe("model-second");
  expect((await (await request.get(`/api/conversations/${previousId}`)).json()).conversation.model).toBe("model-fixture");
});

test("keeps the reading position while new reply chunks arrive", async ({
  page,
}) => {
  await page.goto("/?project=personal&agent=reader");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("stream-reading");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".message.text")).toContainText("阅读资料 40");
  await page.locator(".conversation").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".message.text")).toContainText("更新 5");
  expect(
    await page
      .locator(".conversation")
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await page.getByRole("button", { name: "回到最新消息" }).click();
  await expect
    .poll(() =>
      page
        .locator(".conversation")
        .evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
    )
    .toBeLessThan(80);
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
});

test("a delayed rename cannot replace the newly selected conversation", async ({
  page,
}) => {
  await page.goto("/?project=personal&agent=reader");
  for (const text of ["第一份阅读资料", "第二份阅读资料"]) {
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/conversations/*", async (route) => {
    if (route.request().method() === "PATCH") await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "重命名对话" }).click();
  await page.getByRole("textbox", { name: "对话标题" }).fill("第二份资料整理");
  const submitted = page.waitForRequest((r) => r.method() === "PATCH");
  await page.getByRole("button", { name: "保存标题" }).click();
  await submitted;
  await page
    .locator(".chat-link")
    .filter({ hasText: "第一份阅读资料" })
    .click();
  await expect(page.locator(".chat-title-bar")).toContainText("第一份阅读资料");
  const response = page.waitForResponse(
    (r) => r.request().method() === "PATCH",
  );
  release();
  await response;
  await expect(
    page.locator(".chat-link").filter({ hasText: "第二份资料整理" }),
  ).toHaveCount(1);
  await expect(page.locator(".chat-title-bar")).toContainText("第一份阅读资料");
});

test("configuration remains editable and navigation stays available during an automatic save", async ({page}) => {
  await page.goto("/?project=personal&agent=reader");await openArea(page,"设置");await openConfigSection(page,"projects");await openProjectBackground(page);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  await page.route("**/api/config",async route=>{if(route.request().method()==="PUT"){entered();await gate;}await route.continue();});
  const name=page.getByLabel("项目名称",{exact:true});await name.fill("Editable while saving");await started;
  try{await expect(name).toBeEnabled();await expect(page.getByRole("button",{name:"开始对话",exact:true})).toBeEnabled();}finally{release();}
  await waitForAutosave(page);
});
