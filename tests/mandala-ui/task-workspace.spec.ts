import {expect,test} from '@playwright/test';
import {isolateProgressLists} from '../e2e/helpers/progress-acceptance';

test('independent approvals remain reachable in the conversation sidebar outside Tasks',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/progress-fixture')).json();
 const approval=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-engineer',cli:'codex'}})).json();
 await request.post('/api/conversations/'+approval.id+'/messages',{data:{text:'approval'}});
 await expect.poll(async()=>(await(await request.get('/api/conversations/'+approval.id)).json()).approvals.length).toBe(1);
 await isolateProgressLists(page,{...fixture,approval:approval.id});
 const before=await(await request.get('/api/v2/tasks/'+fixture.task)).json();
 await page.goto('/tasks?view=list');
 await expect(page.locator('.progress-other-chats')).toHaveCount(0);
 const source=page.locator('.conversation-library button.library-open[aria-describedby*="library-context-'+approval.id+'"]');
 await expect(source.locator('.library-status-icon.approval')).toBeVisible();await source.click();
 await expect(page.getByRole('button',{name:'允许本次',exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('independent-approval.png')});
 expect((await(await request.get('/api/v2/tasks/'+fixture.task)).json()).task).toEqual(before.task);
 expect((await(await request.get('/api/conversations/'+approval.id)).json()).approvals).toHaveLength(1);
});

test('cancel remains available when task content permission is revoked but control access remains',async({page,request})=>{
 const created=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Revoked content control'}})).json();
 await page.route('**/api/v2/tasks/'+created.id,route=>route.request().method()==='GET'?route.fulfill({status:403,json:{error:'forbidden'}}):route.continue());
 await page.goto('/tasks/'+created.id);await expect(page.getByRole('heading',{name:'任务内容不可访问',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'更多任务操作',exact:true}).click();await page.getByRole('menuitem',{name:'取消任务',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+created.id+'/control')).json()).state).toBe('cancelled');
});

test('list and Kanban keep task relationships, filters and a shared detail without changing data',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 const standalone=await(await request.post('/api/conversations',{data:{projectId:fixture.projectId,agentId:fixture.agentId,cli:'codex'}})).json();
 const before=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();
 await page.goto('/tasks?scope=all&view=list');
 await expect(page.locator('[data-task-id="'+fixture.goalId+'"]')).toHaveCount(1);
 const expand=page.getByRole('button',{name:'展开已完成任务',exact:true});if(await expand.count())await expand.click();
 const card=page.locator('.task-work-card').filter({has:page.getByRole('link',{name:before.task.goal,exact:true})});
 await expect(card).toHaveCount(1);await expect(card.locator('.task-work-related')).toHaveCount(1);
 await card.locator('.task-work-related > summary').click();await expect(card.locator('.execution-chat-link')).toHaveCount(1);await card.locator('.task-work-related > summary').click();
 await expect(page.locator('[data-conversation-id="'+standalone.id+'"]')).toHaveCount(0);
 await card.getByRole('link',{name:before.task.goal,exact:true}).click();
 await expect(page.getByRole('heading',{name:before.task.goal,exact:true})).toBeVisible();
 await expect(page.locator('.task-detail .task-children')).toBeHidden();
 await expect(page.getByRole('heading',{name:'交付结果',exact:true})).toBeVisible();
 await page.locator('.task-execution-process > summary').click();
 await expect(page.locator('.task-run-history')).toBeVisible();
 await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'看板',exact:true}).click();await page.locator('.progress-overview-board .task-work-heading a').first().click();await expect(page.locator('.task-dialog')).toBeVisible();
 await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page).toHaveURL(/view=board/);await expect(page.locator('.progress-overview-board')).toBeVisible();
 await page.getByRole('searchbox',{name:'搜索任务',exact:true}).fill('Long operational goal');
 await expect(page.locator('.task-work-card')).toHaveCount(1);
 await page.getByRole('button',{name:'列表',exact:true}).click();await expect(page.getByRole('searchbox',{name:'搜索任务',exact:true})).toHaveValue('Long operational goal');
 await page.reload();await expect(page.getByRole('searchbox',{name:'搜索任务',exact:true})).toHaveValue('Long operational goal',{timeout:15000});await expect(page.locator('.task-work-card')).toHaveCount(1);
 const after=await(await request.get('/api/v2/tasks/'+fixture.goalId)).json();expect(after.task).toEqual(before.task);expect(after.executions.map((execution:{id:string})=>execution.id)).toEqual(before.executions.map((execution:{id:string})=>execution.id));
});

test('Mandala task panel preserves chat scope and reference actions',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();await page.goto('/mandala');
 const panel=page.locator('.mandala-panels'),toggle=page.getByRole('button',{name:/^(展开右侧栏|收起右侧栏)$/});await expect(toggle).toBeVisible();if(await toggle.getAttribute('aria-label')==='展开右侧栏')await toggle.click();await expect(panel).toBeVisible();
 await expect(panel.getByRole('button',{name:/^本对话 /})).toHaveAttribute('aria-pressed','true');
 const expand=panel.getByRole('button',{name:'展开已完成任务',exact:true});if(await expand.count())await expand.click();
 await expect(panel.getByRole('button',{name:/^引用 接通跨项目/})).toBeEnabled();
 const title=panel.locator('.task-work-heading > a').filter({hasText:'Long operational goal'});await expect(title).toHaveCount(1);expect(await title.evaluate(node=>node.getBoundingClientRect().height<=2*parseFloat(getComputedStyle(node).lineHeight)+1)).toBe(true);
 await expect(panel.locator('.progress-groups')).toBeVisible();
 await panel.getByRole('textbox',{name:'搜索跟进目标',exact:true}).fill('不存在的目标');await expect(panel.locator('.task-work-card')).toHaveCount(0);
 await panel.getByRole('textbox',{name:'搜索跟进目标',exact:true}).fill('Long operational goal');await expect(panel.locator('.task-work-card')).toHaveCount(1);
 expect((await(await request.get('/api/mandala/goals')).json()).some((goal:{taskId:string})=>goal.taskId===fixture.goalId)).toBe(true);
});
