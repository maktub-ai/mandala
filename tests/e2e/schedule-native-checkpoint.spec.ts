import {expect,test,type BrowserContext} from '@playwright/test';
import {storedUiState} from './helpers/preferences';
async function nativeCheckpoint(context:BrowserContext,values:Record<string,string>){
 await context.addInitScript(values=>{
  localStorage.setItem('mana-language','en');
  Object.defineProperty(window,'__nativeCheckpointFixture',{value:values});
  Object.defineProperty(window,'mandalaDesktop',{value:{platform:'linux',preferences:{read:()=>({...values}),write:(key:string,value:string)=>{values[key]=value;}}}});
 },values);
}
test('lost acknowledgement verifies the same occurrence from a different runtime origin',async({browser,request,baseURL})=>{
 const {config,revision}=await(await request.get('/api/config')).json(),agent={id:'native-checkpoint-executor',name:'Native checkpoint fixture',instructions:'Synthetic fixture',defaultCli:'codex',models:{},mcp:[],skills:[]};expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}})).ok()).toBe(true);
 const rule=await(await request.post('/api/automations',{data:{name:'Native checkpoint review',instructions:'hold',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,enabled:false,executionMode:'independent',schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 const first=await browser.newContext({storageState:storedUiState('en')});await nativeCheckpoint(first,{});const page=await first.newPage();let originalKey='',receiptId='';
 await page.route('**/api/automations/'+rule.id+'/run',async route=>{originalKey=route.request().headers()['idempotency-key'];const response=await route.fetch();receiptId=(await response.json()).id;await route.abort('failed');});
 await page.goto(baseURL+'/schedules?schedule='+rule.id);await page.getByRole('article',{name:rule.name,exact:true}).getByRole('button',{name:'Run once',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Run was not confirmed');await expect(page.getByRole('button',{name:'Check previous run',exact:true})).toBeVisible();
 const durable=await page.evaluate(()=>(window as Window&{__nativeCheckpointFixture?:Record<string,string>}).__nativeCheckpointFixture!);expect(JSON.stringify(durable)).toContain(originalKey);await first.close();
 const different=new URL(baseURL!);different.hostname='localhost';expect(different.origin).not.toBe(new URL(baseURL!).origin);
 const next=await browser.newContext();await nativeCheckpoint(next,durable);const restored=await next.newPage();let checkedKey='';await restored.route('**/api/automations/'+rule.id+'/run',route=>{checkedKey=route.request().headers()['idempotency-key'];return route.continue();});
 try{await restored.goto(different.origin+'/schedules?schedule='+rule.id);expect(await restored.evaluate(()=>localStorage.getItem('mandala-schedule-commands:fixture'))).toBeNull();await restored.getByRole('button',{name:'Check previous run',exact:true}).click();await expect.poll(()=>checkedKey).toBe(originalKey);await expect(restored.getByRole('button',{name:'Run once',exact:true})).toBeEnabled();const data=await(await request.get('/api/automations')).json(),runs=data.runs.filter((run:{automationId:string})=>run.automationId===rule.id);expect(runs).toHaveLength(1);expect(runs[0].id).toBe(receiptId);}finally{await next.close();}
});
test('unavailable stable checkpoint blocks the POST and reports that this click submitted nothing',async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json(),agent={id:'native-failure-executor',name:'Checkpoint failure fixture',instructions:'Synthetic',defaultCli:'codex',models:{},mcp:[],skills:[]};await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}});
 const rule=await(await request.post('/api/automations',{data:{name:agent.name,instructions:'Never submit',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 await page.addInitScript(()=>{localStorage.setItem('mana-language','en');Object.defineProperty(window,'mandalaDesktop',{value:{platform:'linux',preferences:{read:()=>{throw Error('Synthetic native unavailable');},write:()=>{throw Error('Synthetic native unavailable');}}}});});
 let submissions=0;await page.route('**/api/automations/'+rule.id+'/run',route=>{submissions++;return route.abort();});await page.goto('/schedules?schedule='+rule.id);await page.getByRole('article',{name:rule.name,exact:true}).getByRole('button',{name:'Run once',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'No run was submitted'})).toBeVisible();expect(submissions).toBe(0);
});
