import { test, expect } from './helpers/execution-fixture';
import type { MemoryJob } from '../../shared/memory';
for (const language of ['zh-CN', 'en'] as const) test(`background shows only active counts in ${language}`, async ({ page },testInfo) => {
 await page.addInitScript(language => localStorage.setItem('mana-language', language), language);
 const base:MemoryJob={id:'base',collectionId:'personal',principal:{userId:'local'},sourceRefs:[],generation:1,state:'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:'2050-01-01T00:00:00Z',createdAt:'2026-10-14T00:00:00Z',error:null,extractorVersion:'test',kind:'request',stage:'extract'};
 let jobs:MemoryJob[]=[
  {...base,id:'running',state:'running'},
  {...base,id:'waiting'},
  {...base,id:'retry',failureCount:1,error:'quota_exhausted'},
  {...base,id:'chunk',state:'pending',error:'needs_chunking'},
  {...base,id:'blocked',state:'pending',error:'unsupported_extract'},
  {...base,id:'exhausted',failureCount:2,error:'quota_exhausted'},
  {...base,id:'legacy',attempt:20,error:'invalid_proposal'},
  {...base,id:'failed',state:'failed',error:'dependency_not_provided'},
  {...base,id:'done',state:'completed'},
  {...base,id:'done-with-warning',state:'completed',error:'generation_timed_out'},
  {...base,id:'obsolete',state:'obsolete'},
 ];
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[],collections:[{id:'personal',projectId:null,agentId:null}]}}));
 await page.route('**/api/v2/memory/jobs', route => route.fulfill({ json: jobs }));
 await page.goto('/mana?tab=memory');
 const status=page.locator('.memory-processing');
 await expect(status).toHaveText(language==='en'?'Background processing · 1 processing · 3 waiting':'后台加工 · 1 项处理中 · 3 项待处理');
 await expect(page.locator('[data-job-id],.memory-result,.memory-job-diagnostics,[role=progressbar]')).toHaveCount(0);
 for(const theme of ['light','dark'])for(const width of [1280,390]){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.setViewportSize({width,height:844});
  await status.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`processing-${theme}-${width}.png`)});
 }
 jobs=jobs.filter(job=>!['running','waiting','retry','chunk'].includes(job.id));
 await expect(status).toHaveCount(0,{timeout:10000});
});
test('disabled generation excludes deep-memory work and retired session work stays hidden',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();
 try{
  const config={...current.config,system:{cli:'codex',...current.config.system,memory:{request:{generate:false},session:{generate:true}}}};
  expect((await request.put('/api/config',{data:{config,revision:current.revision}})).ok()).toBe(true);
  await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[],collections:[]}}));
  await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[{id:'paused',state:'queued',kind:'request'},{id:'active',state:'queued',kind:'session'}]}));
  const jobsLoaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v2/memory/jobs');
  await page.goto('/mana?tab=memory');
  await expect(page.getByRole('region',{name:'记忆索引',exact:true})).toBeVisible();
  expect((await jobsLoaded).ok()).toBe(true);
  await expect(page.getByRole('status',{name:'正在读取记忆',exact:true})).toHaveCount(0);
  await expect(page.locator('.memory-processing')).toHaveCount(0);
 }finally{
  const latest=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{config:current.config,revision:latest.revision}})).ok()).toBe(true);
 }
});
