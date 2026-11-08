// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test.describe('Progress 用户目标验收',()=>{test('P39 late Progress response cannot overwrite a newer complete action or window selection',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await page.goto('/tasks?type=conversations');const card=page.locator('[data-conversation-id="'+d.long+'"]');await card.locator('.progress-expand').click();
 let release!:()=>void,captured!:()=>void;const held=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>captured=resolve);let hold=true;
 await page.route('**/api/conversation-progress?*',async route=>{if(!hold){await route.continue();return;}hold=false;const response=await route.fetch();captured();await held;await route.fulfill({response});});
 // A starts before completion. B is requested after the user changes the object/window.
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await ready;
 await card.getByRole('button',{name:'标记完成',exact:true}).click();await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();
 await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'最近使用窗口','240');await expect(page.getByRole('combobox',{name:'最近使用窗口',exact:true})).toHaveAttribute('data-value','240');release();
 await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();await page.reload();await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();

});});
