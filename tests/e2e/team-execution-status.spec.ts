import {test,expect} from '@playwright/test';

test.use({storageState:{cookies:[],origins:[]}});
for(const width of [1440,390])for(const theme of ['light','dark'])test(`graph execution states stay distinct at ${width}px in ${theme}`,async({page,request})=>{
 await page.setViewportSize({width,height:1000});
 await page.addInitScript(({theme})=>{localStorage.setItem('mana-language','en');localStorage.setItem('mana-theme',theme);},{theme});
 const {revision}=await(await request.get('/api/config')).json();
 const agent={id:'status-agent',name:'Execution status Agent',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]};
 const project={id:'status-project',name:'Execution status Project',cwd:'',agentIds:[agent.id],resources:[],mcp:[],skills:[]};
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:[project],agents:[agent]}}})).ok()).toBe(true);
 const executions=['running','queued','approval','unknown'].map(state=>({id:state,kind:'run',conversationId:null,taskId:state,projectId:project.id,agentId:agent.id,state,title:'Synthetic '+state,href:null,time:'',accessible:false}));
 await page.route('**/api/workbench',route=>route.fulfill({json:{agents:[{id:agent.id,name:agent.name,executions}],errors:[]}}));
 await page.goto('/agents');
 for(const kind of ['agent','project']){
  const node=page.locator(`[data-graph-${kind}]`);
  for(const state of ['running','queued','approval','unknown']){
   const indicator=node.locator(`[data-state="${state}"]`);
   await expect(indicator).toHaveAttribute('aria-label',new RegExp(`${state} 1`,'i'));
   await expect(indicator).toBeVisible();
  }
  expect(await node.evaluate(el=>[...el.querySelectorAll('.organization-node-status, .organization-node-label')].every(child=>{const a=el.getBoundingClientRect(),b=child.getBoundingClientRect();return b.left>=a.left&&b.right<=a.right&&b.bottom<=a.bottom;}))).toBe(true);
 }
 await page.locator('[data-graph-agent]').focus();await page.keyboard.press('Enter');
 const stats=page.locator('.organization-stats');
 await expect(stats).toContainText('Unknown');
 await expect(stats.locator('div').filter({has:page.locator('dt',{hasText:'Unknown'})}).locator('dd')).toHaveText('1');
 await page.screenshot({path:`audit/2026-10-20-rework/team-status-${width}-${theme}.png`,fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
