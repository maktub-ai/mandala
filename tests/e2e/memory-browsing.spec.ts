import { chooseOption } from "./helpers/select";
import {test,expect,type Page} from '@playwright/test';

const record=(id:string,index:number,status='active')=>({recordId:id,collectionId:'personal',revision:1,layer:['L1','L2','L3'][index%3],semanticKey:'scene.synthetic',text:'Synthetic record '+String(index).padStart(2,'0'),status,verification:'layer_summary',evidence:[],extractedAt:new Date(Date.UTC(2026,9,7,index)).toISOString(),effectiveFrom:'2026-10-01T00:00:00Z',conversationId:null,taskId:null});
const ids=(page:Page,selector='.memory-records [data-record-id]')=>page.locator(selector).evaluateAll((nodes:Element[])=>nodes.map(node=>node.getAttribute('data-record-id')));

test('memory is chronological across layers, bounded to 20 per page, and resets filters without polling resetting the page',async({page})=>{
 const records=Array.from({length:45},(_,i)=>record('memory-'+i,i));let loads=0;
 await page.route('**/api/v2/memory/records?*',route=>{loads++;return route.fulfill({json:{records,collections:[{id:'personal',projectId:null,agentId:null}]}});});
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(20);
 expect(await ids(page)).toEqual(Array.from({length:20},(_,i)=>'memory-'+(44-i)));
 const navigation=page.getByRole('navigation',{name:'记忆翻页',exact:true});
 await expect(navigation).toContainText('1–20 / 45');
 await navigation.getByRole('button',{name:'下一页',exact:true}).click();
 expect(await ids(page)).toEqual(Array.from({length:20},(_,i)=>'memory-'+(24-i)));
 const before=loads;await expect.poll(()=>loads,{timeout:8000}).toBeGreaterThan(before);
 await expect(navigation).toContainText('21–40 / 45');
 await navigation.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(5);
 await expect(navigation.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
 await page.getByRole('searchbox',{name:'搜索记忆',exact:true}).fill('Synthetic record 00');
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
 expect(await ids(page)).toEqual(['memory-0']);
 await expect(navigation).toContainText('1–1 / 1');
 await page.getByRole('searchbox',{name:'搜索记忆',exact:true}).fill('');
 await navigation.getByRole('button',{name:'下一页',exact:true}).click();
 await page.getByRole('button',{name:'长期上下文，15 条匹配',exact:true}).click();
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(15);
 expect(await ids(page)).toEqual(Array.from({length:15},(_,i)=>'memory-'+(44-i*3)));
 await page.getByRole('button',{name:/^全部记忆，/}).click();
 await navigation.getByRole('button',{name:'下一页',exact:true}).click();
 await chooseOption(page, page.getByRole('combobox',{name:'项目范围',exact:true}), '');
 await expect(navigation).toContainText('1–20 / 45');
});

test('timestamps sort by the actual instant with stable ties and legacy fallback',async({page})=>{
 const records=[
  {...record('offset',0),extractedAt:'2026-10-07T10:00:00+08:00'},
  {...record('utc',1),extractedAt:'2026-10-07T03:00:00Z'},
  {...record('tie-b',2),extractedAt:'2026-10-07T04:00:00Z'},
  {...record('tie-a',3),extractedAt:'2026-10-07T04:00:00Z'},
  {...record('fallback',4),extractedAt:'invalid',effectiveFrom:'2026-10-07T01:00:00Z'},
  {...record('epoch',5),extractedAt:'1970-01-01T00:00:00Z'},
  {...record('old-time',6),extractedAt:'1969-01-01T00:00:00Z'},
  {...record('unknown',7),extractedAt:'',effectiveFrom:''},
 ];let loads=0;
 await page.route('**/api/v2/memory/records?*',route=>{loads++;return route.fulfill({json:{records:loads%2?records:[...records].reverse(),collections:[]}});});
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 await expect.poll(()=>ids(page)).toEqual(['tie-a','tie-b','utc','offset','fallback','epoch','old-time','unknown']);
 await expect.poll(()=>loads,{timeout:8000}).toBeGreaterThan(1);
 expect(await ids(page)).toEqual(['tie-a','tie-b','utc','offset','fallback','epoch','old-time','unknown']);
 await expect(page.locator('[data-record-id="fallback"] time')).toHaveAttribute('datetime','2026-10-07T01:00:00Z');
 await expect(page.locator('[data-record-id="unknown"]')).not.toContainText('Invalid Date');
});

test('history stays unmounted until opened and has its own bounded chronological pages on narrow English screens',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));
 const records=[record('current',0),...Array.from({length:23},(_,i)=>record('old-'+i,i,'stale'))];
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records,collections:[{id:'personal',projectId:null,agentId:null}]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.setViewportSize({width:390,height:844});
 await page.goto('/mana?tab=memory');
 await page.getByText('Advanced filters',{exact:true}).click();
 await chooseOption(page,page.getByRole('combobox',{name:'Status',exact:true}),'all');
 await expect(page.locator('.memory-history')).toBeVisible();
 await expect(page.locator('.memory-history [data-record-id]')).toHaveCount(0);
 await page.getByText('Historical and inactive memories · 23',{exact:true}).click();
 await expect(page.locator('.memory-history [data-record-id]')).toHaveCount(20);
 expect(await ids(page,'.memory-history [data-record-id]')).toEqual(Array.from({length:20},(_,i)=>'old-'+(22-i)));
 const navigation=page.getByRole('navigation',{name:'Historical memory pagination',exact:true});
 await navigation.getByRole('button',{name:'Next',exact:true}).click();
 expect(await ids(page,'.memory-history [data-record-id]')).toEqual(['old-2','old-1','old-0']);
 await page.getByText('Historical and inactive memories · 23',{exact:true}).click();
 await expect(page.locator('.memory-history [data-record-id]')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('long content is loaded only when opened and correction preserves the complete text while paging is locked',async({page})=>{
 const text='## Synthetic long memory\n\n'+('Synthetic supported detail. '.repeat(40))+'\n\nFull-text ending';
 const records=Array.from({length:23},(_,i)=>record('long-'+i,i));records[22].text=text;
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records,collections:[{id:'personal',projectId:null,agentId:null}]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 const card=page.locator('[data-record-id="long-22"]');
 await expect(card.getByText('Full-text ending',{exact:true})).toHaveCount(0);
 await card.getByText('查看完整内容',{exact:true}).click();
 await expect(card.getByText('Full-text ending',{exact:true})).toBeVisible();
 await card.getByText('查看完整内容',{exact:true}).click();
 await expect(card.getByText('Full-text ending',{exact:true})).toHaveCount(0);
 await card.getByRole('button',{name:'纠正',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'纠正内容',exact:true})).toHaveValue(text);
 const next=page.getByRole('navigation',{name:'记忆翻页',exact:true}).getByRole('button',{name:'下一页',exact:true});
 await expect(next).toBeDisabled();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await expect(next).toBeEnabled();
});

test('short structured memory stays compact until the user opens its sections',async({page})=>{
 const text='## Work context\n\nA supported fact.\n\n## Conditions\n\nA specific trigger.\n\n## Procedure\n\nFollow the verified steps.';
 const item=record('structured',1);item.text=text;
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[item],collections:[]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 const card=page.locator('[data-record-id="structured"]');
 await expect(card).toBeVisible();
 await expect(card.getByRole('heading',{name:'Procedure',exact:true})).toHaveCount(0);
 await card.getByText('查看完整内容',{exact:true}).click();
 await expect(card.getByRole('heading',{name:'Procedure',exact:true})).toBeVisible();
});

test('polling clamps a removed last page and does not jump back when records reappear',async({page})=>{
 const original=Array.from({length:45},(_,i)=>record('resize-'+i,i));let records=original;
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records,collections:[{id:'personal',projectId:null,agentId:null}]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 const navigation=page.getByRole('navigation',{name:'记忆翻页',exact:true});
 await navigation.getByRole('button',{name:'下一页',exact:true}).click();
 await navigation.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(navigation).toContainText('41–45 / 45');
 records=original.slice(0,40);
 await expect(navigation).toContainText('21–40 / 40',{timeout:8000});
 records=original;
 await expect(navigation).toContainText('21–40 / 45',{timeout:8000});
});

test('memory defaults to simple browsing without a separate summary feature',async({page})=>{
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[record('simple',0)],collections:[]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 await expect(page.locator('.memory-filters').getByRole('combobox')).toHaveCount(1);
 await expect(page.getByRole('searchbox',{name:'搜索记忆',exact:true})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'Agent',exact:true})).not.toBeVisible();
 await expect(page.getByLabel('开始日期',{exact:true})).not.toBeVisible();
 await expect(page.getByRole('button',{name:'立即整理',exact:true})).not.toBeVisible();
 await page.getByText('高级筛选',{exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Agent',exact:true})).toBeVisible();
 await expect(page.getByLabel('开始日期',{exact:true})).toBeVisible();
 await page.getByLabel('开始日期',{exact:true}).fill('2026-10-14');
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(0);
 await page.getByText('高级筛选 · 1',{exact:true}).click();
 await page.getByRole('button',{name:'清除高级筛选',exact:true}).click();
 await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(1);
 await expect(page.getByRole('tab',{name:'会话摘要',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'立即整理',exact:true})).toHaveCount(0);
});

test('sources count unique conversations separately from evidence and keep each conversation reachable',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex'}})).json();
 const records=[{...record('multi',1),conversationId:chat.id,conversationIds:[chat.id,'second-chat',chat.id],evidence:[{sourceId:'one',sourceRevision:1},{sourceId:'two',sourceRevision:1},{sourceId:'three',sourceRevision:1}]},{...record('single',0),conversationId:chat.id,conversationIds:[chat.id,chat.id]}];
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records,collections:[],sources:[{id:'one',conversationId:chat.id,title:'报表讨论'},{id:'two',conversationId:chat.id,title:'报表讨论'},{id:'three',conversationId:'second-chat',title:'验收约定'}]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');
 await expect(page.getByRole('button',{name:'来源片段 3',exact:true})).toBeVisible();
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
  await page.screenshot({path:'/tmp/mandala-memory-simple-'+theme+'.png',fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/mandala-memory-simple-mobile.png',fullPage:true});
 await page.setViewportSize({width:1280,height:850});
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
 const card=page.locator('[data-record-id="multi"]');
 await expect(card.getByRole('button',{name:/打开来源对话/})).not.toBeVisible();
 await card.locator('.memory-sources > summary').click();
 await expect(card.getByRole('button',{name:/^打开来源对话：/})).toHaveCount(2);
 await expect(card.getByRole('button',{name:/^查看片段：/})).toHaveCount(3);
 await card.screenshot({path:'/tmp/mandala-memory-sources-expanded.png'});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await card.screenshot({path:'/tmp/mandala-memory-sources-mobile.png'});
 await expect(page.locator('[data-record-id="single"] .memory-sources > summary')).toHaveText('来源 · 1');
 await card.getByRole('button',{name:'打开来源对话：报表讨论',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('conversation='+chat.id));
});
