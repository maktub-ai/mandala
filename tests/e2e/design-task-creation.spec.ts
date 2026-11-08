import {test,expect} from '@playwright/test';

test('Agent task creation previews editable suggestions and saves without executing',async({page,request})=>{
 const before=await(await request.get('/api/v2/tasks')).json();
 let calls=0;
 await page.route('**/api/v2/tasks/draft',async route=>{calls++;expect(route.request().postDataJSON().description).toContain('每天');await route.fulfill({json:{goal:'整理产品反馈\n按影响范围归类',criteria:[{id:'feedback-check',text:'输出可阅读的改进清单',checkRef:null}],schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'},timeZone:'Asia/Singapore',unresolved:[]}});});
 await page.goto('/tasks');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'智能体创建',exact:true}).click();
 await page.locator('.task-creation-panel:visible').getByLabel('描述任务需求',{exact:true}).fill('每天09:00整理产品反馈，输出改进清单');
 await page.getByRole('button',{name:'生成任务草稿',exact:true}).click();
 await expect(page.locator('.task-creation-panel:visible').getByLabel('任务标题',{exact:true})).toHaveValue('整理产品反馈');
 await expect(page.locator('.task-creation-panel:visible').getByLabel('完成要求',{exact:true})).toHaveValue('输出可阅读的改进清单');
 for(const width of [1080,390]){
  await page.setViewportSize({width,height:844});
  const title=await page.locator('.task-creation-panel:visible').getByLabel('任务标题',{exact:true}).boundingBox(),details=await page.locator('.task-creation-panel:visible').getByLabel('详细说明',{exact:true}).boundingBox();
  expect(Math.abs(title!.x-details!.x)).toBeLessThan(2);expect(Math.abs(title!.width-details!.width)).toBeLessThan(2);
 }
 expect((await(await request.get('/api/v2/tasks')).json()).length).toBe(before.length);
 await page.locator('.task-creation-panel:visible').getByLabel('任务标题',{exact:true}).fill('确认后的产品反馈');
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page).toHaveURL(/\/tasks\/[^/?]+$/);
 const id=new URL(page.url()).pathname.split('/').at(-1);const detail=await(await request.get('/api/v2/tasks/'+id)).json();
 expect(detail.task.goal).toContain('确认后的产品反馈');expect(detail.task.criteria[0].text).toBe('输出可阅读的改进清单');expect(detail.runs).toHaveLength(0);expect(calls).toBe(1);
 const rules=await(await request.get('/api/automations')).json();expect(rules.automations.find((r:any)=>r.taskId===id).enabled).toBe(false);
});

test('Agent generation error preserves requirement for retry and manual fallback',async({page,request})=>{
 const before=await(await request.get('/api/v2/tasks')).json();
 await page.route('**/api/v2/tasks/draft',route=>route.fulfill({status:503,json:{error:'unavailable'}}));
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'智能体创建',exact:true}).click();
 await page.locator('.task-creation-panel:visible').getByLabel('描述任务需求',{exact:true}).fill('整理客户反馈');await page.getByRole('button',{name:'生成任务草稿',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('暂时无法生成');await expect(page.locator('.task-creation-panel:visible').getByLabel('描述任务需求',{exact:true})).toHaveValue('整理客户反馈');
 await page.getByRole('button',{name:'改为手动填写',exact:true}).click();await expect(page.locator('.task-creation-panel:visible').getByLabel('任务标题',{exact:true})).toHaveValue('整理客户反馈');
 expect((await(await request.get('/api/v2/tasks')).json()).length).toBe(before.length);
});

test('AI draft keeps its task identity during slow save and a failed schedule retry',async({page,request})=>{
 const before=await(await request.get('/api/v2/tasks')).json();
 await page.route('**/api/v2/tasks/draft',route=>route.fulfill({json:{goal:'每日反馈汇总',criteria:[],schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'},unresolved:[]}}));
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});let scheduleCalls=0;
 await page.route('**/api/automations',async route=>{if(route.request().method()!=='POST')return route.continue();if(++scheduleCalls===1){await pending;return route.fulfill({status:503,json:{error:'Schedule unavailable'}});}return route.continue();});
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'智能体创建',exact:true}).click();await page.locator('.task-creation-panel:visible').getByLabel('描述任务需求',{exact:true}).fill('每天9点整理反馈');await page.getByRole('button',{name:'生成任务草稿',exact:true}).click();
 await page.getByRole('button',{name:'创建任务',exact:true}).click();await expect.poll(()=>scheduleCalls).toBe(1);
 await expect(page.getByRole('button',{name:'返回需求',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'手动填写',exact:true})).toBeDisabled();release();await expect(page.getByRole('alert')).toContainText('Schedule unavailable');
 await expect(page.getByRole('button',{name:'返回需求',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'手动填写',exact:true})).toBeDisabled();await page.getByRole('button',{name:'创建任务',exact:true}).click();await expect(page).toHaveURL(/\/tasks\/[^/?]+$/);
 const after=await(await request.get('/api/v2/tasks')).json();expect(after.length).toBe(before.length+1);const id=new URL(page.url()).pathname.split('/').at(-1);expect((await(await request.get('/api/v2/tasks/'+id)).json()).runs).toHaveLength(0);
 const rules=await(await request.get('/api/automations')).json();expect(rules.automations.filter((r:any)=>r.taskId===id)).toHaveLength(1);expect(rules.automations.find((r:any)=>r.taskId===id).enabled).toBe(false);
});

for(const theme of ['light','dark'])test('task creation and detail stay aligned at narrow width in '+theme,async({page,request})=>{
 await page.setViewportSize({width:390,height:844});await page.addInitScript(value=>localStorage.setItem('mana-theme',value),theme);
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'智能体创建',exact:true}).click();await expect(page.locator('.task-list-toolbar')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'audit/2026-10-17-design-refinement/ai-mobile-'+theme+'.png',fullPage:true});
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'design-narrow-'+theme},data:{goal:'整理本周产品反馈\n按影响范围归类，提出下周改进建议。',criteria:[{id:'readable',text:'输出反馈汇总与改进清单',checkRef:null}]}})).json();
 await page.goto('/tasks/'+task.id);await expect(page.getByRole('heading',{name:'整理本周产品反馈'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const buttons=await page.locator('.task-command-bar .task-actions button').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));expect(Math.max(...buttons)-Math.min(...buttons)).toBeLessThan(2);
 await page.screenshot({path:'audit/2026-10-17-design-refinement/task-mobile-'+theme+'.png',fullPage:true});
});
