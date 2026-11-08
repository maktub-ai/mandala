import {test,expect} from '@playwright/test';
for(const language of ['zh-CN','en'] as const)test(`derived provenance shows its direct parent and groups transcript chunks in ${language}`,async({page},testInfo)=>{
 await page.addInitScript(language=>localStorage.setItem('mana-language',language),language);
 const sources=Array.from({length:12},(_,i)=>({id:'source-'+i,kind:i===11?'task':'conversation',conversationId:i===11?null:i<8?'chat-a':i<10?'chat-b':'chat-c',taskId:i===11?'task-one':null,title:i===11?'上线验收':i<8?'入库讨论':i<10?'交付讨论':'验收讨论',capturedAt:'2026-10-14T00:00:00Z'}));
 const evidence=sources.map(s=>({sourceId:s.id,sourceRevision:1}));
 const base={collectionId:'personal',revision:1,status:'active',contentType:'procedure',verification:'layer_summary',evidence,extractedAt:'2026-10-14T00:00:00Z',conversationIds:['chat-a','chat-b','chat-c']};
 const parent={...base,recordId:'scene',layer:'L2',semanticKey:'scene.delivery',text:'发布前检查实际结果。',dependencies:[]};
 const profile={...base,recordId:'profile',layer:'L3',text:'持续保留交付验证。',dependencies:[{recordId:'scene',revision:1}]};
 await page.route('**/api/v2/memory/records?*',r=>r.fulfill({json:{records:[profile,parent],collections:[],sources}}));
 await page.route('**/api/v2/memory/jobs',r=>r.fulfill({json:[]}));
 await page.route('**/api/v2/memory/sources/source-8',r=>r.fulfill({json:{id:'source-8',kind:'conversation',conversationId:'chat-b',capturedAt:'2026-10-14T00:00:00Z',eventIds:[81],text:'Second conversation source'}}));
 await page.goto('/mana?tab=memory');const card=page.locator('[data-record-id=profile]');
 const sourcesSummary=card.locator('.memory-sources > summary');
 await expect(sourcesSummary).toHaveText((language==='en'?'Sources':'来源')+' · 16');
 await sourcesSummary.click();
 const basis=card.locator('.memory-source-group').first();
 await expect(basis).toContainText(language==='en'?'Based on':'依据');
 await expect(basis.locator('a')).toHaveCount(1);
 await expect(basis.locator('a')).toContainText('发布前检查实际结果');
 await expect(card.getByRole('button',{name:language==='en'?/^Open source conversation: /:/^打开来源对话：/})).toHaveCount(3);
 await expect(card.getByRole('button',{name:/source-8/})).toHaveCount(0);
 await card.getByRole('button',{name:(language==='en'?'View snippet: ':'查看片段：')+'交付讨论 · 9',exact:true}).click();
 await expect(page.getByRole('region',{name:language==='en'?'Source details':'来源详情',exact:true})).toContainText('Second conversation source');
 await page.keyboard.press('Escape');await expect(page.getByRole('region',{name:language==='en'?'Source details':'来源详情',exact:true})).toHaveCount(0);
 for(const theme of ['light','dark'])for(const width of [1280,390]){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await card.screenshot({path:testInfo.outputPath(`provenance-${theme}-${width}.png`)});
 }
 await basis.locator('a').click();
 await expect(page).toHaveURL(/recordId=scene/);
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
 await expect(page.locator('[data-record-id=scene]')).toContainText('发布前检查实际结果。');
});
