// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P38 filter menus preserve keyboard focus selection and dismissal at narrow width',async({page,request})=>{

 await request.post('/__test__/progress-fixture');await page.setViewportSize({width:390,height:844});await page.goto('/tasks');const type=page.getByRole('combobox',{name:'显示类型',exact:true});
 // Keyboard opens, chooses an option, dismisses without leaving a trapped portal.
 await type.focus();await page.keyboard.press('Enter');await expect(page.getByRole('listbox')).toBeVisible();await page.keyboard.press('End');await page.keyboard.press('Enter');await expect(type).toHaveAttribute('data-value','tasks');await expect(type).toBeFocused();
 await type.press('Enter');await page.keyboard.press('Home');await page.keyboard.press('Escape');await expect(page.getByRole('listbox')).toHaveCount(0);await expect(type).toBeFocused();await page.keyboard.press('Tab');await expect(type).not.toBeFocused();
 await page.getByRole('button',{name:'筛选',exact:true}).click();const state=page.getByRole('combobox',{name:'任务状态',exact:true});await state.scrollIntoViewIfNeeded();await state.press('Enter');await expect(page.getByRole('listbox')).toBeInViewport();await page.keyboard.press('Escape');await expect(state).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

});});
