// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P06 PC01 browser Back traverses Progress filter history instead of re-pushing the remembered route',async({page,request})=>{

 await request.post('/__test__/progress-fixture');await page.goto('/agents');await page.locator('.sidebar a[href="/tasks"]').click();await expect(page).toHaveURL(/\/tasks$/);await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'进度项目','progress-demo');await expect(page).toHaveURL(/project=progress-demo/);
 await page.goBack();await expect(page).toHaveURL(/\/tasks$/);await page.goBack();await expect(page).toHaveURL(/\/agents$/);await page.goForward();await expect(page).toHaveURL(/\/tasks$/);

});});
