import { test, expect } from "./helpers/execution-fixture";

async function setup(request: import("@playwright/test").APIRequestContext, executionDirectory: string) {
  const { config, revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { ...config,
    projects: [...config.projects.filter((project: {id:string})=>project.id!=="edit-project"), { id: "edit-project", name: "Synthetic edit workspace", cwd: executionDirectory, agentIds: ["edit-agent"], resources: [], mcp: [], skills: [] }],
    agents: [...config.agents.filter((agent: {id:string})=>agent.id!=="edit-agent"), { id: "edit-agent", name: "Synthetic editor", instructions: "Synthetic test only.", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
  } } })).ok()).toBe(true);
}

test("forks after an earlier reply and preserves the original history", async ({page, request, executionDirectory}) => {
  await setup(request, executionDirectory);
  await page.goto("/?project=edit-project&agent=edit-agent");
  for (const text of ["Retained prefix", "Original second request", "Later original request"]) {
    await page.getByLabel("消息", {exact:true}).fill(text);
    await page.getByRole("button", {name:"发送消息", exact:true}).click();
    await expect(page.getByText(`Fixture reply: ${text}`, {exact:true})).toBeVisible();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  }
  const sourceId = new URL(page.url()).searchParams.get("conversation")!;
  const before = await (await request.get(`/api/conversations/${sourceId}`)).json();
  const user = page.locator(".message.user").filter({hasText:"Original second request"});
  await expect(user.getByRole("button", {name:"Fork", exact:true})).toHaveCount(0);
  const turn = page.locator(".chat-turn").filter({hasText:"Fixture reply: Original second request"});
  await turn.getByRole("button", {name:"Fork", exact:true}).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).not.toBe(sourceId);
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.getByText("Fixture reply: Original second request", {exact:true})).toBeVisible();
  await expect(page.getByText("Later original request", {exact:true})).toHaveCount(0);
  await page.getByLabel("消息", {exact:true}).fill("New direction after the reply");
  await page.getByRole("button", {name:"发送消息", exact:true}).click();
  await expect(page.getByText("Fixture reply: New direction after the reply", {exact:true})).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  expect(await (await request.get(`/api/conversations/${sourceId}`)).json()).toEqual(before);
  await page.reload();
  await expect(page.getByText("Fixture reply: New direction after the reply", {exact:true})).toBeVisible();
});

test("edits and reruns in the current chat without adding a conversation, then continues after reload", async ({ page, request, context, executionDirectory }) => {
  await setup(request, executionDirectory);
  await page.goto("/?project=edit-project&agent=edit-agent");
  for (const text of ["Keep this prefix", "Replace this request", "Discard this later request"]) {
    await page.getByLabel("消息", { exact: true }).fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText(`Fixture reply: ${text}`, { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  }
  const id = new URL(page.url()).searchParams.get("conversation")!;
  const count = (await (await request.get("/api/conversations")).json()).length;
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByText("Fixture reply: Discard this later request", { exact: true })).toBeVisible();
  const target = page.locator(".message.user").filter({ hasText: "Replace this request" });
  await target.hover();
  await target.getByRole("button", { name: "编辑消息", exact: true }).click();
  await page.getByLabel("修改消息内容", { exact: true }).fill("Revised in place");
  await page.getByRole("button", { name: "保存并重新执行", exact: true }).click();
  for (const current of [page, other]) {
    await expect(current.getByText("Fixture reply: Revised in place", { exact: true })).toBeVisible();
    await expect(current.getByText("Fixture reply: Discard this later request", { exact: true })).toHaveCount(0);
    await expect(current.locator(".message.user")).toHaveCount(2);
    expect(new URL(current.url()).searchParams.get("conversation")).toBe(id);
  }
  expect((await (await request.get("/api/conversations")).json()).length).toBe(count);
  await page.reload();
  await expect(page.getByText("Fixture reply: Revised in place", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.getByLabel("消息", { exact: true }).fill("Continue revised chat");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("Fixture reply: Continue revised chat", { exact: true })).toBeVisible();
  await expect(page.locator(".message.user")).toHaveCount(3);
  await other.close();
});

test("cancels an edit, preserves the draft after failure, and disables edits during a running turn", async ({ page, request, executionDirectory }) => {
  await setup(request, executionDirectory);
  await page.goto("/?project=edit-project&agent=edit-agent");
  await page.getByLabel("消息", { exact: true }).fill("Original cancellable message");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("Fixture reply: Original cancellable message", {exact:true})).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const sourceId = new URL(page.url()).searchParams.get("conversation")!;
  const before = await (await request.get(`/api/conversations/${sourceId}`)).json();
  const edit = page.locator(".message.user").getByRole("button", { name: "编辑消息", exact: true });
  await page.locator(".message.user").hover();
  await edit.click();
  await page.getByLabel("修改消息内容", { exact: true }).fill("Unsent revision");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("修改消息内容", { exact: true })).toHaveCount(0);
  expect(await (await request.get(`/api/conversations/${sourceId}`)).json()).toEqual(before);
  await page.locator(".message.user").hover();
  await edit.click();
  await page.getByLabel("修改消息内容", { exact: true }).fill("Retained revision on failure");
  await page.route("**/api/conversations/*/edit", route => route.fulfill({ status: 500, json: { error: "Synthetic native fork failed" } }));
  await page.getByRole("button", { name: "保存并重新执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Synthetic native fork failed");
  await expect(page.getByLabel("修改消息内容", { exact: true })).toHaveValue("Retained revision on failure");
  expect(new URL(page.url()).searchParams.get("conversation")).toBe(sourceId);
  expect(await (await request.get(`/api/conversations/${sourceId}`)).json()).toEqual(before);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByLabel("消息", { exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  try {
    await expect(page.getByTestId("chat-status")).toHaveText("执行中");
    for (const button of await page.locator(".message.user").getByRole("button", { name: "编辑消息", exact: true }).all())
      await expect(button).toBeDisabled();
  } finally { await request.post(`/api/conversations/${sourceId}/stop`); }
});

test("answer footer forks from a completed reply without editing or executing it", async ({page, request, executionDirectory}) => {
  await setup(request, executionDirectory);
  await page.goto("/?project=edit-project&agent=edit-agent");
  for (const text of ["Fork checkpoint", "Later request"]) {
    await page.getByLabel("消息", {exact:true}).fill(text);
    await page.getByRole("button", {name:"发送消息", exact:true}).click();
    await expect(page.getByText(`Fixture reply: ${text}`, {exact:true})).toBeVisible();
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  }
  const source = new URL(page.url()).searchParams.get("conversation")!;
  const before = await (await request.get(`/api/conversations/${source}`)).json();
  const turn = page.locator(".chat-turn").filter({hasText:"Fixture reply: Fork checkpoint"});
  await expect(turn.locator(".turn-footer").getByRole("button", {name:"复制消息", exact:true})).toBeVisible();
  await expect(turn.locator(".message.text .message-name .message-actions")).toHaveCount(0);
  const answer = await turn.locator(".message.text").boundingBox();
  const footer = await turn.locator(".turn-footer").boundingBox();
  expect(footer!.y).toBeGreaterThanOrEqual(answer!.y + answer!.height);
  const actions = await turn.locator(".reply-actions").boundingBox();
  expect(Math.abs(actions!.x - answer!.x)).toBeLessThanOrEqual(1);
  await turn.locator(".turn-footer").getByRole("button", {name:"Fork", exact:true}).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).not.toBe(source);
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.getByText("Fixture reply: Fork checkpoint", {exact:true})).toBeVisible();
  await expect(page.getByText("Fixture reply: Later request", {exact:true})).toHaveCount(0);
  await expect(page.getByLabel("修改消息内容", {exact:true})).toHaveCount(0);
  expect(await (await request.get(`/api/conversations/${source}`)).json()).toEqual(before);
  await page.reload();
  await expect(page.getByText("Fixture reply: Fork checkpoint", {exact:true})).toBeVisible();
  const firstFork = new URL(page.url()).searchParams.get("conversation");
  await page.getByRole("button", {name:"Fork", exact:true}).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).not.toBe(firstFork);
  await expect(page.locator(".message.user")).toHaveCount(1);
  await page.getByLabel("消息", {exact:true}).fill("Continue after fork");
  await page.getByRole("button", {name:"发送消息", exact:true}).click();
  await expect(page.getByText("Fixture reply: Continue after fork", {exact:true})).toBeVisible();
});

test("latest OMP reply exposes a clickable Fork and handles the new conversation", async ({ page, request, executionDirectory }) => {
  await setup(request, executionDirectory);
  // The native OMP protocol is covered in omp.test.ts; use a persisted synthetic
  // reply here to exercise the frontend's runtime-specific availability rule.
  await page.goto("/?project=edit-project&agent=edit-agent");
  await page.getByLabel("消息", { exact: true }).fill("Latest reply checkpoint");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("Fixture reply: Latest reply checkpoint", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const sourceId = new URL(page.url()).searchParams.get("conversation")!;
  const before = await (await request.get(`/api/conversations/${sourceId}`)).json();
  await page.route(`**/api/conversations/${sourceId}`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), cli: "omp" } });
  });
  await page.reload();
  const button = page.getByRole("button", { name: "Fork", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).not.toBe(sourceId);
  await expect(page.getByText("Fixture reply: Latest reply checkpoint", { exact: true })).toBeVisible();
  await expect(page.locator(".message.user")).toHaveCount(1);
  expect(await (await request.get(`/api/conversations/${sourceId}`)).json()).toEqual(before);
});
