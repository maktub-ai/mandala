import {test,expect} from '@playwright/test';
// Isolated synthetic source server; no personal runtime or data is used.
test('Progress acceptance seed',async({page,request})=>{
 const fixture=await request.post('/__test__/progress-fixture');expect(fixture.ok()).toBe(true);
 await page.goto('/');await page.getByRole('link',{name:'任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:'任务',exact:true})).toBeVisible();
});
