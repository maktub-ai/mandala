import {expect,test} from '@playwright/test';
for(const mode of ['light','dark'])for(const width of [1440,1024,768,390])test(`task list/detail and Kanban remain usable ${mode} ${width}`,async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:900});
 await page.goto('/tasks/'+fixture.goalId+'?scope=all&view=list');await expect(page.locator('.task-detail .task-title')).toContainText('Long operational goal');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`task-detail-${mode}-${width}.png`)});
 await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'看板',exact:true}).click();await page.locator('.progress-overview-board .task-work-heading a').first().click();await expect(page.locator('.task-dialog')).toBeVisible();
 await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('.progress-overview-board')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`task-board-${mode}-${width}.png`)});
});
