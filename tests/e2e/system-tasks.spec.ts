import { openArea } from "./helpers/navigation";
import { test, expect } from "./helpers/execution-fixture";

test("automatic title and memory extraction update the UI and retain source identity", async ({ page, request, executionDirectory }) => {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2,
    projects: [{ id: "system-reading", name: "Personal reading", cwd: executionDirectory, agentIds: ["system-reader"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "system-reader", name: "Reader", instructions: "Synthetic personal reading only.", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
    system: { cli: "codex", automaticTitles: true, memory: {request:{generate:true,read:true},session:{generate:true,read:true},idleHours:6} },
  } } })).ok()).toBe(true);
  await page.goto("/?project=system-reading&agent=system-reader");
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveText("Fixture");
  const creation = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/conversations");
  await page.getByLabel("消息", { exact: true }).fill("Weekly personal reading plan");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  expect((await creation).postDataJSON()).toMatchObject({model:"model-fixture"});
  await expect(page.locator(".chat-title-bar")).toContainText("Synthetic title: Weekly personal reading plan");
  await expect(page.locator(".message.text")).toContainText("Fixture reply: Weekly personal reading plan");
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  const sourceId = new URL(page.url()).searchParams.get("conversation");
  expect((await request.post(`/api/conversations/${sourceId}/completion`,{data:{completed:true}})).ok()).toBe(true);
  const endHooks = page.getByRole("region", {name:"Hooks",exact:true});
  await page.getByRole("button", {name:"Hooks",exact:true}).click();
  await expect(endHooks).toBeVisible();
  expect(await endHooks.evaluate(element => !!(document.querySelector(".message.text")!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const memoryHook = endHooks.locator(".operation-card").filter({hasText:"提炼记忆"}).last();
  await expect(memoryHook.locator("summary")).toContainText("完成");
  await expect(memoryHook.locator("summary")).toContainText("回复后");
  const titleHook = page.locator(".operation-card").filter({ hasText: "生成标题" }).first();
  await expect(titleHook.locator("summary")).toContainText("后台");
  await titleHook.locator("summary").click();
  await expect(titleHook).toContainText("已更新对话标题");
  await expect(titleHook).toContainText("Synthetic title: Weekly personal reading plan");
  await expect(page.getByRole("button", { name: "生成标题", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "提炼记忆", exact: true })).toHaveCount(0);
  await expect(page.locator(".chat-utilities")).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get("conversation");
  const conversation = (await (await request.get(`/api/conversations/${id}`)).json()).conversation;
  expect(conversation).toMatchObject({ cli: "codex", agentId: "system-reader", titleSource: "automatic", model: "model-fixture" });
  await openArea(page, "MANA 工作区");
  const memory = page.getByRole("article", { name: "记忆 L1", exact: true }).filter({hasText:"Weekly personal reading plan"});
  await expect(memory).toContainText("生效");
  await expect(memory).toContainText("Reader");
  await expect(memory.getByRole("button",{name:"确认采用",exact:true})).toHaveCount(0);
  const data = await (await request.get("/api/v2/memory/records?conversationId=" + id)).json();
  const entry = data.records.find((item: { layer:string; text:string }) => item.layer === "L1" && item.text === "Weekly personal reading plan");
  expect(entry).toMatchObject({sourceAgentIds:["system-reader"],status:"active",verification:"evidence_extract",layer:"L1",conversationId:id});
  expect(data.collections.find((item: {id:string}) => item.id === entry.collectionId)).toMatchObject({projectId:"system-reading",agentId:null});
  const source = await (await request.get("/api/v2/memory/sources/" + entry.evidence[0].sourceId)).json();
  expect(source).toMatchObject({agentId:"system-reader",conversationId:id});
  expect(source.events.some((event: {kind:string;text:string}) => event.kind === "user" && event.text === entry.text)).toBe(true);
  await memory.getByRole("button", { name: "查看来源对话", exact: true }).click();
  expect((await(await request.get(`/api/conversations/${id}`)).json()).conversation.completedAt).toBeTruthy();
  await expect(page.locator(".chat-title-bar")).toContainText(conversation.title);
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await page.getByLabel("消息", { exact: true }).fill("Recall the weekly personal reading plan");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("Fixture reply: Recall the weekly personal reading plan", { exact: true })).toBeVisible();
  await page.getByRole("button", {name:"Hooks",exact:true}).last().click();
  const recallCard = page.locator(".operation-card").filter({ hasText: "记忆加载" });
  await expect(recallCard.locator("summary")).toContainText("完成");
  await expect(recallCard.locator("summary")).toContainText("回复前");
  await recallCard.locator("summary").click();
  await expect(recallCard.locator('.recalled-records')).toContainText(entry.text);
  await expect(recallCard.locator('.recalled-records > *')).toHaveCount(3);
  await page.reload();
  await expect(page.locator(".chat-title-bar")).toContainText(conversation.title);
});

test("automatic title appears while the first turn is still running", async ({ page, request, executionDirectory }) => {
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 2,
    projects: [{ id: "early-title", name: "Personal title test", cwd: executionDirectory, agentIds: ["reader"], resources: [], mcp: [], skills: [] }],
    agents: [{ id: "reader", name: "Reader", instructions: "Personal sample only.", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
    system: { cli: "codex", automaticTitles: true, memory: {request:{generate:true,read:true},session:{generate:true,read:true},idleHours:6} },
  } } });
  await page.goto("/?project=early-title&agent=reader");
  await page.getByLabel("消息", { exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".chat-title-bar")).toContainText("Synthetic title: hold");
  await expect(page.getByTestId("chat-status")).toHaveText("执行中");
  const id = new URL(page.url()).searchParams.get("conversation");
  const memory = await request.get("/api/v2/memory/records?conversationId=" + id);
  expect(memory.ok()).toBe(true);
  expect((await memory.json()).records).toEqual([]);
  await page.getByRole("button", { name: "停止执行", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("已中断");
});


test("merges native and platform hooks in one footer while retaining their triggers", async ({ page, request }) => {
  test.setTimeout(60000);
  const { revision } = await (await request.get("/api/config")).json();
  await request.put("/api/config", { data: { revision, config: { version: 2,
    projects: [],
    agents: [{ id: "hook-reader", name: "Hook reader", instructions: "Synthetic test only.", defaultCli: "codex", models: {}, mcp: [], skills: [] }],
    system: { cli: "codex", automaticTitles: true, memory: {request:{generate:true,read:true},session:{generate:true,read:true},idleHours:6} },
  } } });
  await page.goto("/?project=&agent=hook-reader");
  for (let round = 0; round < 2; round++) {
    await page.getByLabel("消息", {exact:true}).fill("hook-flow");
    await page.getByRole("button", {name:"发送消息",exact:true}).click();
    await expect(page.locator(".message.text")).toHaveCount(round + 1);
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
    const currentId=new URL(page.url()).searchParams.get("conversation");
    const captureResponse=await request.post(`/api/conversations/${currentId}/memory`,{data:{}});
    expect(captureResponse.ok(),await captureResponse.text()).toBe(true);
    await expect.poll(async () => {
      const captureJobs = await (await request.get("/api/v2/memory/jobs")).json();
      return captureJobs.filter((job: {conversationId?:string}) => job.conversationId === currentId)
        .map((job: {state:string;error:string|null}) => ({state:job.state,error:job.error}));
    }, {timeout:15000}).toEqual(Array.from({length:round+1},()=>({state:"completed",error:null})));
    const turn = page.locator(".chat-turn").last();
    await expect(turn.getByRole("button", {name:"Hooks",exact:true})).toHaveCount(1);
    await turn.getByRole("button", {name:"Hooks",exact:true}).click();
    const hooks = turn.getByRole("region", {name:"Hooks",exact:true});
    const history=await(await request.get(`/api/conversations/${currentId}/history`)).json();
    const start=history.findLastIndex((event:any)=>event.kind==='user');
    const memoryJobs=new Set<string>(history.slice(start).filter((event:any)=>event.kind==='metadata'&&event.data.systemTask==='memory').map((event:any)=>event.data.jobId).filter(Boolean));
    expect(memoryJobs.size).toBeGreaterThan(0);
    const cards=hooks.locator('.operation-card');
    await expect(cards).toHaveCount(3+memoryJobs.size);
    const extraction=cards.filter({hasText:'提炼记忆'});await expect(extraction).toHaveCount(memoryJobs.size);
    for(const card of await extraction.all()){await expect(card.locator('summary')).toContainText('回复后');await card.locator('summary').click();}
    const labels:Record<string,string>={queued:'待处理',pending:'待处理',running:'执行中',failed:'失败',completed:'完成'};
    for(const jobId of memoryJobs){
      const card=extraction.filter({hasText:jobId});await expect(card).toHaveCount(1);
      // Other background jobs may still retry after the request capture completed.
      await expect.poll(async()=>{
        const fresh=await(await request.get(`/api/conversations/${currentId}/history`)).json();
        const latest=fresh.slice(start).filter((event:any)=>event.data?.jobId===jobId).at(-1).data;
        const label=labels[latest.status];
        return !!label&&(await card.locator('summary').innerText()).includes(label)&&(!latest.message||(await card.innerText()).includes(latest.message));
      }).toBe(true);
    }
    await expect(cards.filter({hasText:'preflight.sh'})).toHaveCount(1);
    await expect(cards.filter({hasText:'audit.sh'})).toHaveCount(1);
    await expect(cards.filter({hasText:'audit.sh'}).locator('summary')).toContainText('UserPromptSubmit');
    await expect(hooks.locator(".operation-card").filter({hasText:"preflight.sh"}).locator("summary")).toContainText("UserPromptSubmit");
    await expect(hooks.locator(".operation-card").filter({hasText:round ? "记忆加载" : "生成标题"}).locator("summary")).toContainText(round ? "回复前" : "后台");
    await turn.getByRole("button", {name:"展开本轮过程",exact:true}).click();
    await expect(turn.locator(".turn-process .operation-card")).toHaveCount(0);
    await expect(turn.locator(".turn-end-hooks, .run-background-state")).toHaveCount(0);
    if (round === 1) {
      await page.setViewportSize({width:390,height:844});
      const content = await turn.locator(".message.text .message-content").boundingBox();
      const trace = await hooks.boundingBox();
      expect(Math.abs(trace!.x - content!.x)).toBeLessThanOrEqual(1);
      expect(trace!.width).toBeGreaterThanOrEqual(content!.width - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => localStorage.setItem("mana-language", "en"));
      await page.reload();
      await page.getByRole("button", {name:"Hooks",exact:true}).last().click();
      const replay = page.getByRole("region", {name:"Hooks",exact:true});
      await expect(replay.locator(".operation-card").filter({hasText:"Memory recall"}).locator("summary")).toContainText("Before reply");
      await expect(replay.locator(".operation-card").filter({hasText:"Extract memory"})).toHaveCount(memoryJobs.size);
      for(const card of await replay.locator(".operation-card").filter({hasText:"Extract memory"}).all())await expect(card.locator("summary")).toContainText("After reply");
    }
  }
});
