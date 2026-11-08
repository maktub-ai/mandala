import {putRuntimeConfig} from './helpers/runtime-config';
import {test,expect} from '@playwright/test';
import {waitForAutosave} from './helpers/settings';

test('a retired route requires an explicit native-settings choice in light and narrow dark layouts',async({page,request})=>{
 expect((await putRuntimeConfig(request,{version:2,runtimes:['claude','gemini'],projects:[],agents:[],runtimeDefaults:{gemini:{gateway:'unavailable'}}})).ok()).toBe(true);
 await page.route('**/api/models?**',route=>route.fulfill({json:[]}));
 await page.route('**/api/cli/status?**',route=>route.fulfill({json:{status:'ready',version:'synthetic'}}));
 await page.goto('/settings/runtimes/gemini');
 await expect(page.getByText('旧版模型接入已停用，请确认使用 CLI 原生设置。',{exact:true})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'模型接入',exact:true})).toHaveCount(0);
 await page.screenshot({path:'test-results/runtime-native-light.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{localStorage.setItem('mana-theme','dark');});await page.reload();
 await expect(page.getByText('旧版模型接入已停用，请确认使用 CLI 原生设置。',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/runtime-native-dark-390.png',fullPage:true});
 expect((await(await request.get('/api/config')).json()).config.runtimeDefaults.gemini.gateway).toBe('unavailable');
 await page.getByRole('button',{name:'使用 CLI 原生设置',exact:true}).click();await waitForAutosave(page);
 await expect.poll(async()=> (await(await request.get('/api/config')).json()).config.runtimeDefaults.gemini.gateway).toBe('native');
 await page.reload();await expect(page.getByRole('button',{name:'使用 CLI 原生设置',exact:true})).toHaveCount(0);
});
