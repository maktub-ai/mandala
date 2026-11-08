import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
const skills=[{id:'first-skill',kind:'skill',title:'First draft',content:'Alpha procedure',scope:'global',status:'candidate',createdAt:'2026-10-09T00:00:00Z',updatedAt:'2026-10-09T00:00:00Z'},{id:'second-skill',kind:'skill',title:'Second draft',content:'Beta procedure',scope:'global',status:'active',createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z'}];
const records=[{recordId:'first-record',collectionId:'personal',revision:1,layer:'L1',semanticKey:'fact.synthetic',text:'Alpha memory',status:'active',verification:'layer_summary',evidence:[],extractedAt:'2026-10-09T00:00:00Z',effectiveFrom:'2026-10-09T00:00:00Z',conversationId:null,taskId:null},{recordId:'second-record',collectionId:'personal',revision:1,layer:'L3',semanticKey:'scene.synthetic',text:'Beta memory',status:'active',verification:'layer_summary',evidence:[],extractedAt:'2026-10-08T00:00:00Z',effectiveFrom:'2026-10-08T00:00:00Z',conversationId:null,taskId:null}];
test.beforeEach(async({page})=>{
 await page.route('**/api/knowledge',route=>route.fulfill({json:skills}));
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records,collections:[]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
});
test('Skill exact link exits selection when searching and preserves exact selection in history',async({page})=>{
 await page.goto('/mana?tab=skill&knowledgeId=first-skill');await expect(page.getByRole('heading',{name:'First draft',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Second draft',exact:true})).toHaveCount(0);
 await page.getByRole('searchbox',{name:'资料搜索',exact:true}).fill('Beta');await expect(page.getByRole('heading',{name:'Second draft',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'First draft',exact:true})).toHaveCount(0);await expect(page).not.toHaveURL(/knowledgeId=/);
 await page.reload();await expect(page.getByRole('heading',{name:'First draft',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Second draft',exact:true})).toBeVisible();
 await page.goBack();await expect(page).toHaveURL(/knowledgeId=first-skill/);await expect(page.getByRole('heading',{name:'First draft',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Second draft',exact:true})).toHaveCount(0);
});
test('Skill explicit status filter exits exact selection and applies its filter',async({page})=>{
 await page.goto('/mana?tab=skill&knowledgeId=first-skill');await expect(page.getByRole('heading',{name:'First draft',exact:true})).toBeVisible();
 await chooseOption(page,page.getByRole('combobox',{name:'状态筛选',exact:true}),'active');await expect(page.getByRole('heading',{name:'Second draft',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'First draft',exact:true})).toHaveCount(0);await expect(page).not.toHaveURL(/knowledgeId=/);
});
test('Memory exact link exits selection through All memories and restores on back',async({page})=>{
 await page.goto('/mana?tab=memory&recordId=first-record');await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
 await page.getByRole('button',{name:'全部记忆',exact:true}).click();await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(2);await expect(page).not.toHaveURL(/recordId=/);
 await page.reload();await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(2);await page.goBack();await expect(page).toHaveURL(/recordId=first-record/);await expect(page.locator('.memory-records [data-record-id="first-record"]')).toBeVisible();await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
});
test('Memory type and search controls exit exact navigation before filtering',async({page})=>{
 await page.goto('/mana?tab=memory&recordId=first-record');await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
 await page.getByRole('button',{name:/^长期上下文，/}).click();await expect(page.locator('.memory-records [data-record-id="second-record"]')).toBeVisible();await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);await expect(page).not.toHaveURL(/recordId=/);
 await page.goto('/mana?tab=memory&recordId=first-record');await expect(page.locator('.memory-records [data-record-id="first-record"]')).toBeVisible();await page.getByRole('searchbox',{name:'搜索记忆',exact:true}).fill('Beta');await expect(page.locator('.memory-records [data-record-id="second-record"]')).toBeVisible();await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);await expect(page).not.toHaveURL(/recordId=/);
});
