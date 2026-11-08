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

test("groups native tool events into readable operations and replays after reload", async ({
  page,
}) => {
  await page.goto("/?project=personal&agent=reader");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("tool-flow");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.getByRole("button", { name: "展开本轮过程", exact: true }).click();
  await expect(page.locator(".operation-card")).toHaveCount(3);
  const command = page
    .locator(".operation-card")
    .filter({ hasText: "cat tags.txt" });
  await command.locator("summary").first().click();
  await expect(command).toContainText("/personal/reading");
  await expect(command.locator(".operation-output")).toHaveText("tags: 3\n");
  await expect(command).toContainText("退出码 0");
  const file = page.locator(".operation-card").filter({ hasText: "修改文件" });
  await file.locator("summary").first().click();
  await expect(file).toContainText("/personal/reading/tags.txt");
  await expect(file).toContainText("+tags: 3");
  const mcp = page
    .locator(".operation-card")
    .filter({ hasText: "reading / list_tags" });
  await mcp.locator("summary").first().click();
  await expect(mcp.locator(".operation-output")).toHaveText(
    "fiction, science, history",
  );
  await page.reload();
  await page.getByRole("button", { name: "展开本轮过程", exact: true }).click();
  await expect(page.locator(".operation-card")).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("approval");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const approval = page.locator(".approval-card");
  await expect(approval).toContainText("读取个人样例的标签数量");
  await expect(approval).toContainText("/personal/reading");
  await expect(approval.locator(".approval-command")).toHaveText("echo ok");
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
});

test("shows native login guidance and can recheck without starting a conversation", async ({
  page,
  request,
}) => {
  let loggedIn = false;
  await page.route("**/api/cli/status*", async (route) =>
    route.fulfill({
      json: {
        status: loggedIn ? "ready" : "login-required",
        version: "0.154.0",
      },
    }),
  );
  const before = await (await request.get("/api/conversations")).json();
  await page.goto("/?project=personal&agent=reader");
  await page.getByRole("button", { name: "执行端状态", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "执行端状态" });
  await expect(dialog).toContainText("需要登录");
  await expect(dialog).toContainText("codex login");
  await expect(
    dialog.getByRole("link", { name: "安装与登录指引" }),
  ).toHaveAttribute("href", /developers.openai.com\/codex\/cli/);
  loggedIn = true;
  await dialog.getByRole("button", { name: "重新检测" }).click();
  await expect(dialog).toContainText("已连接");
  const after = await (await request.get("/api/conversations")).json();
  expect(after.length).toBe(before.length);
});

test("shows observed hook outcomes with their native trigger and persists them without duplicate runs", async ({ page,request }) => {
  // A cold collection is required: an existing persona need not include every new source.
  const projectId='hook-runtime-'+Date.now();
  const {config,revision}=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{...config.projects.find((p:any)=>p.id==='personal'),id:projectId,name:'Hooks fixture'}]}}})).ok()).toBe(true);
  const source=await(await request.post('/api/conversations',{data:{projectId,agentId:'reader',cli:'codex'}})).json();
  expect((await request.post('/api/conversations/'+source.id+'/messages',{data:{text:'hook-flow 的结果用中文回答'}})).ok()).toBe(true);
  await expect.poll(async()=>(await(await request.get('/api/conversations/'+source.id)).json()).conversation.status).toBe('idle');
  expect((await request.post('/api/conversations/'+source.id+'/completion',{data:{completed:true}})).ok()).toBe(true);
  await expect.poll(async()=>(await(await request.get('/api/v2/memory/records?conversationId='+source.id)).json()).records.some((r:any)=>r.layer==='L3')).toBe(true);
  const chat=await(await request.post('/api/conversations',{data:{projectId,agentId:'reader',cli:'codex'}})).json();
  await page.goto('/?conversation='+chat.id);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("hook-flow");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.getByRole("button", {name:"Hooks",exact:true}).click();
  const hookTrace = page.getByRole("region", {name:"Hooks",exact:true});
  await expect(hookTrace.locator(".operation-card").filter({hasText:/preflight\.sh|audit\.sh/})).toHaveCount(2);
  await expect(hookTrace.locator(".operation-card").filter({hasText:'记忆加载'})).toHaveCount(1);
  const recalled = hookTrace.locator(".operation-card").filter({hasText:'记忆加载'});
  await recalled.locator('summary').click();await expect(recalled).toContainText('beforeTurn');await expect(recalled).toContainText('Mandala');await expect(recalled).toContainText('hook-flow 的结果用中文回答');
  const complete = hookTrace.locator(".operation-card").filter({ hasText: "preflight.sh" });
  await expect(complete.locator("summary")).toContainText("完成");
  await complete.locator("summary").click();
  await expect(complete).toContainText("UserPromptSubmit");
  await expect(complete).toContainText("Codex");
  await expect(complete).toContainText("Synthetic preflight complete");
  await expect(complete).toContainText("12 ms");
  const failure = hookTrace.locator(".operation-card").filter({ hasText: "audit.sh" });
  await expect(failure.locator("summary")).toContainText("失败");
  await failure.locator("summary").click();
  await expect(failure).toContainText("Synthetic hook failure");
  await page.reload();
  await page.getByRole("button", {name:"Hooks",exact:true}).click();
  await expect(hookTrace.locator(".operation-card").filter({hasText:/preflight\.sh|audit\.sh/})).toHaveCount(2);
  await expect(hookTrace.locator(".operation-card").filter({hasText:'记忆加载'})).toHaveCount(1);
  await expect(hookTrace.locator(".operation-card").filter({ hasText: "audit.sh" }).locator("summary")).toContainText("失败");
});


test("activity precedes the final answer and stays compact with live status while folded", async ({ page, request }) => {
  await page.goto('/?project=personal&agent=reader');
  await page.getByLabel('消息', { exact: true }).fill('tool-flow');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: tool-flow', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开本轮过程', exact: true }).click();
  expect(await page.evaluate(() => {
    const tool = document.querySelector('.operation-card')!;
    const reply = document.querySelector('.agent-reply')!;
    const heading = reply.querySelector('.agent-reply-header')!;
    const process = reply.querySelector('.turn-process')!;
    if (!(heading.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const answer = [...document.querySelectorAll('.message.text')].find(x => x.textContent?.includes('Fixture reply: tool-flow'))!;
    return !!(tool.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await page.getByLabel('消息', { exact: true }).fill('live-tool-flow');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByLabel('当前操作')).toContainText('reading 1/3');
  await page.getByRole('button', { name: '展开本轮过程', exact: true }).click();
  const card = page.locator('.operation-card').filter({ hasText: 'read sample.txt' });
  await expect(card.locator('summary')).toContainText('执行中');
  await expect(card.locator('summary')).toContainText('reading 1/3');
  expect(await card.getAttribute('open')).toBeNull();
  expect((await card.locator('summary').boundingBox())!.height).toBeLessThanOrEqual(40);
  const id = new URL(page.url()).searchParams.get('conversation')!;
  expect((await request.post(`/api/conversations/${id}/stop`, { data: {} })).ok()).toBe(true);
  await expect(card.locator('summary')).toContainText('已中断');
  await page.reload();
  await page.getByRole('button', { name: '展开本轮过程', exact: true }).last().click();
  await expect(card.locator('summary')).toContainText('已中断');
});
