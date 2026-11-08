// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P14 completed Task detail reopens directly without asking for a reason or creating execution',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const t=await(await request.get('/api/v2/tasks/'+d.task)).json();await request.post('/api/v2/tasks/'+d.task+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:t.task.revision,state:'completed'}});
 await page.goto('/tasks');await page.locator('[data-task-id="'+d.task+'"] .task-work-heading > a').click();await page.getByRole('button',{name:'更多任务操作',exact:true}).click();await page.getByRole('menuitem',{name:'编辑任务',exact:true}).click();await expect(page.getByRole('button',{name:'重新打开',exact:true})).toBeDisabled();await page.getByRole('button',{name:'取消编辑',exact:true}).click();await page.getByRole('button',{name:'重新打开',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'原因',exact:true})).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+d.task)).json()).task.state).toBe('todo');expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).runs).toHaveLength(0);
 await page.locator('.task-breadcrumb a').click();await expect(page.getByRole('region',{name:'待办',exact:true}).locator('[data-task-id="'+d.task+'"]')).toBeVisible();

});});
