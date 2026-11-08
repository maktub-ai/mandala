import {test,expect} from '@playwright/test';
import {defaultPreferences} from '../../src/themes';
for(const [width,theme,language] of [[1600,'light','en'],[768,'dark','zh-CN'],[390,'dark','en']] as const)test('V1 complete filter values and keyboard menu '+width+' '+theme,async({page,request})=>{
 await page.addInitScript(({theme,language})=>{localStorage.setItem('mandala-appearance-v1',JSON.stringify(theme));localStorage.setItem('mana-language',language);},{theme:{...defaultPreferences(theme),mode:theme},language});
 await page.setViewportSize({width,height:900});await request.post('/__test__/progress-fixture');await page.goto('/tasks');
 await page.getByRole('button',{name:language==='en'?'Filters':'筛选',exact:true}).click();
 const labels=await page.locator('#progress-filters .ui-select-trigger > span').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,width:n.clientWidth,required:n.scrollWidth})));
 expect(labels).toHaveLength(7);for(const label of labels)expect(label.required,JSON.stringify(label)).toBeLessThanOrEqual(label.width+1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
 const source=page.getByRole('combobox',{name:language==='en'?'Task created by':'任务创建来源',exact:true});await source.focus();await page.keyboard.press('Enter');await expect(page.getByRole('listbox')).toBeVisible();await page.keyboard.press('Escape');await expect(source).toBeFocused();
 await page.screenshot({path:'/tmp/mandala-task-compat/audit/2026-10-26-task-closure/layout-'+width+'-'+theme+'.png',fullPage:true});
 await page.getByRole('searchbox',{name:language==='en'?'Search tasks and chats':'搜索任务与对话',exact:true}).fill('no-such-progress-item-closure');
 await expect(page.locator('.progress-overview-board')).toHaveCount(0);const clear=page.getByRole('button',{name:language==='en'?'Clear filters':'清除筛选',exact:true});await clear.scrollIntoViewIfNeeded();await expect(clear).toBeInViewport();
 await page.screenshot({path:'/tmp/mandala-task-compat/audit/2026-10-26-task-closure/empty-'+width+'-'+theme+'.png',fullPage:true});
});
