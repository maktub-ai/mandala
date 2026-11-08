// spec: specs/progress-acceptance-plan.md P04
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {isolateProgressLists} from './helpers/progress-acceptance';
import {chooseOption} from './helpers/select';
test.describe('Progress 用户目标验收',()=>{
 test('P04 scope-only and Task-state-only zero results identify filters and recover',async({page,request})=>{
  // Existing work excludes the first-use empty state.
  const data=await(await request.post('/__test__/progress-fixture')).json();await isolateProgressLists(page,data);await page.goto('/tasks');
  await expect(page.locator('[data-task-id="'+data.task+'"]')).toBeVisible();await page.getByRole('button',{name:'筛选',exact:true}).click();
  // Scope alone must show a filtered empty state and a visible way back.
  await chooseOption(page,'可见范围','completed');await expect(page.getByRole('heading',{name:'当前筛选下没有任务',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'可见范围',exact:true})).toHaveAttribute('data-value','completed');
  await chooseOption(page,'可见范围','active');await expect(page.locator('[data-task-id="'+data.task+'"]')).toBeVisible();
  // Task state alone cannot masquerade as a brand-new workspace.
  await chooseOption(page,'显示类型','tasks');await chooseOption(page,'任务状态','cancelled');
  await expect(page.getByRole('heading',{name:'当前筛选下没有任务',exact:true})).toBeVisible();
  await chooseOption(page,'任务状态','active');await expect(page.locator('[data-task-id="'+data.task+'"]')).toBeVisible();
  expect((await(await request.get('/api/v2/tasks/'+data.task)).json()).runs).toHaveLength(0);
 });
});
