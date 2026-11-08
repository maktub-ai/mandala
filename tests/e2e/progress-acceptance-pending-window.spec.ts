// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P39 PC04 pending completion acknowledgement reloads the latest selected window',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await request.post('/__test__/progress-age',{data:{id:d.long,ageMinutes:61}});await page.goto('/tasks?type=conversations&window=60');await expect(page.locator('[data-conversation-id="'+d.long+'"]')).toHaveCount(0);const card=page.locator('[data-conversation-id="'+d.recent+'"]');await card.locator('.progress-expand').click();
 let release!:()=>void,captured!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>captured=r);await page.route('**/api/conversation-progress/'+d.recent,async route=>{if(route.request().method()!=='POST'){await route.continue();return;}const response=await route.fetch();captured();await held;await route.fulfill({response});});const reads:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/conversation-progress')reads.push(new URL(r.url()).searchParams.get('windowMinutes')??'');});
 await card.getByRole('button',{name:'标记完成',exact:true}).click();await ready;try{if(await page.getByRole('button',{name:'筛选',exact:true}).getAttribute('aria-expanded')==='false')await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'最近使用窗口','240');}finally{release();}
 await expect(page.locator('[data-conversation-id="'+d.long+'"]')).toBeVisible();await expect.poll(()=>reads.at(-1)).toBe('240');await expect(page.getByRole('combobox',{name:'最近使用窗口',exact:true})).toHaveAttribute('data-value','240');await expect(page.getByRole('region',{name:'已完成',exact:true}).locator('[data-conversation-id="'+d.recent+'"]')).toBeVisible();

});});
