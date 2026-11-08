import {test,expect} from '@playwright/test';
import {storedUiState} from './helpers/preferences';
test.use({storageState:storedUiState('en')});
test('earlier delayed refresh must retain a subsequent accepted receipt',async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json();
 const agent={id:'receipt-review',name:'Receipt review',instructions:'Synthetic',defaultCli:'codex',models:{},mcp:[],skills:[]};
 await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}});
 const rule=await(await request.post('/api/automations',{data:{name:'Receipt review',instructions:'Synthetic',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 const runs=[1,2].map(i=>({id:'receipt-'+i,automationId:rule.id,name:rule.name,projectId:'',agentId:agent.id,cli:'codex',instructions:'Synthetic',status:'queued',createdAt:'2026-10-31T00:00:0'+i+'.000Z',scheduledAt:'2026-10-31T00:00:0'+i+'.000Z'}));
 let posts=0,held=false,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/api/automations',async route=>{
  if(posts===0)return route.fulfill({json:{version:1,automations:[rule],runs:[]}});
  if(posts===1&&!held){held=true;await gate;return route.fulfill({headers:{'x-fixture-old':'1'},json:{version:1,automations:[rule],runs:[runs[0]]}});}
  return route.fulfill({status:503,json:{error:'Synthetic later refresh failure'}});
 });
 await page.route('**/api/automations/'+rule.id+'/run',route=>route.fulfill({json:runs[posts++]}));
 await page.goto('/schedules?schedule='+rule.id);
 const plan=page.getByRole('article',{name:rule.name,exact:true}),history=page.locator('.schedule-detail-history .automation-run');
 await plan.getByRole('button',{name:'Run once',exact:true}).click();await expect.poll(()=>held).toBe(true);await expect(history).toHaveCount(1);
 await plan.getByRole('button',{name:'Run once',exact:true}).click();await expect(history).toHaveCount(2);await expect(page.getByRole('alert')).toContainText('Refresh failed');
 const oldResponse=page.waitForResponse(response=>response.headers()['x-fixture-old']==='1');release();await(await oldResponse).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(history).toHaveCount(2);
});
for(const action of ['stop','enable'] as const)test('a pre-mutation poll cannot regress accepted '+action,async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json(),agent={id:'ordering-'+action,name:'Ordering '+action,instructions:'Synthetic',defaultCli:'codex',models:{},mcp:[],skills:[]};await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}});
 const rule=await(await request.post('/api/automations',{data:{name:agent.name,instructions:'Synthetic',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'weekly',weekdays:[1,2,3,4,5],time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 const run={id:'same-run-'+action,automationId:rule.id,name:rule.name,projectId:'',agentId:agent.id,cli:'codex',instructions:'Synthetic',status:'running',createdAt:'2026-10-31T00:00:00.000Z',scheduledAt:'2026-10-31T00:00:00.000Z'};
 let reads=0,held=false,mutated=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/automations',async route=>{if(mutated)return route.fulfill({status:503,json:{error:'Synthetic refresh failure'}});if(reads++>0){held=true;await gate;return route.fulfill({headers:{'x-fixture-old':action},json:{version:1,automations:[rule],runs:[run]}});}return route.fulfill({json:{version:1,automations:[rule],runs:[run]}});});
 await page.route('**/api/automations/'+(action==='stop'?run.id+'/stop':rule.id),route=>{mutated=true;return route.fulfill({json:action==='stop'?{...run,status:'interrupted'}:{...rule,revision:2,enabled:true,nextRunAt:'2026-11-02T01:00:00.000Z'}});});
 await page.clock.install();await page.goto('/schedules?schedule='+rule.id);const plan=page.getByRole('article',{name:rule.name,exact:true}),history=page.locator('.schedule-detail-history');await expect(plan).toBeVisible();await page.clock.fastForward(3001);await expect.poll(()=>held).toBe(true);
 if(action==='stop')await history.getByRole('button',{name:'Stop this run',exact:true}).click();else await plan.getByRole('button',{name:'Enable schedule',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Refresh failed');
 const old=page.waitForResponse(response=>response.headers()['x-fixture-old']===action);release();await(await old).finished();await page.clock.runFor(50);
 if(action==='stop')await expect(history).toContainText('Interrupted');else{await expect(plan.getByRole('button',{name:'Pause future runs',exact:true})).toBeVisible();await expect(plan).toContainText('Next run:');}
});
test('remount and retry dispose old polling before a delayed live read completes',async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json(),agent={id:'poll-lifecycle',name:'Poll lifecycle',instructions:'Synthetic',defaultCli:'codex',models:{},mcp:[],skills:[]};await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}});
 const rule=await(await request.post('/api/automations',{data:{name:agent.name,instructions:'Synthetic',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 let reads=0,held=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/automations',async route=>{if(++reads<=2)return route.fulfill({status:503,json:{error:'Synthetic lifecycle outage'}});held=true;await gate;return route.fulfill({headers:{'x-fixture-live':'lifecycle'},json:{version:1,automations:[rule],runs:[]}});});
 await page.addInitScript(()=>{const fetcher=window.fetch;let abortedPolls=0;Object.defineProperty(window,'__abortedSchedulePolls',{get:()=>abortedPolls});window.fetch=(input,options)=>{if(String(input).endsWith('/api/automations')&&options?.signal?.aborted)abortedPolls++;return fetcher(input,options);};});
 await page.clock.install();await page.goto('/schedules');await expect(page.getByRole('alert')).toContainText('Synthetic lifecycle outage');await page.getByRole('link',{name:'Projects',exact:true}).click();await expect(page.getByRole('heading',{name:'Projects',exact:true})).toBeVisible();await page.evaluate(()=>{history.pushState(null,'','/schedules');dispatchEvent(new PopStateEvent('popstate'));});await expect(page.getByRole('alert')).toContainText('Synthetic lifecycle outage');
 await page.clock.fastForward(1000);await page.getByRole('button',{name:'Retry schedules',exact:true}).click();await expect.poll(()=>held).toBe(true);
 // The disposed effect's original 3s interval would fire while this new read is
 // pending, increment its ordering clock and discard the valid response.
 await page.clock.runFor(2100);expect(await page.evaluate(()=>(window as Window&{__abortedSchedulePolls?:number}).__abortedSchedulePolls)).toBe(0);const live=page.waitForResponse(response=>response.headers()['x-fixture-live']==='lifecycle');release();await(await live).finished();await page.clock.runFor(50);await expect(page.getByRole('button',{name:rule.name,exact:true})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});
