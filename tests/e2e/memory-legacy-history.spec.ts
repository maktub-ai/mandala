import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {mkdirSync} from 'node:fs';
import {defaultPreferences,themeStorageKey} from '../../src/themes';
const make=(id:string,status:string,legacy=false,level='L2')=>({recordId:id,collectionId:'personal',revision:1,layer:'L1',contentType:'fact',text:'Synthetic '+id,status,verification:legacy?'legacy_user_managed':'unverified',evidence:[],dependencies:[],extractedAt:'2020-01-01T00:00:00Z',effectiveFrom:'2020-01-01T00:00:00Z',...(legacy?{legacyId:id,legacyLevel:level,legacy:{title:'Historical '+id,sourceConversationId:'source'}}:{})});
test('legacy candidates live only in history across filters, exact links, themes and refresh',async({page})=>{
 const records=[make('old-l2','proposed',true),make('old-l3','proposed',true,'L3'),make('legacy-active','active',true),make('modern-candidate','proposed'),make('withdrawn','retracted',true)];
 await page.route('**/api/v2/memory/records?*',r=>r.fulfill({json:{records,collections:[{id:'personal',projectId:null,agentId:null}]}}));
 await page.route('**/api/v2/memory/jobs',r=>r.fulfill({json:[]}));
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
 await page.goto('/mana?tab=memory');
 await expect(page.locator('.memory-records [data-record-id="legacy-active"]')).toBeVisible();
 await expect(page.getByRole('button',{name:/待确认|确认生效|Confirm memory|Awaiting confirmation/})).toHaveCount(0);
 await page.getByText('高级筛选',{exact:true}).click();await chooseOption(page,page.getByRole('combobox',{name:'状态',exact:true}),'all');
 await expect(page.locator('.memory-records [data-record-id="old-l2"]')).toHaveCount(0);
 await expect(page.locator('.memory-records [data-record-id="old-l3"]')).toHaveCount(0);
 await expect(page.locator('.memory-records [data-record-id="legacy-active"]')).toBeVisible();
 await expect(page.locator('.memory-records [data-record-id="modern-candidate"]')).toBeVisible();
 const history=page.locator('.memory-history');await history.locator('summary').click();
 for(const id of ['old-l2','old-l3']){const card=history.locator('[data-record-id="'+id+'"]');await expect(card).toContainText('旧版候选');await expect(card).toContainText('Synthetic '+id);await expect(card.getByRole('button',{name:/确认|纠正|撤回/})).toHaveCount(0);}
 mkdirSync('.superpowers/legacy-memory-history',{recursive:true});
 for(const theme of ['light','dark']){await page.evaluate(({theme,key,preferences})=>{const newValue=JSON.stringify({...preferences,mode:theme});localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,newValue}));},{theme,key:themeStorageKey,preferences:defaultPreferences()});await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await page.screenshot({path:'.superpowers/legacy-memory-history/history-'+theme+'.png',fullPage:true});}
 await page.getByRole('searchbox',{name:'搜索记忆',exact:true}).fill('old-l3');await expect(history.locator('[data-record-id="old-l3"]')).toBeVisible();
 await chooseOption(page,page.getByRole('combobox',{name:'状态',exact:true}),'proposed');
 await expect(page.locator('.memory-records [data-record-id="old-l3"]')).toHaveCount(0);await expect(history.locator('[data-record-id="old-l3"]')).toBeVisible();
 await page.goto('/mana?tab=memory&recordId=old-l3');await expect(page.locator('.memory-records [data-record-id="old-l3"]')).toHaveCount(0);await expect(history.locator('[data-record-id="old-l3"]')).toBeVisible();
 await page.reload();await expect(history.locator('[data-record-id="old-l3"]')).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(history.locator('[data-record-id="old-l3"]')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'.superpowers/legacy-memory-history/history-mobile.png',fullPage:true});
});
