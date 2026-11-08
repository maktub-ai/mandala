// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test.describe('Progress 用户目标验收',()=>{test('P03 owner and project filters use each root identity and preserve matching orphaned chat',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const before=await(await request.get('/api/v2/tasks/'+d.task)).json();expect((await request.patch('/api/v2/tasks/'+d.task,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:before.task.revision,assigneeAgentId:'progress-reviewer'}})).ok()).toBe(true);
 await page.goto('/tasks');await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'进度项目','progress-demo');await chooseOption(page,'进度负责人','progress-planner');
 await expect(page.locator('[data-task-id="'+d.task+'"]')).toHaveCount(0);await expect(page.locator('[data-conversation-id="'+d.recent+'"]')).toBeVisible();await expect(page.locator('[data-conversation-id="'+d.running+'"]')).toHaveCount(0);
 await chooseOption(page,'进度负责人','progress-reviewer');const parent=page.locator('[data-task-id="'+d.task+'"]');await expect(parent).toBeVisible();await parent.locator('.progress-expand').click();await expect(parent.locator('[data-linked-conversation-id="'+d.recent+'"]')).toBeVisible();await chooseOption(page,'显示类型','conversations');await expect(page.locator('[data-conversation-id="'+d.recent+'"]')).toHaveCount(0);
 expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).task.conversationIds).toEqual([d.recent]);

});});
