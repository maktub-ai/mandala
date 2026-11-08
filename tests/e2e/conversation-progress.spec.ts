import {expect,test} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {chooseOption} from './helpers/select';
const shots='/tmp/mandala-task-compat/superpowers/conversation-progress';
test('viewing yesterday\'s chat keeps it in history until real work resumes',async({page,request})=>{
 const {stale}=await(await request.post('/__test__/progress-fixture')).json();
 expect((await request.get('/api/conversation-progress')).ok()).toBe(true);
 const {at}=await(await request.post('/__test__/progress-age',{data:{id:stale,ageMinutes:1500}})).json();
 const visit=page.waitForResponse(r=>r.url().endsWith('/api/conversation-progress/'+stale)&&r.request().method()==='POST');
 await page.goto('/?conversation='+stale);expect((await visit).ok()).toBe(true);
 await page.locator('.sidebar a[href="/tasks"]').click();
 const card=page.locator('[data-conversation-id="'+stale+'"]');
 await expect(card).toHaveCount(0);
 await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'可见范围','all');
 await expect(card).toBeVisible();await expect(card.locator('time')).toHaveAttribute('datetime',at);
 await expect(card.locator('time')).toHaveAttribute('title',/^最后消息：/);
 await expect(card.locator('time')).not.toContainText('刚刚');
 await page.getByRole('button',{name:'看板',exact:true}).click();
 await expect(card.locator('time')).toHaveAttribute('datetime',at);
 await page.reload();await expect(card.locator('time')).toHaveAttribute('datetime',at);
 await expect(card).toContainText('最近使用');
 await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'可见范围','active');await expect(card).toHaveCount(0);
 expect((await request.post('/__test__/progress-update',{data:{id:stale,kind:'new'}})).ok()).toBe(true);
 await expect(card).toContainText('执行中');
});
test('standalone objective activity, list/board and independent completion survive late replies',async({page,request})=>{
 const result=await request.post('/__test__/progress-fixture');expect(result.ok()).toBe(true);const {recent,running,waiting,stale,expiredError,expiredInterrupted,task}=await result.json();
 await page.goto('/tasks?tab=conversations&view=board');
 await expect(page.getByRole('heading',{name:'任务',exact:true})).toBeVisible();
 const board=page.getByRole('region',{name:'进度看板',exact:true});
 await expect(board.locator('[data-conversation-id="'+running+'"]')).toContainText('执行中');
 await expect(board.locator('[data-conversation-id="'+waiting+'"]')).toContainText('等待协作');
 await expect(board.locator('[data-conversation-id="'+stale+'"]')).toHaveCount(0);
 await expect(board.locator('[data-conversation-id="'+expiredError+'"]')).toHaveCount(0);await expect(board.locator('[data-conversation-id="'+expiredInterrupted+'"]')).toHaveCount(0);
 const card=board.locator('[data-conversation-id="'+recent+'"]');await card.locator('.progress-expand').click();await expect(card.getByRole('link',{name:'发布计划',exact:true})).toBeVisible();
 await card.dragTo(page.getByRole('region',{name:'已完成',exact:true}));
 await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+recent+'"]')).toBeVisible();
 expect((await(await request.get('/api/v2/tasks/'+task)).json()).task.state).toBe('todo');
 expect((await request.post('/__test__/progress-update',{data:{id:recent,kind:'late'}})).ok()).toBe(true);
 await page.reload();const completed=page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+recent+'"]');await expect(completed).toContainText('有新进展');
 await completed.dragTo(page.getByRole('region',{name:'已完成',exact:true}));await expect(completed).toContainText('有新进展');await completed.locator('.progress-expand').click();await completed.getByRole('button',{name:'重新打开',exact:true}).click();await expect(board.locator('[data-conversation-id="'+recent+'"]')).toContainText('执行中');
 await page.getByRole('button',{name:'列表',exact:true}).click();await expect(page.getByRole('region',{name:'进度列表',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'可见范围','all');await expect(page.locator('[data-conversation-id="'+stale+'"]')).toBeVisible();
 mkdirSync(shots,{recursive:true});await page.screenshot({path:shots+'/list.png',fullPage:true});
});
test('progress renders narrow English and dark board without page overflow, keeps Task route usable',async({page,request})=>{
 expect((await request.post('/__test__/progress-fixture')).ok()).toBe(true);
 await page.goto('/tasks?tab=conversations&view=board');await page.evaluate(()=>{localStorage.setItem('mana-language','en');localStorage.setItem('mana-theme','dark');});await page.reload();
 await expect(page.getByRole('heading',{name:'Tasks',exact:true})).toBeVisible();mkdirSync(shots,{recursive:true});await page.screenshot({path:shots+'/board-dark.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('region',{name:'Progress board',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.locator('.progress-overview-board').evaluate(el=>{const groups=[...el.children].map(group=>group.getBoundingClientRect());return groups.every(group=>group.width>=240&&Math.abs(group.top-groups[0].top)<2);})).toBe(true);await page.screenshot({path:shots+'/mobile.png',fullPage:true});
 await chooseOption(page,'Show types','tasks');await expect(page.getByRole('heading',{name:'Tasks',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'New task',exact:true})).toBeVisible();
});
test('progress provides a filter empty state and retry after a failed refresh',async({page,request})=>{
 expect((await request.post('/__test__/progress-fixture')).ok()).toBe(true);
 let fail=true;await page.route('**/api/conversation-progress?*',route=>fail?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic unavailable'})}):route.continue());
 await page.goto('/tasks?tab=conversations');await expect(page.getByRole('alert')).toContainText('无法刷新进度');
 // A failed initial read cannot assert that this workspace has no work.
 await expect(page.getByRole('heading',{name:'从一次对话或任务开始',exact:true})).toHaveCount(0);await expect(page.locator('.progress-empty')).toHaveCount(0);
 fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByRole('searchbox',{name:'搜索任务与对话',exact:true}).fill('No matching synthetic work');await expect(page.getByRole('heading',{name:'当前筛选下没有任务',exact:true})).toBeVisible();
});
test('an untitled conversation without Agent, Project or Task remains visible with an empty search',async({page,request})=>{
 const created=await request.post('/api/conversations',{data:{projectId:'',agentId:'',workspaceId:null}});expect(created.ok()).toBe(true);const chat=await created.json();
 await page.goto('/tasks?tab=conversations&view=board');const card=page.locator('[data-conversation-id="'+chat.id+'"]');
 await expect(card).toBeVisible();await expect(card.getByRole('link',{name:'未命名对话',exact:true})).toBeVisible();
});

test('one panel mixes Tasks and conversations and filters their type without switching panels',async({page,request})=>{
 const result=await request.post('/__test__/progress-fixture');const {recent,task}=await result.json();await page.goto('/tasks?view=board');
 const panel=page.getByRole('region',{name:'进度看板',exact:true});await expect(panel.locator('[data-conversation-id="'+recent+'"]')).toHaveCount(0);await expect(panel.locator('[data-task-id="'+task+'"]')).toBeVisible();
 await chooseOption(page,'显示类型','conversations');await expect(panel.locator('[data-conversation-id="'+recent+'"]')).toBeVisible();await expect(panel.locator('[data-task-id]')).toHaveCount(0);
 await chooseOption(page,'显示类型','tasks');await expect(panel.locator('[data-task-id="'+task+'"]')).toBeVisible();await expect(panel.locator('[data-conversation-id]')).toHaveCount(0);
 await chooseOption(page,'显示类型','all');await expect(panel.locator('[data-conversation-id="'+recent+'"]')).toHaveCount(0);await expect(panel.locator('[data-task-id="'+task+'"]')).toBeVisible();
 await page.getByRole('button',{name:'列表',exact:true}).click();const list=page.getByRole('region',{name:'进度列表',exact:true});await expect(list.locator('[data-conversation-id="'+recent+'"]')).toHaveCount(0);await expect(list.locator('[data-task-id="'+task+'"]')).toBeVisible();await list.locator('[data-task-id="'+task+'"]').scrollIntoViewIfNeeded();expect(await list.locator('[data-task-id="'+task+'"]').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('main')!.getBoundingClientRect().bottom)).toBe(true);
});

test('reference-inspired compact overview keeps three readable columns and expands full long titles',async({page,request})=>{
 const data=await(await request.post('/__test__/progress-fixture')).json();await page.setViewportSize({width:1280,height:900});await page.goto('/tasks?view=board');const board=page.getByRole('region',{name:'进度看板',exact:true});
 await expect(board.locator(':scope > section')).toHaveCount(3);expect(await board.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const card=board.locator('[data-conversation-id="'+data.long+'"]'),title=card.locator('.progress-item-title');await expect(title).toHaveAttribute('title',data.longTitle);await expect(title).toHaveText(data.longTitle.slice(0,80)+'…');
 expect((await card.boundingBox())!.width).toBeGreaterThanOrEqual(220);expect((await card.boundingBox())!.height).toBeLessThanOrEqual(210);
 await card.locator('.progress-expand').click();await expect(card.locator('.progress-expand')).toHaveAttribute('aria-expanded','true');await expect(title).toHaveText(data.longTitle);expect(await title.evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
 await expect(page.getByRole('combobox',{name:'可见范围',exact:true})).toBeHidden();await page.getByRole('button',{name:'筛选',exact:true}).click();await expect(page.getByRole('combobox',{name:'可见范围',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'列表',exact:true}).click();const row=page.getByRole('region',{name:'进度列表',exact:true}).locator('[data-conversation-id="'+data.long+'"]');expect((await row.boundingBox())!.width).toBeGreaterThan(800);expect(await page.locator('.progress-groups').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.task-legacy-rules')!.getBoundingClientRect().top+1)).toBe(true);
});


test('Progress navigation matches the page name in both languages',async({page})=>{
 await page.goto('/tasks');
 await expect(page.locator('.sidebar a[href="/tasks"]')).toHaveText('任务');await expect(page.getByRole('heading',{name:'任务',exact:true})).toBeVisible();
 await page.evaluate(()=>localStorage.setItem('mana-language','en'));await page.reload();
 await expect(page.locator('.sidebar a[href="/tasks"]')).toHaveText('Tasks');await expect(page.getByRole('heading',{name:'Tasks',exact:true})).toBeVisible();
});
test('Tasks defaults to list and remembers view selection across reload and navigation',async({page})=>{
 await page.goto('/tasks');await expect(page.getByRole('button',{name:'列表',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'看板',exact:true}).click();await page.reload();await expect(page.getByRole('button',{name:'看板',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.goto('/agents');await page.locator('.sidebar a[href="/tasks"]').click();await expect(page.getByRole('button',{name:'看板',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'列表',exact:true}).click();await page.goto('/tasks');await expect(page.getByRole('button',{name:'列表',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.goto('/tasks?view=list');await expect(page.getByRole('button',{name:'列表',exact:true})).toHaveAttribute('aria-pressed','true');await page.goto('/tasks?view=board');await expect(page.getByRole('button',{name:'看板',exact:true})).toHaveAttribute('aria-pressed','true');
});
test('Progress type labels fit in English at desktop and mobile sizes',async({page})=>{
 await page.goto('/tasks');await page.evaluate(()=>localStorage.setItem('mana-language','en'));await page.reload();
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});
  for(const value of ['all','conversations','tasks']){
   await chooseOption(page,'Show types',value);const label=page.getByRole('combobox',{name:'Show types',exact:true}).locator(':scope > span');
   expect(await label.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }
});

test('English completed cards keep new activity and Details inside the card',async({page,request})=>{
 const {recent}=await(await request.post('/__test__/progress-fixture')).json();expect((await request.post('/api/conversation-progress/'+recent,{data:{action:'complete'}})).ok()).toBe(true);expect((await request.post('/__test__/progress-update',{data:{id:recent,kind:'late'}})).ok()).toBe(true);
 await page.goto('/tasks?type=conversations');await page.evaluate(()=>localStorage.setItem('mana-language','en'));await page.reload();const card=page.locator('[data-conversation-id="'+recent+'"]');await expect(card).toContainText('New activity');
 expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await card.locator('.progress-expand').click();await expect(card.getByRole('button',{name:'Reopen',exact:true})).toBeVisible();
});
