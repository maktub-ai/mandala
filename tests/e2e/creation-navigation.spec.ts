import {chooseOption} from './helpers/select';
import {expect,test} from '@playwright/test';
import {openArea} from './helpers/navigation';

test('task creation defaults to AI and leaving either mode cancels without creating a record',async({page,request})=>{
 const before=await(await request.get('/api/v2/tasks')).json();
 await page.goto('/tasks');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await expect(page.getByRole('button',{name:'智能体创建',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByLabel('描述任务需求',{exact:true}).fill('未提交的智能体需求');
 await openArea(page,'团队');
 await openArea(page,'任务');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await expect(page.getByLabel('描述任务需求',{exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'手动填写',exact:true}).click();
 await page.getByLabel('任务标题',{exact:true}).fill('未提交的手动任务');
 await openArea(page,'文件');
 expect(await(await request.get('/api/v2/tasks')).json()).toEqual(before);
});

test('leaving while AI generates a draft does not navigate back or save a task',async({page,request})=>{
 const before=await(await request.get('/api/v2/tasks')).json();
 let release!:()=>void,seen!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r);
 await page.route('**/api/v2/tasks/draft',async route=>{seen();await gate;await route.fulfill({json:{goal:'Late draft',criteria:[],schedule:null,unresolved:[]}});});
 await page.goto('/tasks?action=create');
 await page.getByRole('button',{name:'智能体创建',exact:true}).click();
 await page.getByLabel('描述任务需求',{exact:true}).fill('生成后不要把我拉回来');
 await page.getByRole('button',{name:'生成任务草稿',exact:true}).click();await started;
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/v2/tasks'));
 try{await openArea(page,'团队');}finally{release();}
 await (await response).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page).toHaveURL(/\/agents$/);
 expect(await(await request.get('/api/v2/tasks')).json()).toEqual(before);
});

test('a delayed confirmed save can finish without dragging the user back from another page',async({page,request})=>{
 let release!:()=>void,seen!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r);
 let savedId='';
 await page.route('**/api/v2/tasks',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const response=await route.fetch();savedId=(await response.json()).id;seen();await gate;await route.fulfill({response});
 });
 await page.goto('/tasks?action=create');await page.getByRole('button',{name:'手动填写',exact:true}).click();
 await page.getByLabel('任务标题',{exact:true}).fill('用户已确认的创建');
 await page.getByRole('button',{name:'创建任务',exact:true}).click();await started;
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/v2/tasks'));
 try{await openArea(page,'团队');}finally{release();}
 await (await response).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page).toHaveURL(/\/agents$/);
 const saved=await(await request.get('/api/v2/tasks/'+savedId)).json();expect(saved.task.state).toBe('todo');expect(saved.runs).toEqual([]);
});

test('project name preparation can be abandoned without a confirmation dialog or saved record',async({page,request})=>{
 const before=(await(await request.get('/api/config')).json()).config.projects;
 let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});
 await page.goto('/projects');await expect(page.locator('.workspace-directory')).toBeVisible();await page.getByRole('button',{name:'添加项目',exact:true}).click();
 await page.getByRole('region',{name:'新建项目',exact:true}).getByLabel('项目名称',{exact:true}).fill('不提交的项目');
 await openArea(page,'任务');
 expect(dialogs).toBe(0);expect((await(await request.get('/api/config')).json()).config.projects).toEqual(before);
});

test('an Agent name is not autosaved and only explicit creation persists it',async({page,request})=>{
 const before=(await(await request.get('/api/config')).json()).config.agents;
 await page.goto('/agents');await expect(page.locator('.workspace-directory')).toBeVisible();await page.getByRole('button',{name:'添加智能体',exact:true}).click();
 await page.getByLabel('智能体 名称',{exact:true}).fill('先不创建的智能体');
 await page.waitForTimeout(800); // Exceed the existing 500ms autosave debounce.
 expect((await(await request.get('/api/config')).json()).config.agents).toEqual(before);
 await openArea(page,'任务');await openArea(page,'团队');
 await page.getByRole('button',{name:'添加智能体',exact:true}).click();
 await page.getByLabel('智能体 名称',{exact:true}).fill('明确创建的智能体');
 await chooseOption(page,'执行端','codex');await page.getByRole('button',{name:'创建智能体',exact:true}).click();
 await expect.poll(async()=> (await(await request.get('/api/config')).json()).config.agents.map((a:{name:string})=>a.name)).toContain('明确创建的智能体');
});

test('a failed schedule save after leaving remains visible and can be retried without duplicating the task',async({page,request})=>{
 let release!:()=>void,seen!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r);
 let fail=true;
 await page.route('**/api/v2/tasks/draft',route=>route.fulfill({json:{goal:'稍后重试的定时任务',criteria:[],schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'},unresolved:[]}}));
 await page.route('**/api/automations',async route=>{
  if(route.request().method()!=='POST'||!fail)return route.continue();
  fail=false;seen();await gate;await route.fulfill({status:503,json:{error:'Synthetic schedule save failure'}});
 });
 await page.goto('/tasks?action=create');await page.getByLabel('描述任务需求',{exact:true}).fill('每天九点整理');
 await page.getByRole('button',{name:'生成任务草稿',exact:true}).click();
 await page.getByRole('button',{name:'创建任务',exact:true}).click();await started;
 try{await openArea(page,'团队');}finally{release();}
 const alert=page.getByRole('alert').filter({hasText:'任务保存未完成'});
 await expect(alert).toContainText('Synthetic schedule save failure');
 await page.screenshot({path:'/tmp/compact-creation-save-failure.png'});
 await alert.getByRole('button',{name:'重试保存',exact:true}).click();await expect(alert).toHaveCount(0);
 await expect(page).toHaveURL(/\/agents$/);
 const tasks=await(await request.get('/api/v2/tasks')).json();const matches=tasks.filter((task:{goal:string})=>task.goal==='稍后重试的定时任务');expect(matches).toHaveLength(1);
 const rules=(await(await request.get('/api/automations')).json()).automations.filter((rule:{taskId:string})=>rule.taskId===matches[0].id);expect(rules).toHaveLength(1);expect(rules[0].enabled).toBe(false);
});

test('two saves failing after navigation retain independent retry actions',async({page,request})=>{
 const releases:Array<()=>void>=[];
 let failures=0;
 await page.route('**/api/v2/tasks',async route=>{
  if(route.request().method()!=='POST'||failures>=2)return route.continue();
  failures++;await new Promise<void>(resolve=>releases.push(resolve));
  await route.fulfill({status:503,json:{error:'Synthetic temporary failure'}});
 });
 await page.goto('/tasks?action=create');
 for(const goal of ['保存失败 A','保存失败 B']){await page.getByRole('button',{name:'手动填写',exact:true}).click();
  await page.getByLabel('任务标题',{exact:true}).fill(goal);await page.getByRole('button',{name:'创建任务',exact:true}).click();
  await expect.poll(()=>releases.length).toBe(goal.endsWith('A')?1:2);await openArea(page,'团队');
  if(goal.endsWith('A')){
   // Use in-app navigation for the second creation so the first pending request survives.
   await openArea(page,'任务');await page.getByRole('button',{name:'新建任务',exact:true}).click();
  }
 }
 releases.forEach(release=>release());
 const alerts=page.getByRole('alert').filter({hasText:'任务保存未完成'});await expect(alerts).toHaveCount(2);
 for(const goal of ['保存失败 A','保存失败 B']){
  await alerts.filter({hasText:goal}).getByRole('button',{name:'重试保存',exact:true}).click();
  await expect(alerts.filter({hasText:goal})).toHaveCount(0);
 }
 const tasks=await(await request.get('/api/v2/tasks')).json();
 for(const goal of ['保存失败 A','保存失败 B'])expect(tasks.filter((task:{goal:string})=>task.goal===goal)).toHaveLength(1);
});

test('Add agent opens the creation form instead of an unavailable notice',async({page})=>{
 await page.goto('/agents');await expect(page.locator('.workspace-directory')).toBeVisible();
 await page.getByRole('button',{name:'添加智能体',exact:true}).click();
 await expect(page.getByRole('region',{name:'创建智能体',exact:true})).toBeVisible();
 await expect(page.getByText('此项目或智能体不可用',{exact:false})).toHaveCount(0);
});
