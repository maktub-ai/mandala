// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P40 stale Task revision reports conflict and refreshes without overwriting external state',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const detail=await(await request.get('/api/v2/tasks/'+d.task)).json();await page.goto('/tasks?type=tasks');const card=page.locator('[data-task-id="'+d.task+'"]');await card.locator('.progress-expand').click();
 const old=await(await request.get('/api/v2/tasks/'+d.task+'/control')).json();await page.route('**/api/v2/tasks/'+d.task+'/control',route=>route.fulfill({json:old}));
 // A different window updates the exact same Task after this page has rendered it.
 expect((await request.post('/api/v2/tasks/'+d.task+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:detail.task.revision,state:'running'}})).ok()).toBe(true);
 const failed=page.waitForResponse(r=>r.url().endsWith('/'+d.task+'/move')&&r.status()===409);await card.getByRole('combobox',{name:'移动任务：发布计划',exact:true}).click();await page.locator('[role=option][data-value=completed]').click();await failed;await expect(page.getByRole('alert')).toBeVisible();
 const final=await(await request.get('/api/v2/tasks/'+d.task)).json();expect(final.task.state).toBe('running');expect(final.task.revision).toBe(detail.task.revision+1);expect(final.runs).toHaveLength(0);await page.reload();await expect(page.getByRole('region',{name:'进行中与最近',exact:true}).locator('[data-task-id="'+d.task+'"]')).toBeVisible();

});});
