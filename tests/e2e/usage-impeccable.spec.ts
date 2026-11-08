import { test, expect } from '@playwright/test';

import { totals, summary, config } from '../fixtures/usage-dashboard';
test.beforeEach(async ({page,request}) => {
 const { revision } = await (await request.get('/api/config')).json();
 await request.put('/api/config', { data: { config, revision } });
 await page.route('**/api/usage?*', route => route.fulfill({json:summary}));
});
test('one selected breakdown, date disclosure and precise values instead of stacked tables', async ({page}) => {
 await page.goto('/usage');
 const panel=page.getByRole('region',{name:'已记录用量',exact:true});
 await expect(panel.getByRole('combobox',{name:'分析维度'})).toBeVisible();
 await expect(panel.getByRole('table')).toHaveCount(0);
 await expect(panel.getByText('产品与架构',{exact:true})).toBeVisible();
 await panel.getByRole('combobox',{name:'分析维度'}).click();
 await page.getByRole('option',{name:'按模型',exact:true}).click();
 await expect(panel.getByText('产品与架构',{exact:true})).toHaveCount(0);
 await panel.getByRole('button',{name:'表格',exact:true}).click();
 await expect(panel.getByRole('table')).toHaveCount(1);
 await expect(panel.getByRole('table')).toContainText('1,250,000');
 await expect(panel.getByText('Asia/Singapore',{exact:true})).not.toBeVisible();
 await panel.getByText('统计口径',{exact:true}).click();
 await expect(panel.getByText('Asia/Singapore',{exact:true})).toBeVisible();
 await expect(panel.locator('.usage-chart-day[data-state="unknown"]')).toHaveCount(1);
 await expect(panel.locator('.usage-chart-day[data-state="zero"]')).toHaveCount(1);
});
test('empty and unreported usage do not produce misleading zero graphs', async ({page}) => {
 await page.route('**/api/usage?*',route=>route.fulfill({json:{...summary,totals:totals(null),coverage:{observed:0,partial:0,unknown:0,total:0},daily:[],groups:Object.fromEntries(Object.keys(summary.groups).map(key=>[key,[]])),recent:[]}}));
 await page.goto('/usage');
 await expect(page.getByRole('heading',{level:2,name:'这个时段还没有调用记录',exact:true})).toBeVisible();
 await expect(page.getByRole('table')).toHaveCount(0);
 await expect(page.locator('.usage-chart-day')).toHaveCount(0);
 await page.route('**/api/usage?*',route=>route.fulfill({json:{...summary,totals:totals(null),coverage:{observed:0,partial:0,unknown:15,total:15},daily:summary.daily.map(day=>({...day,totals:totals(null)}))}}));
 await page.getByRole('button',{name:'今日',exact:true}).click();
 await expect(page.getByRole('heading',{level:2,name:'调用尚未上报 Token 用量',exact:true})).toBeVisible();
 await expect(page.locator('.usage-recording')).toHaveText('用量未上报');
 await expect(page.locator('.usage-metrics dd')).toHaveText(['—','—','—']);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/usage-unreported-heading-390.png'});
});
for(const theme of ['light','dark']) test('responsive '+theme+' retains aligned controls and reveals sources',async({page})=>{
 await page.addInitScript(value=>localStorage.setItem('mana-theme',value),theme);
 await page.goto('/usage?project=one');
 const panel=page.getByRole('region',{name:'已记录用量',exact:true});
 for(const width of [1440,1024,390]) {
  await page.setViewportSize({width,height:900});
  await expect(panel.getByRole('combobox',{name:'分析维度'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/compact-usage-regression/${theme}-${width}.png`,fullPage:true});
 }
 await panel.getByText('调用记录',{exact:true}).click();
 await expect(panel.getByRole('link',{name:'打开来源'})).toHaveAttribute('href','/?conversation=usage-conversation');
});
test('a day without calls is distinct from unknown usage and keyboard exposes exact values', async ({page}) => {
 const daily=summary.daily.map((day,i)=>i===0?{...day,totals:totals(null),coverage:{observed:0,partial:0,unknown:0,total:0}}:day);
 await page.route('**/api/usage?*',route=>route.fulfill({json:{...summary,daily}}));
 await page.goto('/usage');
 const emptyDay=page.locator('.usage-chart-day[data-state="empty"]');
 await expect(emptyDay).toHaveAccessibleName('10/11: 无调用');
 await emptyDay.focus();
 await expect(emptyDay.locator('.usage-day-tooltip')).toBeVisible();
 await expect(emptyDay.locator('.usage-day-tooltip')).toContainText('无调用');
 await expect(page.locator('.usage-chart-day[data-state="unknown"]')).toHaveAccessibleName('10/13: 未上报');
 await expect(page.locator('.usage-chart-day[data-state="zero"]')).toHaveAccessibleName('10/15: 0 Token');
});
test('a failed usage request can recover without showing fabricated data', async ({page}) => {
 let failed=true;
 await page.route('**/api/usage?*',route=>failed?route.fulfill({status:503,json:{error:'Temporarily unavailable'}}):route.fulfill({json:summary}));
 await page.goto('/usage');
 await expect(page.getByRole('alert')).toContainText('用量暂时无法读取');
 await expect(page.locator('.usage-chart-day')).toHaveCount(0);
 failed=false;
 await page.getByRole('button',{name:'重试',exact:true}).click();
 await expect(page.locator('.usage-chart-day')).toHaveCount(7);
 await expect(page.getByRole('alert')).toHaveCount(0);
});
