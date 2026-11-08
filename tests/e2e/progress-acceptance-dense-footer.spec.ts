// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
test.describe('Progress 用户目标验收',()=>{test('P37 long status new activity and owner stay readable across viewport and themes',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();const cfg=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:cfg.revision,config:{...cfg.config,agents:cfg.config.agents.map((a:{id:string})=>a.id==='progress-planner'?{...a,name:'Release Architecture and Cross-Team Coordination — Very Long Owner 名称'}:a)}}});
 await request.post('/api/conversations/'+d.long+'/messages',{data:{text:'approval'}});await expect.poll(async()=>(await(await request.get('/api/conversations/'+d.long)).json()).approvals.length).toBe(1);await request.post('/api/conversation-progress/'+d.long,{data:{action:'complete'}});await request.post('/__test__/progress-update',{data:{id:d.long,kind:'late'}});
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.goto('/tasks?type=conversations');const card=page.locator('[data-conversation-id="'+d.long+'"]');
 for(const theme of ['light','dark'])for(const width of [1280,1008,768,390]){await page.setViewportSize({width,height:850});await page.evaluate(value=>{localStorage.removeItem('mandala-appearance-v1');localStorage.setItem('mana-theme',value);},theme);await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await expect(card).toContainText('New activity');await expect(card).toContainText('Needs attention');
  expect(await card.locator('.progress-state').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(await card.locator('.progress-new').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await expect(card.locator('.progress-expand')).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await card.locator('.progress-expand').click();await expect(card.locator('.progress-item-title')).toHaveAttribute('title',d.longTitle);await page.screenshot({path:'/tmp/mandala-task-compat/audit/2026-10-23-progress-acceptance/footer-'+theme+'-'+width+'.png',fullPage:true});await card.locator('.progress-expand').click();
 }

});});
