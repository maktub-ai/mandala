// spec: audit/2026-10-26-task-closure/official-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test.describe('Task creation-origin filtering',()=>{test('SRC-01 SRC-02 origin follows creator and persists across Board List details and reload',async({page,request})=>{
 // Prepare independent mixed sources; assignment is not creation provenance.
 await request.post('/__test__/progress-fixture');const d=await(await request.post('/__test__/progress-closure-fixture')).json();
 const card=(id:string)=>page.locator('[data-task-id="'+id+'"]');
 await page.goto('/tasks?type=tasks');await page.getByRole('button',{name:'筛选',exact:true}).click();
 // Show only user-created Tasks and exclude non-user and unknown historical Tasks.
 await chooseOption(page,'任务创建来源','user');await expect(card(d.userTask)).toBeVisible();
 await expect(card(d.agentTask)).toHaveCount(0);await expect(card(d.unknownTask)).toHaveCount(0);
 // Show Agent/system-created Tasks, retaining the same truthful Task identity in each view.
 await chooseOption(page,'任务创建来源','non-user');await expect(card(d.agentTask)).toBeVisible();await expect(card(d.userTask)).toHaveCount(0);
 await expect(card(d.systemTask)).toBeVisible();
 const visibleIds=await page.locator('[data-task-id]').evaluateAll(items=>items.map(item=>item.getAttribute('data-task-id')).sort());
 await page.getByRole('button',{name:'列表',exact:true}).click();await page.reload();await expect(card(d.agentTask)).toBeVisible();
 expect(await page.locator('[data-task-id]').evaluateAll(items=>items.map(item=>item.getAttribute('data-task-id')).sort())).toEqual(visibleIds);
 // Follow the actual Task title then return; do not use a direct details URL to prove navigation.
 await card(d.agentTask).getByRole('link',{name:/Agent 创建/}).click();await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();await expect(page).toHaveURL(/createdBy=non-user/);await page.getByRole('button',{name:'筛选',exact:true}).click();
 // Preserve unknown history as unknown, then combine search and reset via visible controls.
 await chooseOption(page,'任务创建来源','unknown');await expect(card(d.unknownTask)).toBeVisible();await expect(card(d.agentTask)).toHaveCount(0);
 await page.getByRole('searchbox',{name:'搜索任务与对话',exact:true}).fill('definitely-no-origin-match');await expect(page.locator('[data-task-id]')).toHaveCount(0);
 await page.getByRole('button',{name:'清除筛选',exact:true}).click();await expect(card(d.userTask)).toBeVisible();await expect(card(d.agentTask)).toBeVisible();
 // The compact sidebar retains only grouping/sorting controls; no source taxonomy is added there.
 await expect(page.locator('.conversation-library').getByRole('combobox')).toHaveCount(2);
});});
