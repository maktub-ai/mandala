import type { APIRequestContext,Page } from '@playwright/test';
async function seedRuleForEditing(request:APIRequestContext,page:Page,projectId:string,agentId:string,name='Existing schedule',instructions='Review personal notes'){const response=await request.post('/api/automations',{data:{name,instructions,projectId,agentId,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}});expect(response.ok()).toBe(true);await page.goto('/schedules?project='+projectId);await page.getByRole('button',{name,exact:true}).click();await page.getByRole('article',{name,exact:true}).getByRole('button',{name:/^(编辑|Edit)$/,exact:true}).click();}
import { test, expect } from "@playwright/test";
import { chooseOption } from "./helpers/select";

async function setup(request: any) {
  const { config, revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { ...config, version: 2,
    projects: [{id:"schedule-reading",name:"Personal reading",cwd:"/tmp",resources:[],agentIds:["schedule-reader"],mcp:[],skills:[]}],
    agents: [...config.agents.filter((agent:any)=>agent.systemRole),{id:"schedule-reader",name:"Reader",instructions:"Personal examples",defaultCli:"codex",models:{},mcp:[],skills:[]},
      {id:"other-schedule-reader",name:"Other reader",instructions:"Personal examples",defaultCli:"codex",models:{},mcp:[],skills:[]}] } } })).ok()).toBe(true);
}

test("existing schedules edit, persist, run independently and retain their Project scope", async ({page,request}) => {
  await setup(request);await page.goto("/schedules?project=schedule-reading");
  await expect(page.getByRole("heading",{name:"计划",exact:true})).toBeVisible();
  await seedRuleForEditing(request,page,"schedule-reading","schedule-reader","Personal weekly notes","Review a personal reading list");
  const form=page.getByRole("form",{name:"编辑计划",exact:true});
  await expect(form.getByRole("combobox",{name:"执行方式",exact:true})).toHaveAttribute("data-value","independent");
  await chooseOption(page,form.getByRole("combobox",{name:"工作目录组",exact:true}),"none");
  await chooseOption(page,form.getByRole("combobox",{name:"重复方式",exact:true}),"weekly");
  await expect(form.getByRole("checkbox",{name:"周一",exact:true})).toBeChecked();
  await form.getByLabel("执行时间",{exact:true}).fill("09:00");
  await form.getByLabel("时区",{exact:true}).fill("Asia/Singapore");
  await form.getByRole("button",{name:"保存计划",exact:true}).click();
  const plan=page.getByRole("article",{name:"Personal weekly notes",exact:true});
  await expect(plan).toContainText("Asia/Singapore");
  await expect(plan).toContainText("已暂停");await plan.getByRole("button",{name:"启用定时规则",exact:true}).click();await expect(plan).toContainText("下次运行");await page.reload();await expect(plan).toBeVisible();
  await plan.getByRole("button",{name:"暂停后续执行",exact:true}).click();await expect(plan).toContainText("已暂停");
  await expect(plan.getByRole("button",{name:"运行一次",exact:true})).toBeEnabled();
  await plan.getByRole("button",{name:"启用定时规则",exact:true}).click();
  await plan.getByRole("button",{name:"运行一次",exact:true}).click();
  const run=page.locator(".schedule-detail-history .automation-run").filter({hasText:"Personal weekly notes"}).first();
  await expect(run).toContainText("结果待确认",{timeout:15000});
  const receipt=(await(await request.get("/api/automations")).json()).runs.find((item:any)=>item.automationId===new URL(page.url()).searchParams.get("schedule"));expect(receipt.status).toBe("succeeded");expect(receipt.taskState).toBe("review");
  await page.getByRole("button",{name:"关闭通知 Review a personal reading list",exact:true}).click();
  await run.getByRole("button",{name:"查看对话",exact:true}).click();
  await expect(page.getByText("Fixture reply: Review a personal reading list",{exact:true})).toBeVisible();
  expect((await(await request.get("/api/automations")).json()).automations.find((rule:any)=>rule.id===receipt.automationId).projectId).toBe("schedule-reading");
  await page.goto("/schedules?project=schedule-reading");
  await expect(page.getByRole("combobox",{name:"项目筛选",exact:true})).toHaveAttribute("data-value","schedule-reading");
  await page.getByRole("button",{name:"Personal weekly notes",exact:true}).click();await page.setViewportSize({width:390,height:844});await expect(plan).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("running schedules can be stopped without disabling the plan or losing history",async({page,request})=>{
  await setup(request);
  const schedule=await (await request.post("/api/automations",{data:{name:"Personal long review",instructions:"hold",projectId:"schedule-reading",agentId:"schedule-reader",cli:"codex",workspaceId:null,enabled:true,
    schedule:{kind:"daily",time:"09:00",timeZone:"Asia/Singapore"}}})).json();
  await page.goto("/schedules?project=schedule-reading");
  await page.getByRole("button",{name:"Personal long review",exact:true}).click();const plan=page.getByRole("article",{name:"Personal long review",exact:true});
  await plan.getByRole("button",{name:"启用定时规则",exact:true}).click();
  await plan.getByRole("button",{name:"运行一次",exact:true}).click();
  const run=page.locator(".schedule-detail-history .automation-run").filter({hasText:"Personal long review"}).first();
  await expect(run).toContainText("执行中",{timeout:15000});
  await run.getByRole("button",{name:"停止本次运行",exact:true}).click();
  await expect(run).toContainText("已中断");await expect(plan).toContainText("已启用");
  await plan.getByRole("button",{name:"删除计划",exact:true}).click();
  await plan.getByRole("button",{name:"确认删除",exact:true}).click();await expect(plan).toHaveCount(0);await expect(page.locator(".automation-history .automation-run").filter({hasText:"Personal long review"})).toBeVisible();
  const data=await (await request.get("/api/automations")).json();
  expect(data.runs.find((r:any)=>r.automationId===schedule.id).status).toBe("interrupted");
});

test("recent runs show the latest five and can reveal older runs on a narrow screen",async({page,request})=>{
  await setup(request);
  const runs=Array.from({length:6},(_,index)=>({id:`run-${index}`,name:`Review ${index+1}`,status:"succeeded",cli:"codex",projectId:"schedule-reading",createdAt:new Date(Date.UTC(2026,0,index+1)).toISOString()}));
  await page.route("**/api/automations",route=>route.fulfill({json:{version:1,automations:[],runs}}));
  await page.setViewportSize({width:390,height:844});
  await page.goto("/schedules?project=schedule-reading");
  const history=page.getByRole("region",{name:"最近运行",exact:true});
  const rows=history.getByRole("article");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText("Review 6");
  await expect(rows.last()).toContainText("Review 2");
  await history.getByRole("button",{name:"查看全部 6 条"}).click();
  await expect(rows).toHaveCount(6);
  await expect(rows.last()).toContainText("Review 1");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await history.getByRole("button",{name:"收起",exact:true}).click();
  await expect(rows).toHaveCount(5);
});

test("English narrow scheduling translates validation and keeps the form readable",async({page,request})=>{
  await setup(request);await page.addInitScript(()=>localStorage.setItem("mana-language","en"));
  await page.setViewportSize({width:390,height:844});await page.goto("/schedules?project=schedule-reading");
  await seedRuleForEditing(request,page,"schedule-reading","schedule-reader","Personal daily reading");
  const form=page.getByRole("form",{name:"Edit schedule",exact:true});
  await expect(form.getByRole("combobox",{name:"Execution mode",exact:true})).toHaveAttribute("data-value","independent");
  await form.getByLabel("Time zone",{exact:true}).fill("Invalid/TimeZone");
  await form.getByRole("button",{name:"Save schedule",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Invalid time zone");
  await form.getByLabel("Time zone",{exact:true}).fill("Asia/Singapore");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await form.getByRole("button",{name:"Save schedule",exact:true}).click();
  await expect(page.getByRole("article",{name:"Personal daily reading",exact:true})).toContainText("Every day");
  await page.screenshot({path:"/tmp/openmana-automation-narrow.png",fullPage:true});
});

test("scheduled approval requests open their native conversation and can be denied",async({page,request})=>{
  await setup(request);
  await request.post("/api/automations",{data:{name:"Personal approval review",instructions:"approval",projectId:"schedule-reading",agentId:"schedule-reader",cli:"codex",workspaceId:null,enabled:true,
    schedule:{kind:"daily",time:"09:00",timeZone:"Asia/Singapore"}}});
  await page.goto("/schedules?project=schedule-reading");
  await page.getByRole("button",{name:"Personal approval review",exact:true}).click();await page.getByRole("article",{name:"Personal approval review",exact:true}).getByRole("button",{name:"运行一次",exact:true}).click();
  const run=page.locator(".schedule-detail-history .automation-run").filter({hasText:"Personal approval review"}).first();
  await expect(run).toContainText("等待审批",{timeout:15000});
  await run.getByRole("button",{name:"处理审批",exact:true}).click();
  await expect(page.getByTestId("chat-status")).toHaveText("等待审批");
  await page.getByRole("button",{name:"拒绝",exact:true}).click();
  await expect(page.getByTestId("chat-status")).toHaveText("就绪");
});

test('uncached scheduled conversation opens through authorized read and delayed opening preserves a new draft',async({page,request})=>{
 await setup(request);await page.route(/\/api\/conversations(?:\?.*)?$/,route=>route.request().method()==='GET'?route.fulfill({json:[]}):route.continue());
 const plan=await(await request.post('/api/automations',{data:{name:'Uncached review',instructions:'Uncached personal reading',projectId:'schedule-reading',agentId:'schedule-reader',cli:'codex',workspaceId:null,enabled:true,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 await request.post('/api/automations/'+plan.id+'/run',{data:{}});
 let conversationId='';await expect.poll(async()=>{const data=await(await request.get('/api/automations')).json();conversationId=data.runs.find((r:any)=>r.automationId===plan.id)?.conversationId;return conversationId;}).toBeTruthy();
 await page.goto('/schedules?project=schedule-reading');await page.getByRole('button',{name:'Uncached review',exact:true}).click();await page.locator('.schedule-detail-history .automation-run').filter({hasText:'Uncached review'}).getByRole('button',{name:'查看对话',exact:true}).click();await expect(page).toHaveURL(new RegExp('conversation='+conversationId));await expect(page.getByText('Fixture reply: Uncached personal reading',{exact:true})).toBeVisible();
 await page.goto('/schedules?project=schedule-reading');await page.getByRole('button',{name:'Uncached review',exact:true}).click();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 await page.route('**/api/conversations/'+conversationId,async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});});
 await page.locator('.schedule-detail-history .automation-run').filter({hasText:'Uncached review'}).getByRole('button',{name:'查看对话',exact:true}).click();await started;await expect(page).toHaveURL(/\/schedules\?project=schedule-reading&schedule=/);
 await page.getByRole('button',{name:'新建计划',exact:true}).click();await page.getByLabel('计划名称',{exact:true}).fill('Unsent draft');release();await expect(page.getByLabel('计划名称',{exact:true})).toHaveValue('Unsent draft');await expect(page).toHaveURL(/schedules/);
});
