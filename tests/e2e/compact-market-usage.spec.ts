import {test,expect} from '@playwright/test';
import {setAppearanceMode} from './helpers/navigation';
import {storedUiState} from './helpers/preferences';
import {summary,config} from '../fixtures/usage-dashboard';
test.use({storageState:storedUiState('en')});
test('compact Market exposes catalog cards and usable dialogs in both themes at four widths',async({page,request})=>{
 const sources=await(await request.get('/api/market/sources')).json();await request.put('/api/market/sources',{data:{revision:sources.revision,sources:[],enabled:['clawhub','anthropic','mcp-registry']}});
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,agents:[{id:'compact-market-review',name:'跨项目资料与引用复核 · Long bilingual review Agent',instructions:'Synthetic review',defaultCli:'codex',models:{},mcp:[],skills:[]}],projects:[]}}});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/market');await expect(page.locator('.market-card')).toHaveCount(3);await expect(page.getByRole('button',{name:'Manage sources',exact:true})).toBeEnabled();
 for(const theme of ['light','dark'] as const){await setAppearanceMode(page,theme);for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:950});await expect(page.getByRole('button',{name:'Manage sources',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width>=1024){const first=(await page.locator('.market-card').first().boundingBox())!;expect(first.y).toBeLessThan(240);expect(first.height).toBeGreaterThanOrEqual(180);const second=(await page.locator('.market-card').nth(1).boundingBox())!;expect(second.y).toBe(first.y);expect(second.x).toBeGreaterThan(first.x+first.width);}
  await page.screenshot({path:`/tmp/compact-market-${theme}-${width}.png`});
  await page.getByRole('button',{name:'View details synthetic-reading',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'Install',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Agent · 跨项目资料与引用复核 · Long bilingual review Agent',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`/tmp/compact-market-install-${theme}-${width}.png`});await page.keyboard.press('Escape');
 }}expect(errors).toEqual([]);
});
test('compact Usage keeps its approved breakdown and exact unknown values across themes and widths',async({page,request})=>{
 // Synthetic UI measurements, not a claim about user usage. API semantics are covered by usage tests.
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config}});
 await page.route('**/api/usage?*',route=>route.fulfill({json:summary}));const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto('/usage');await expect(page.locator('.usage-metrics dd')).toHaveText(['1.3M','1M','250K']);
 for(const theme of ['light','dark'] as const){await setAppearanceMode(page,theme);for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:950});await expect(page.getByRole('button',{name:'Last 7 days',exact:true})).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('.usage-metrics dd').first().evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(24);
  if(width>=1024)expect((await page.locator('.usage-trend').boundingBox())!.y).toBeLessThan(300);
  await page.screenshot({path:`/tmp/compact-usage-${theme}-${width}.png`});
 }}expect(errors).toEqual([]);
});
