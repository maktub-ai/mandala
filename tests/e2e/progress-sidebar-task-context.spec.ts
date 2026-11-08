import {test,expect} from '@playwright/test';

// User screenshot: 1201px window, 400px sidebar and an open Task context.
for(const width of [1201,1600])test(`Task context preserves reading space and keyboard return at ${width}px`,async({page,request})=>{
 await page.addInitScript(()=>{localStorage.setItem('mana-language','en');localStorage.setItem('mana-sidebar-layout',JSON.stringify({width:400,collapsed:false}));});
 const fixture=await(await request.post('/__test__/progress-fixture')).json();
 await page.setViewportSize({width,height:900});await page.goto('/tasks');
 await page.locator('[data-task-id="'+fixture.task+'"]').locator('.progress-item-title').click();
 await expect(page.locator('.task-detail h1')).toHaveText('发布计划');
 const trigger=page.getByRole('button',{name:'View Task context',exact:true});
 const primary=page.locator('.workspace-primary'),before=(await primary.boundingBox())!.width;
 await expect(trigger).toHaveAttribute('aria-expanded','false');
 await trigger.click();await expect(trigger).toHaveAttribute('aria-expanded','true');
 const panel=page.getByRole(width===1201?'dialog':'region',{name:'Task context',exact:true});
 await expect(panel).toBeVisible();
 if(width===1201){
  expect((await primary.boundingBox())!.width).toBeGreaterThanOrEqual(before-1);
  await expect(panel.getByRole('button',{name:'Collapse information',exact:true})).toBeFocused();
  await expect(page.locator('.workspace-primary')).toHaveJSProperty('inert',true);
 }else expect((await primary.boundingBox())!.width).toBeGreaterThanOrEqual(640);
 await page.screenshot({path:`audit/2026-10-24-sidebar-correction/context-${width}.png`,fullPage:true});
 await panel.getByRole('button',{name:'Collapse information',exact:true}).focus();
 await page.keyboard.press('Escape');await expect(panel).not.toBeVisible();await expect(trigger).toBeFocused();
 await expect(page.locator('.workspace-primary')).not.toHaveJSProperty('inert',true);
 const current=await(await request.get('/api/v2/tasks/'+fixture.task)).json();
 expect(current.task.state).toBe('todo');expect(current.runs).toHaveLength(0);
});
