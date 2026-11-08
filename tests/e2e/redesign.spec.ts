import { openArea, openNavigation, conversationMenu } from "./helpers/navigation";
import { chooseOption } from "./helpers/select";
import { test, expect } from "./helpers/execution-fixture";

async function fixture(request: import("@playwright/test").APIRequestContext, executionDirectory: string) {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2,
    projects: [{ id: "redesign", name: "Synthetic redesign project", cwd: executionDirectory, agentIds: ["writer", "reviewer"], resources: [], mcp: [], skills: [] }],
    agents: ["writer", "reviewer"].map(id => ({ id, name: `Synthetic ${id}`, instructions: "Personal synthetic fixture.", defaultCli: "codex", models: {}, mcp: [], skills: [] })),
  } } })).ok()).toBe(true);
}

for (const width of [1280, 390]) {
  test(`global navigation preserves the selected chat and unsent draft at ${width}px`, async ({ page, request, executionDirectory }) => {
    await fixture(request, executionDirectory);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?project=redesign&agent=writer");
    await page.getByLabel("消息", { exact: true }).fill("Original selected conversation");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("Fixture reply: Original selected conversation", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
    const sourceId = new URL(page.url()).searchParams.get("conversation")!;
    await page.getByLabel("消息", { exact: true }).fill("Keep this unsubmitted next step");
    await expect(page.locator(".global-navigation")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "设置", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "生成标题", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "提炼记忆", exact: true })).toHaveCount(0);
    for (const name of ["项目", "MANA 工作区", "设置"]) {
      await openArea(page, name);
      const menu = await openNavigation(page);
      await expect(menu).toHaveAttribute("data-active-area", name === "项目" ? "agents" : name === "设置" ? "settings" : "mana");
      await page.keyboard.press("Escape");
      await expect(page.locator("main")).toHaveCount(1);
      await openArea(page, "对话");
      await expect(page.getByLabel("消息", { exact: true })).toHaveValue("Keep this unsubmitted next step");
      expect(new URL(page.url()).searchParams.get("conversation")).toBe(sourceId);
      await expect(page.getByText("Fixture reply: Original selected conversation", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await openArea(page, "项目");
    await page.goBack();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("Keep this unsubmitted next step");
    expect(new URL(page.url()).searchParams.get("conversation")).toBe(sourceId);
  });
}

test("delegation is exposed to Agents without a human dispatch form", async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  await page.goto("/?project=redesign&agent=writer");
  await page.getByLabel("消息", { exact: true }).fill("Agent delegation origin");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await expect(page.getByRole("button", { name: "派发任务", exact: true })).toHaveCount(0);
  const sourceId = new URL(page.url()).searchParams.get("conversation")!;
  const result = await request.post("/api/tasks", { data: { sourceConversationId: sourceId,
    targetAgentId: "reviewer", request: "Synthetic Agent tool delegation" } });
  expect(result.ok()).toBe(true);
  const task = await result.json();
  expect(task.targetConversationId).not.toBe(sourceId);
});

test("archives and restores a completed chat without losing its history or completion state", async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  await page.goto("/?project=redesign&agent=writer");
  const title = "Quiet archive example";
  await page.getByLabel("消息", { exact: true }).fill(title);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText(`Fixture reply: ${title}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const id = new URL(page.url()).searchParams.get("conversation")!;
  await page.getByLabel("搜索对话", { exact: true }).fill(title);
  expect((await request.post(`/api/conversations/${id}/completion`, { data: { completed: true } })).ok()).toBe(true);
  await page.reload();
  const completed = (await (await request.get(`/api/conversations/${id}`)).json()).conversation.completedAt;
  expect(completed).toEqual(expect.any(String));
  await chooseOption(page, "会话视图", "recent");
  const original = await (await request.get(`/api/conversations/${id}`)).json();
  await (await conversationMenu(page, title)).getByRole("menuitem", { name: `归档对话 · ${title}`, exact: true }).click();
  await expect(page.locator(".chat-link").filter({ hasText: title })).toHaveCount(0);
  await expect(page.getByText(`Fixture reply: ${title}`, { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("conversation")).toBe(id);
  const archived = await (await request.get(`/api/conversations/${id}`)).json();
  expect(archived.conversation).toMatchObject({ archivedAt: expect.any(String), completedAt: completed, nativeId: original.conversation.nativeId });
  await chooseOption(page, "会话视图", "archived");
  await expect(page.locator(".chat-link").filter({ hasText: title })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText(`Fixture reply: ${title}`, { exact: true })).toBeVisible();
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "会话视图", exact: true })).toHaveAttribute("data-value", "archived");
  await page.getByLabel("搜索对话", { exact: true }).fill(title);
  await (await conversationMenu(page, title)).getByRole("menuitem", { name: `取消归档 · ${title}`, exact: true }).click();
  await expect(page.locator(".chat-link").filter({ hasText: title })).toHaveCount(0);
  await chooseOption(page, "会话视图", "recent");
  await expect(page.locator(".chat-link").filter({ hasText: title })).toHaveCount(1);
  expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation).toMatchObject({ archivedAt: null, completedAt: completed });
});

test("a running chat cannot be archived from its menu or the API", async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  await page.goto("/?project=redesign&agent=writer");
  await page.getByLabel("消息", { exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("执行中");
  const id = new URL(page.url()).searchParams.get("conversation")!;
  const title = "Busy archive example";
  await request.patch(`/api/conversations/${id}`, { data: { title } });
  await page.reload();
  try {
    await expect(page.locator(".chat-title-bar")).toContainText(title);
    const menu = await conversationMenu(page, title);
    await expect(menu.getByRole("menuitem", { name: `归档对话 · ${title}`, exact: true })).toBeDisabled();
    await expect(menu.getByRole("menuitem")).toHaveCount(1);
    expect((await request.post(`/api/conversations/${id}/archive`, { data: { archived: true } })).status()).toBe(409);
    expect((await (await request.get(`/api/conversations/${id}`)).json()).conversation.archivedAt ?? null).toBeNull();
  } finally { await request.post(`/api/conversations/${id}/stop`); }
});

test("chat row actions stay quiet until hover or keyboard focus and remain accessible on mobile", async ({ page, request, executionDirectory }) => {
  await fixture(request, executionDirectory);
  const response = await request.post("/api/conversations", { data: { projectId: "redesign", agentId: "writer", cli: "codex" } });
  const { id } = await response.json();
  const title = "Quiet keyboard actions";
  await request.patch(`/api/conversations/${id}`, { data: { title } });
  await page.goto(`/?project=redesign&conversation=${id}`);
  await page.getByLabel("消息", { exact: true }).click();
  const row = page.locator(".library-item").filter({ has: page.getByRole("button", { name: title, exact: true }) });
  const more = row.getByRole("button", { name: `更多操作 · ${title}`, exact: true });
  await expect(more).toHaveCSS("opacity", "0");
  await expect(more).toHaveCSS("pointer-events", "none");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await row.hover();
  await expect(more).toHaveCSS("opacity", "1");
  await page.getByLabel("消息", { exact: true }).click();
  await expect(more).toHaveCSS("opacity", "0");
  await row.getByRole("button", { name: title, exact: true }).focus();
  await expect(more).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: `对话操作 · ${title}`, exact: true });
  await expect(menu.getByRole("menuitem", { name: `归档对话 · ${title}`, exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: `归档对话 · ${title}`, exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.getByLabel("消息", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "会话列表", exact: true }).click();
  await expect(more).toBeVisible();
  expect(Number(await more.evaluate(element => getComputedStyle(element).opacity))).toBeGreaterThan(0);
  await more.click();
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
