import {test,expect} from '@playwright/test';
test('board contains many cards and keeps every state control reachable inside its column',async({page,request})=>{
 const ids:string[]=[];
 for(let n=0;n<14;n++){
  const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:`Synthetic overflow ${n} — ${'Long task title 中文 '.repeat(12)}`}});
  expect(response.ok()).toBe(true);ids.push((await response.json()).id);
 }
 await page.goto('/tasks?type=tasks&view=board');
 const board=page.getByRole('region',{name:'进度看板',exact:true});
 await expect(board.locator(`[data-task-id="${ids.at(-1)}"]`)).toBeAttached();
 for(const width of [1280,1008,390]){
  await page.setViewportSize({width,height:850});
  const failures=await board.evaluate(el=>[...el.querySelectorAll('.task-board-card')].flatMap(card=>{
   const box=card.getBoundingClientRect(),column=card.closest('.task-group')!.getBoundingClientRect();
   const control=card.querySelector('.task-card-move')!.getBoundingClientRect();
   return box.x<column.x||box.right>column.right+1||control.right>box.right+1?['Card or state control escaped its column']:[];
  }));
  expect(failures).toEqual([]);
  if(width<1100)expect(await board.evaluate(el=>[...el.querySelectorAll('.task-group')].every(group=>group.getBoundingClientRect().width>=240))).toBe(true);
  const list=page.getByRole('list',{name:'需要你处理事项',exact:true});
  expect(await list.evaluate(el=>el.scrollHeight>el.clientHeight||el.closest('.task-board')!.scrollHeight>el.closest('.task-board')!.clientHeight||document.querySelector('.task-workspace')!.scrollHeight>document.querySelector('.task-workspace')!.clientHeight)).toBe(true);
  expect((await list.boundingBox())!.y+(await list.boundingBox())!.height).toBeLessThanOrEqual((await list.locator('..').boundingBox())!.y+(await list.locator('..').boundingBox())!.height);
  const last=board.locator(`[data-task-id="${ids[0]}"]`);
  if(await last.locator('.progress-expand').getAttribute('aria-expanded')==='false')await last.locator('.progress-expand').click();await last.scrollIntoViewIfNeeded();
  await expect(last.getByRole('combobox')).toBeInViewport();
  await expect(last.locator('xpath=ancestor::section[1]').getByRole('heading')).toContainText('待处理');
  await last.getByRole('combobox').click();
  await expect(page.getByRole('option',{name:'进行中',exact:true})).toBeInViewport();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/mandala-task-compat/audit/2026-10-22-chat-cards-board/board-${width}.png`});
 }
});
test('board drag persists status without starting a run; completion and reopening need no confirmation',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'board-drag'},data:{goal:'拖动验收任务'}})).json();
 await page.goto('/tasks?type=tasks&view=board&q='+encodeURIComponent(task.goal));
 const card=page.locator(`[data-task-id="${task.id}"]`),running=page.getByRole('region',{name:'进行中与最近',exact:true});
 await expect(card).toHaveAttribute('draggable','true');
 await card.dragTo(running,{sourcePosition:{x:6,y:6}});
 await expect(running.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 let detail=await(await request.get('/api/v2/tasks/'+task.id)).json();expect(detail.task.state).toBe('running');expect(detail.runs).toHaveLength(0);
 await page.reload();await expect(running.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 await card.getByRole('link').click();await expect(page.getByRole('button',{name:'开始任务',exact:true})).toBeVisible();await expect(page.locator('.task-detail > .workspace-metadata').getByText('尚未运行',{exact:true})).toBeVisible();await page.goBack();
 await card.dragTo(page.getByRole('region',{name:'已完成',exact:true}),{sourcePosition:{x:6,y:6}});
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('region',{name:'已完成',exact:true}).locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 await card.dragTo(page.getByRole('region',{name:'需要你处理',exact:true}),{sourcePosition:{x:6,y:6}});await expect(page.getByRole('region',{name:'需要你处理',exact:true}).locator(`[data-task-id="${task.id}"]`)).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).runs).toHaveLength(0);
});
test('task progress preference is saved from creation and detail',async({page,request})=>{
 await page.goto('/tasks?action=create');await page.getByRole('button',{name:'手动填写',exact:true}).click();
 const editor=page.locator('.task-creation-panel:visible');await editor.getByLabel('任务标题',{exact:true}).fill('手动跟进');
 await editor.getByRole('switch',{name:/自动评估进度/}).uncheck();await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:'手动跟进',exact:true})).toBeVisible();
 await page.locator('.task-execution-options > summary').click();const control=page.getByRole('switch',{name:/自动评估进度/});await expect(control).not.toBeChecked();await control.check();
 await page.reload();await page.locator('.task-execution-options > summary').click();await expect(control).toBeChecked();
 const detail=await(await request.get('/api/v2/tasks/'+new URL(page.url()).pathname.split('/').at(-1))).json();expect(detail.task.automaticProgress).toBe(true);
});
test('board keyboard moves handle rejection and terminal reopen without starting execution',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'board-keyboard'},data:{goal:'键盘移动任务'}})).json();
 await page.goto('/tasks?type=tasks&view=board');
 await page.locator('[data-task-id="'+task.id+'"] .progress-expand').click();
 const move=page.getByRole('combobox',{name:'移动任务：键盘移动任务',exact:true});
 await page.route('**/api/v2/tasks/'+task.id+'/move',route=>route.request().method()==='POST'?route.fulfill({status:409,json:{error:'revision_conflict'}}):route.continue());
 await move.click();await page.getByRole('option',{name:'进行中',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('region',{name:'需要你处理',exact:true}).locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 await page.unroute('**/api/v2/tasks/'+task.id+'/move');
 await move.click();await page.getByRole('option',{name:'已取消',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'确认任务状态'})).toHaveCount(0);
 await page.goto('/tasks?type=tasks&view=board&state=all');await page.locator('[data-task-id="'+task.id+'"] .progress-expand').click();await move.click();await page.getByRole('option',{name:'待办',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('region',{name:'需要你处理',exact:true}).locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).runs).toHaveLength(0);
});
test('mac titlebar slots preserve accessible sidebar controls and no repeated branding',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(window,'mandalaDesktop',{value:{platform:'darwin'}}));
 await page.goto('/tasks');await expect(page.locator('.workspace-brand')).toHaveCount(0);
 const toggle=page.locator('#desktop-titlebar-left').getByRole('button',{name:'收起侧栏',exact:true});await expect(toggle).toBeVisible();await toggle.click();
 await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed','true');await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
 await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed','false');
 const titlebar=await page.locator('.desktop-titlebar').boundingBox(),button=await toggle.boundingBox();expect(titlebar!.height).toBe(48);expect(button!.y+button!.height/2).toBe(24);
 await page.goto('/assets');await expect(page.locator('main .content-navigation')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'导入文件',exact:true}).locator('svg')).toHaveCount(1);
});

test('mac narrow inspector focuses visible content, traps keyboard and restores the chat-bar trigger',async({page,request})=>{
 await page.addInitScript(()=>Object.defineProperty(window,'mandalaDesktop',{value:{platform:'darwin'}}));
 await page.setViewportSize({width:900,height:760});
 const chat=await(await request.post('/api/conversations',{data:{workspaceId:null}})).json();
 await page.goto('/?conversation='+chat.id+'&project=&agent=');
 const trigger=page.locator('.workspace-main').getByRole('button',{name:'展开右侧栏',exact:true});await trigger.click();
 const panel=page.locator('#chat-environment-panel');await expect(panel).toBeVisible();
 expect(await panel.evaluate(node=>node.contains(document.activeElement))).toBe(true);
 await page.keyboard.press('Shift+Tab');expect(await panel.evaluate(node=>node.contains(document.activeElement))).toBe(true);
 await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(trigger).toBeFocused();
});
