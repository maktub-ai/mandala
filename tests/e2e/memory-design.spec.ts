import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';

const records=[
 {recordId:'fact',layer:'L1',text:'交付前需要人工验收。'},
 {recordId:'scene',layer:'L2',semanticKey:'scene.delivery',text:'-----META-START-----\nsummary: 项目交付与验收流程\n-----META-END-----\n\n# 工作场景\n\n交付前检查测试结果并交由用户验收。\n'+('保留来源与验证结果。'.repeat(60))+'\n正文末尾标记'},
 {recordId:'session',layer:'L2',semanticKey:'session.context',pipelines:['session'],text:'讨论了项目交付，决定先验证本地结果。'},
 {recordId:'context',layer:'L3',text:'交付结论应有来源与实际验证。'},
 {recordId:'old',layer:'L1',text:'已经失效的旧记录。',status:'stale'},
].map(r=>({collectionId:'personal',revision:1,status:'active',verification:'layer_summary',evidence:[{sourceId:'source',sourceRevision:1}],extractedAt:'2026-10-05T00:00:00Z',...r}));

for(const language of ['zh-CN','en'] as const)test(`L1 categories are readable in ${language} on desktop and mobile`,async({page},testInfo)=>{
 const types=['fact','preference','decision','procedure','constraint','open_issue'];
 const labels=language==='en'?['Fact','Preference','Decision','Procedure','Constraint','Open issue']:['事实','偏好','决策','流程','约束','未决问题'];
 const typedRecords=types.map(contentType=>({...records[0],recordId:contentType,contentType,text:'Synthetic memory: '+contentType}));
 await page.addInitScript(language=>localStorage.setItem('mana-language',language),language);
 await page.route('**/api/v2/memory/records?*',r=>r.fulfill({json:{records:[...typedRecords,records[1],records[3]],collections:[]}}));
 await page.route('**/api/v2/memory/jobs',r=>r.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 for(const [index,type] of types.entries())await expect(page.locator(`[data-record-id="${type}"] .memory-content-type`)).toHaveText(labels[index]);
 await expect(page.locator('[data-tier="L2"] .memory-content-type,[data-tier="L3"] .memory-content-type')).toHaveCount(0);
 for(const theme of ['light','dark'])for(const width of [1280,390]){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.setViewportSize({width,height:900});
  const tag=page.locator('[data-record-id="open_issue"] .memory-content-type');
  await tag.scrollIntoViewIfNeeded();
  await expect(tag).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const card=page.locator('[data-record-id="open_issue"]');
  const [cardBox,tagBox]=await Promise.all([card.boundingBox(),tag.boundingBox()]);
  expect(tagBox!.x+tagBox!.width).toBeLessThanOrEqual(cardBox!.x+cardBox!.width);
  await card.screenshot({path:testInfo.outputPath(`category-${theme}-${width}.png`)});
 }
});

test('memory keeps fact, scene, session and stable context identities with usable layer filters',async({page})=>{
 await page.route('**/api/v2/memory/records?*',r=>r.fulfill({json:{records,collections:[]}}));
 await page.route('**/api/v2/memory/jobs',r=>r.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 const overview=page.getByRole('region',{name:'记忆类型',exact:true});
 await expect(overview.locator('button')).toHaveCount(4);
 for(const label of ['原子事实','场景知识','长期上下文'])await expect(overview.getByRole('button',{name:label+'，1 条匹配',exact:true})).toBeVisible();
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(3);
 await expect(page.locator('[data-record-id="old"]')).not.toBeVisible();
 await overview.getByRole('button',{name:'场景知识，1 条匹配',exact:true}).click();
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
 const scene=page.locator('[data-record-id="scene"]');
 await expect(scene.getByRole('heading',{name:'项目交付与验收流程',exact:true})).toBeVisible();
 await expect(scene.getByText('正文末尾标记',{exact:false})).not.toBeVisible();
 await scene.getByText('查看完整内容',{exact:true}).click();
 await expect(scene.getByText('正文末尾标记',{exact:false})).toBeVisible();
 await overview.getByRole('button',{name:'全部记忆，3 条匹配',exact:true}).click();
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(3);
 await page.getByText('高级筛选',{exact:true}).click();
 await chooseOption(page,page.getByRole('combobox',{name:'状态',exact:true}),'all');
 await page.getByText('历史与失效记录 · 1',{exact:true}).click();
 await expect(page.locator('[data-record-id="old"]')).toBeVisible();
});

test('layer cards and source controls fit a light mobile viewport',async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem('mana-language','zh-CN');localStorage.setItem('mana-theme','light');});
 await page.route('**/api/v2/memory/records?*',r=>r.fulfill({json:{records,collections:[]}}));
 await page.route('**/api/v2/memory/jobs',r=>r.fulfill({json:[]}));
 await page.route('**/api/v2/memory/sources/source',r=>r.fulfill({json:{id:'source',kind:'conversation',capturedAt:'2026-10-05T00:00:00Z',eventIds:[1,2],text:'Synthetic evidence'}}));
 await page.setViewportSize({width:390,height:844});
 await page.goto('/mana?tab=memory');
 await expect(page.locator('.memory-overview svg')).toHaveCount(3);
 await page.getByRole('button',{name:'来源片段 1',exact:true}).click();
 const sources=page.getByRole('region',{name:'关联来源',exact:true});
 await expect(sources).toBeVisible();
 await sources.getByRole('button',{name:/^查看来源：/}).click();
 await expect(page.getByRole('region',{name:'来源详情',exact:true})).toContainText('Synthetic evidence');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('memory sources remain accessible separately from memory types, and sources identify their conversations',async({page})=>{
 const sources=[{id:'source',kind:'conversation',conversationId:'synthetic-chat',taskId:null,title:'上线验收讨论',excerpt:'确认服务版本并检查页面',observedAt:'2026-10-08T01:00:00Z',capturedAt:'2026-10-08T01:10:00Z'}];
 await page.route('**/api/v2/memory/records?*',r=>r.fulfill({json:{records,collections:[],sources}}));
 await page.route('**/api/v2/memory/jobs',r=>r.fulfill({json:[]}));
 await page.route('**/api/v2/memory/sources/source',r=>r.fulfill({json:{id:'source',kind:'conversation',conversationId:'synthetic-chat',capturedAt:sources[0].capturedAt,eventIds:[1,2],text:'Synthetic evidence'}}));
 await page.goto('/mana?tab=memory');
 await expect(page.locator('.memory-flow')).toHaveCount(0);
 await page.getByRole('button',{name:'来源片段 1',exact:true}).click();
 const list=page.getByRole('region',{name:'关联来源',exact:true});
 await expect(list.getByText('上线验收讨论',{exact:true})).toBeVisible();
 await expect(list.getByText('确认服务版本并检查页面',{exact:true})).toBeVisible();
 await expect(list.getByText('1 个片段 · 1 个对话',{exact:true})).toBeVisible();
 await expect(list.getByRole('button',{name:'打开来源对话：上线验收讨论',exact:true})).toBeVisible();
 await list.getByRole('button',{name:'查看来源：上线验收讨论',exact:true}).click();
 await expect(page.getByRole('region',{name:'来源详情',exact:true})).toContainText('Synthetic evidence');
});
