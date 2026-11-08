import {expect,test} from '@playwright/test';
test.use({hasTouch:true,viewport:{width:390,height:844}});
test('small identity artwork retains usable touch targets in task and configuration cards',async({page,request},info)=>{
 await request.post('/__test__/mandala-panels');await page.goto('/tasks?scope=all&type=tasks');
 const card=page.locator('.task-work-card').first();await expect(card).toBeVisible();
 for(const link of [card.locator('.task-work-heading > a')]){
  await expect(link).toBeVisible();const box=await link.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.width).toBeGreaterThanOrEqual(44);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await request.post('/__test__/operation-cards');await page.goto('/mandala');
 const config=page.getByRole('region',{name:'配置操作结果',exact:true}).last();await config.locator(':scope > details > summary').click();
 const name=config.getByRole('link',{name:'资料整理助手 1',exact:true});await expect(name).toBeVisible();expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 const changes=config.locator('.operation-change-disclosure > summary').first();expect((await changes.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('touch-cards.png'),fullPage:true});
});
