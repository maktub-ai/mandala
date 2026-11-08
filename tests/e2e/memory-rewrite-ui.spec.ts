import {waitForAutosave} from './helpers/settings';
import { test, expect } from '@playwright/test';
test('deep-memory controls save and retain the selected CLI/model', async ({ page, request }) => {
  const current = await (await request.get('/api/config')).json();
  try {
  expect((await request.put('/api/config', { data: { config: { ...current.config, system: {cli:'codex',memory:{language:'en'},tasks:{memory:{cli:'omp',model:'hy-3'}}} }, revision:current.revision } })).ok()).toBe(true);
  await page.goto('/settings/system');
  for (const label of ['请求记忆生成','请求记忆读取']) await expect(page.getByLabel(label,{exact:true})).toBeChecked();
  await page.getByLabel('请求记忆生成',{exact:true}).uncheck();
  await expect(page.getByLabel('会话记忆读取',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('会话闲置小时数',{exact:true})).toHaveCount(0);
  await waitForAutosave(page);
  await expect.poll(async()=> (await (await request.get('/api/config')).json()).config.system.memory).toMatchObject({request:{generate:false,read:true},language:'en'});
  expect((await (await request.get('/api/config')).json()).config.system.tasks.memory).toEqual({cli:'omp',model:'hy-3'});
  await page.reload();
  await expect(page.getByLabel('请求记忆生成',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('会话记忆读取',{exact:true})).toHaveCount(0);
  } finally {
    const latest=await (await request.get('/api/config')).json();
    expect((await request.put('/api/config',{data:{config:current.config,revision:latest.revision}})).ok()).toBe(true);
  }
});
test('legacy queued session work does not expose summary actions or processing status', async ({page}) => {
  await page.route('**/api/v2/memory/records?*', route=>route.fulfill({json:{records:[],collections:[]}}));
  await page.route('**/api/v2/memory/jobs', route=>route.fulfill({json:[{id:'pending-job',collectionId:'personal',state:'pending',kind:'session',stage:'consolidate',error:'quota exhausted'}]}));
  let received:unknown;
  await page.route('**/api/v2/memory/organize',route=>{received=route.request().postDataJSON();return route.fulfill({json:{jobs:[]}});});
  await page.goto('/mana?tab=memory&conversationId=synthetic-chat');
  await expect(page.getByRole('tab',{name:'会话摘要',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'立即整理',exact:true})).toHaveCount(0);
  expect(received).toBeUndefined();
  await expect(page.locator('.memory-processing')).toHaveCount(0);
  await expect(page.locator('.mana-header p')).toHaveText('自动整理对话中的事实，让后续对话延续已有上下文。');
});
test('source details show an event count and disclose event IDs on demand', async ({page}) => {
  await page.route('**/api/v2/memory/records?*', route=>route.fulfill({json:{records:[{recordId:'synthetic-fact',collectionId:'personal',revision:1,layer:'L1',contentType:'fact',text:'Synthetic preference',status:'active',verification:'evidence_extract',evidence:[{sourceId:'synthetic-source',sourceRevision:1}],extractedAt:'2026-10-05T00:00:00Z',conversationId:null,taskId:null}],collections:[]}}));
  await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
  await page.route('**/api/v2/memory/sources/synthetic-source',route=>route.fulfill({json:{id:'synthetic-source',kind:'conversation',collectionId:'personal',capturedAt:'2026-10-05T00:00:00Z',eventIds:[77001,77002],text:'Synthetic source text'}}));
  await page.goto('/mana?tab=memory');
  await page.locator('.memory-sources > summary').click();await page.getByRole('button',{name:'查看片段：片段 1',exact:true}).click();
  const source=page.getByRole('region',{name:'来源详情',exact:true});
  await expect(source.locator('summary')).toHaveText('事件 · 2');
  await expect(source.getByText('77001, 77002',{exact:true})).not.toBeVisible();
  await source.locator('summary').click();
  await expect(source.getByText('77001, 77002',{exact:true})).toBeVisible();
});


test('scene results render readable Markdown without internal metadata or executable HTML',async({page})=>{
 const text='-----META-START-----\ncreated: 2026-10-05\nsummary: 内部摘要\nheat: 1\n-----META-END-----\n\n## 项目约定\n- 使用 **pnpm**。\n<script>window.memoryInjected=true</script>';
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[{recordId:'scene',collectionId:'personal',revision:1,layer:'L2',status:'active',text,evidence:[],extractedAt:'2026-10-05T00:00:00Z'}],collections:[]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[{id:'markdown',kind:'request',state:'completed',error:null,sourceRefs:[],createdAt:'2026-10-05T02:00:00Z'}]}));
 await page.route('**/api/v2/memory/jobs/markdown/result',route=>route.fulfill({json:{records:[{recordId:'scene',layer:'L2',status:'active',text}],summaries:[]}}));
 await page.goto('/mana?tab=memory');const result=page.locator('[data-record-id=scene]');await expect(result.getByRole('heading',{name:'项目约定'})).toBeVisible();await expect(result.locator('strong').filter({hasText:'pnpm'})).toBeVisible();await expect(result).not.toContainText('META-START');expect(await page.evaluate(()=>('memoryInjected' in window))).toBe(false);
});

test('memory keeps multiple evidence entries grouped and individually reachable', async ({page}) => {
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[{recordId:'many-sources',collectionId:'personal',revision:1,layer:'L1',text:'Synthetic preference',status:'active',verification:'evidence_extract',evidence:[{sourceId:'source-one',sourceRevision:1},{sourceId:'source-two',sourceRevision:1}],extractedAt:'2026-10-05T00:00:00Z'}],collections:[]}}));
 await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.route('**/api/v2/memory/sources/source-two',route=>route.fulfill({json:{id:'source-two',kind:'conversation',collectionId:'personal',capturedAt:'2026-10-05T00:00:00Z',eventIds:[2],text:'Second source text'}}));
 await page.goto('/mana?tab=memory');const card=page.locator('[data-record-id="many-sources"]');
 await expect(card.locator('.memory-sources > summary')).toHaveText('来源 · 2');
 await expect(card.getByRole('button',{name:'查看片段：片段 2',exact:true})).not.toBeVisible();
 await card.locator('.memory-sources > summary').click();await card.getByRole('button',{name:'查看片段：片段 2',exact:true}).click();
 await expect(page.getByRole('region',{name:'来源详情',exact:true})).toContainText('Second source text');
});

test('explicit UI language changes persist for background memory generation and survive reload',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();
 try{
  await page.addInitScript(()=>localStorage.setItem('mana-language','en'));
  await page.goto('/settings/general');
  await expect(page.getByRole('radio',{name:'English',exact:true})).toHaveAttribute('aria-checked','true');
  expect((await(await request.get('/api/config')).json()).config.system?.memory?.language).toBe(current.config.system?.memory?.language);
  await page.getByRole('radio',{name:'简体中文',exact:true}).click();
  await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.system?.memory?.language).toBe('zh-CN');
  await page.getByRole('radio',{name:'English',exact:true}).click();
  await waitForAutosave(page);
  await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.system?.memory?.language).toBe('en');
  await page.reload();await expect(page.getByRole('radio',{name:'English',exact:true})).toHaveAttribute('aria-checked','true');
 }finally{
  await page.close();const latest=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{config:current.config,revision:latest.revision}})).ok()).toBe(true);
 }
});

test('reading the initial UI language does not register a pending settings draft',async({page,request})=>{
 const before=await(await request.get('/api/config')).json();
 await page.addInitScript(()=>{
  localStorage.setItem('mana-language','en');
  const original=window.addEventListener;
  (window as any).preventedLanguageUnload=false;
  window.addEventListener=function(type:string,listener:any,options?:any){
   if(type==='beforeunload'){
    const probe=new Event('beforeunload',{cancelable:true});listener(probe);
    if(probe.defaultPrevented)(window as any).preventedLanguageUnload=true;
   }
   return original.call(window,type,listener,options);
  } as typeof window.addEventListener;
 });
 await page.goto('/');
 await expect(page.getByRole('button',{name:'Start chat',exact:true}).first()).toBeVisible();
 expect(await(await request.get('/api/config')).json()).toEqual(before);
 expect(await page.evaluate(()=>(window as any).preventedLanguageUnload)).toBe(false);
});
