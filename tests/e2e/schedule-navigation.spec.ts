import {expect,test} from '@playwright/test';
import {storedUiState} from './helpers/preferences';

test.use({storageState:storedUiState('en')});
test('a pending manual schedule request does not lock navigation to other chats',async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json();
 const agent={id:'navigation-scheduler',name:'Navigation scheduler',instructions:'Synthetic regression fixture',defaultCli:'codex',models:{},mcp:[],skills:[]};
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent]}}})).ok()).toBe(true);
 const rule=await(await request.post('/api/automations',{data:{name:'Slow submission',instructions:'Synthetic navigation check',projectId:'',agentId:agent.id,cli:'codex',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 await page.goto('/schedules?schedule='+rule.id);
 let submitted=false;
 await page.route('**/api/automations/'+rule.id+'/run',async route=>{submitted=true;await new Promise<void>(resolve=>page.once('close',()=>resolve()));await route.abort().catch(()=>{});});
 await page.getByRole('article',{name:'Slow submission',exact:true}).getByRole('button',{name:'Run once',exact:true}).click();
 await expect.poll(()=>submitted).toBe(true);
 await expect(page.getByRole('button',{name:'Submitting…',exact:true})).toBeDisabled();
 const start=page.locator('.sidebar-start .new-chat');
 await expect(start).toBeEnabled({timeout:2000});
 await start.click();
 await expect(page).not.toHaveURL(/\/schedules/);
 await expect(page.locator('.composer')).toBeVisible();
});
