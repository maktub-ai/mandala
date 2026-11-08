// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P05 visible request excerpt is searchable without changing type or Task relationships',async({page,request})=>{

 // Match visible request content rather than a title that happens to share it.
 const d=await(await request.post('/__test__/progress-fixture')).json();await page.goto('/tasks?type=conversations');
 await expect(page.locator('[data-conversation-id="'+d.running+'"]')).toContainText('相关测试是否通过');
 await page.getByRole('searchbox',{name:'搜索任务与对话',exact:true}).fill('相关测试是否通过');
 await expect(page.locator('[data-conversation-id="'+d.running+'"]')).toBeVisible();await expect(page.locator('[data-conversation-id="'+d.long+'"]')).toHaveCount(0);
 await page.getByRole('searchbox',{name:'搜索任务与对话',exact:true}).fill('NoSuchProgressRequest');await expect(page.getByRole('heading',{name:'当前筛选下没有任务',exact:true})).toBeVisible();
 await page.getByRole('searchbox',{name:'搜索任务与对话',exact:true}).clear();await expect(page.locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();
 expect((await(await request.get('/api/v2/tasks/'+d.task)).json()).task.conversationIds).toEqual([d.recent]);

});});
