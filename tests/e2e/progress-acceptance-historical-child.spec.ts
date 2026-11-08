// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P10 historical linked chats are context rather than active roots and identify their age',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();expect((await request.post('/__test__/progress-age',{data:{id:d.recent,ageMinutes:2880}})).ok()).toBe(true);
 for(const view of ['board','list']){await page.goto('/tasks?view='+view);const parent=page.locator('[data-task-id="'+d.task+'"]');await parent.locator('.progress-expand').click();const child=parent.locator('[data-linked-conversation-id="'+d.recent+'"]');await expect(child).toContainText('历史');await expect(page.locator('[data-conversation-id="'+d.recent+'"]')).toHaveCount(0);await expect(child).toHaveAttribute('href','/?conversation='+d.recent);}
 expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).runs).toHaveLength(0);

});});
