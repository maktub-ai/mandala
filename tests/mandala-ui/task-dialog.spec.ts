import {expect,test} from '@playwright/test';
test('task detail opens as one dialog from Mandala and the Tasks page',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();
 await page.setViewportSize({width:1440,height:900});await page.goto('/mandala');
 const panel=page.locator('.mandala-panels'),dialog=page.locator('.task-dialog');
 await panel.getByRole('link',{name:/Long operational goal/}).first().click();
 await expect(dialog.locator('.task-detail .task-title')).toContainText('Long operational goal');
 await expect(page).toHaveURL(/\/mandala\?/);
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page).toHaveURL(/\/mandala\?/);
 await panel.getByRole('link',{name:/Long operational goal/}).first().click();
 await dialog.getByRole('button',{name:'在任务页打开',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('/tasks/'+fixture.goalId));await expect(dialog.locator('.task-detail .task-title')).toContainText('Long operational goal');
 await expect(dialog.getByRole('button',{name:'在任务页打开',exact:true})).toHaveCount(0);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(page).toHaveURL(/\/tasks(\?|$)/);await expect(dialog).toHaveCount(0);
});

test('the project chip on a Mandala task row opens the project, not a new project chat',async({page,request})=>{
 const fixture=await(await request.post('/__test__/mandala-panels')).json();await page.goto('/mandala');
 const chip=page.locator('.mandala-panels .task-work-card a.task-work-project').first();
 await expect(chip).toHaveAttribute('href','/projects/'+encodeURIComponent(fixture.projectId)+'/overview');
 await chip.click();await expect(page).toHaveURL(/\/projects\/[^/]+\/overview$/);
});
