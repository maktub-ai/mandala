import {waitForAutosave} from './helpers/settings';
import { test, expect } from "@playwright/test";
import { chooseOption } from "./helpers/select";

for(const [choice,label,decision] of [["once","允许本次","approve"],["session","本会话内批准","approve-session"],
  ["always","始终允许此工具","approve-always"],["reject","拒绝","reject"]]) {
  test(`MCP project_agents approval resolves and execution continues: ${choice}`,async({page,request})=>{
    const {revision}=await(await request.get("/api/config")).json();
    await request.put("/api/config",{data:{revision,config:{version:2,projects:[],agents:[]}}});
    await page.addInitScript(()=>localStorage.setItem("mana-chat-preferences",JSON.stringify({projectId:"",agentId:"",model:"",effort:"",cli:"codex",onboardingCompleted:true})));
    await page.goto("/?project=&agent=");
    await page.getByLabel("消息",{exact:true}).fill("mcp-approval-" + choice);
    await page.getByRole("button",{name:"发送消息",exact:true}).click();
    const card=page.locator(".approval-card");
    await expect(card).toContainText("Codex 请求调用 MCP 工具");
    await expect(card).toContainText('tool "project_agents"');
    await expect(card).not.toContainText("暂不支持");
    const submission=page.waitForRequest(r=>r.method()==="POST" && r.url().includes("/approvals/"));
    await card.getByRole("button",{name:label,exact:true}).click();
    expect((await submission).postDataJSON()).toEqual({decision});
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("chat-status")).toHaveText("就绪");
    await expect(page.locator(".agent-reply .message.text")).toContainText("MCP approval resolved: " + choice);
  });
}

test("Agent defaults and per-chat overrides persist and cannot change during a turn", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  const config = { version: 2,
    projects: [{ id: "approval", name: "Personal sample", cwd: "/tmp", resources: [], agentIds: ["reader"], mcp: [], skills: [] }],
    agents: [{ id: "reader", name: "Reader", defaultCli: "codex", instructions: "Personal samples", models: {}, mcp: [], skills: [] }] };
  expect((await request.put("/api/config", { data: { config, revision } })).ok()).toBe(true);
  await page.goto("/agents/reader?tab=execution");
  await chooseOption(page, "默认审批模式", "auto");
  await waitForAutosave(page);
  expect((await (await request.get("/api/config")).json()).config.agents[0].runtime.codex.approvalMode).toBe("auto");
  await page.goto("/?project=approval&agent=reader");
  const mode = page.getByRole("combobox", { name: "审批模式", exact: true });
  await expect(mode).toContainText("自动批准");
  await chooseOption(page, mode, "auto");
  await page.getByLabel("消息", { exact: true }).fill("hold");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("执行中");
  await expect(mode).toBeDisabled();
  const id = new URL(page.url()).searchParams.get("conversation");
  const read = async () => (await (await request.get(`/api/conversations/${id}`)).json()).conversation;
  expect((await read()).approvalMode).toBe("auto");
  await page.getByRole("button", { name: "停止执行", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("已中断");
  await chooseOption(page, mode, "default");
  await expect(mode).toBeEnabled();
  await expect.poll(async () => (await read()).approvalMode).toBe("default");
  await page.reload();
  await expect(mode).toHaveAttribute("data-value", "default");
  await page.getByLabel("消息", { exact: true }).fill("Read a personal sample");
  await page.getByRole("button", { name: "继续执行", exact: true }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
  await chooseOption(page, mode, "");
  await expect.poll(async () => (await read()).approvalMode).toBeNull();
  await expect(mode).toContainText("自动批准");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "输入区设置", exact: true }).click();
  await expect(mode).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const [label, decision] of [["本会话内批准", "approve-session"], ["始终允许此前缀", "approve-rule"]]) {
  test(`native approval offers ${label} and submits its distinct scope`, async ({page, request}) => {
    const {revision} = await (await request.get("/api/config")).json();
    await request.put("/api/config", {data:{revision,config:{version:2,
      projects:[{id:"scoped-approval",name:"Synthetic approval",cwd:"/tmp",agentIds:["scoped-agent"],resources:[],mcp:[],skills:[]}],
      agents:[{id:"scoped-agent",name:"Synthetic approver",instructions:"Synthetic test only",defaultCli:"codex",models:{},mcp:[],skills:[]}],
    }}});
    await page.goto("/?project=scoped-approval&agent=scoped-agent");
    await page.getByLabel("消息",{exact:true}).fill("approval-options");
    await page.getByRole("button",{name:"发送消息",exact:true}).click();
    const card = page.locator(".approval-card");
    await expect(card.getByRole("button",{name:"允许本次",exact:true})).toBeVisible();
    await expect(card.getByRole("button",{name:"本会话内批准",exact:true})).toBeVisible();
    await expect(card.getByRole("button",{name:"始终允许此前缀",exact:true})).toBeVisible();
    await expect(card).toContainText('["echo"]');
    const submission = page.waitForRequest(req=>req.url().includes("/approvals/") && req.method()==="POST");
    await card.getByRole("button",{name:label,exact:true}).click();
    expect((await submission).postDataJSON()).toEqual({decision});
    await expect(card).toHaveCount(0);
    const id = new URL(page.url()).searchParams.get("conversation");
    expect((await (await request.get(`/api/conversations/${id}`)).json()).approvalMode).not.toBe("auto");
    await request.post(`/api/conversations/${id}/stop`);
  });
}

test("restricted native choices do not expose unsupported remembered grants on narrow screens", async ({page,request}) => {
  const {revision} = await (await request.get("/api/config")).json();
  await request.put("/api/config",{data:{revision,config:{version:2,projects:[],agents:[]}}});
  await page.setViewportSize({width:390,height:850});
  await page.addInitScript(()=>localStorage.setItem("mana-chat-preferences",JSON.stringify({projectId:"",agentId:"",model:"",effort:"",cli:"codex",onboardingCompleted:true})));
    await page.goto("/?project=&agent=");
  await page.getByLabel("消息",{exact:true}).fill("approval-cancel");
  await page.getByRole("button",{name:"发送消息",exact:true}).click();
  const card=page.locator(".approval-card");
  await expect(card.getByRole("button",{name:"允许本次",exact:true})).toBeVisible();
  await expect(card.getByRole("button",{name:"本会话内批准",exact:true})).toHaveCount(0);
  await expect(card.getByRole("button",{name:"始终允许此前缀",exact:true})).toHaveCount(0);
  await card.getByRole("button",{name:"拒绝并停止",exact:true}).click();
  await expect(card).toHaveCount(0);
  const id=new URL(page.url()).searchParams.get("conversation");
  await request.post(`/api/conversations/${id}/stop`);
});

test('chat tool authorization is reused without a composer banner or changing approval mode',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[]}}});
 await page.addInitScript(()=>localStorage.setItem('mana-chat-preferences',JSON.stringify({projectId:'',agentId:'',model:'',effort:'',cli:'codex',onboardingCompleted:true})));
 await page.goto('/?project=&agent=');
 const send=async()=>{await page.getByLabel('消息',{exact:true}).fill('approval-options');await page.getByRole('button',{name:'发送消息',exact:true}).click();};
 await send();const card=page.locator('.approval-card');await expect(card).toContainText('范围不限于当前命令');
 await card.getByRole('button',{name:'授权本对话后续工具',exact:true}).click();
 await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 const banner=page.locator('.conversation-tool-authorization');await expect(banner).toHaveCount(0);
 await expect(page.getByText('本对话已授权后续工具操作',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'撤销对话授权',exact:true})).toHaveCount(0);
 const id=new URL(page.url()).searchParams.get('conversation');
 await send();await expect(page.getByTestId('chat-status')).toHaveText('就绪');await expect(card).toHaveCount(0);
 await page.reload();await expect(page.getByLabel('消息',{exact:true})).toBeVisible();await expect(banner).toHaveCount(0);
 for(const theme of ['light','dark'])for(const width of [1280,390]){
  await page.setViewportSize({width,height:850});
  await page.evaluate(value=>{localStorage.removeItem('mandala-appearance-v1');localStorage.setItem('mana-theme',value);},theme);await page.reload();
  await expect(page.getByLabel('消息',{exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await expect(banner).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/private/tmp/mandala-approval-${theme}-${width}.png`,fullPage:true});
 }
 expect((await(await request.get(`/api/conversations/${id}/tool-authorization`)).json()).granted).toBe(true);
 expect((await(await request.get(`/api/conversations/${id}`)).json()).conversation.approvalMode).not.toBe('auto');
 expect((await request.delete(`/api/conversations/${id}/tool-authorization`)).ok()).toBe(true);
 expect((await(await request.get(`/api/conversations/${id}/tool-authorization`)).json()).granted).toBe(false);
 await send();await expect(card).toHaveCount(1);
 await request.post(`/api/conversations/${id}/stop`);
});
