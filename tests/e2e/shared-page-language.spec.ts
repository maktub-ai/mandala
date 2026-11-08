import {test,expect} from '@playwright/test';
for(const width of [1440,390])test(`one page header and shared settings navigation ${width}`,async({page},info)=>{
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.setViewportSize({width,height:950});
 for(const route of ['/tasks','/agents','/projects','/market','/library','/mana?tab=memory','/schedules','/usage','/settings/general']){
  await page.goto(route);await expect(page.locator('main .workspace-page-header').first()).toBeVisible();
  await expect(page.locator('.task-location-bar,.market-location-bar,.library-location-bar,.mana-location,.usage-location-bar,.settings-location-bar')).toHaveCount(0);
  if(route==='/agents'||route==='/projects')await expect(page.locator('.settings-page-header')).toHaveCount(0);
  if(route==='/settings/general'){const nav=page.getByRole('navigation',{name:'Settings and connections'});await expect(nav).toBeVisible();const heading=await page.locator('.workspace-page-heading').boundingBox(),navigation=await nav.boundingBox();expect(Math.abs(heading!.x-navigation!.x)).toBeLessThan(2);if(width>1000){const links=await nav.locator('a').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));expect(new Set(links).size).toBe(1);}}
  if(width===390){await page.getByRole('button',{name:'Open sidebar',exact:true}).click();await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible();await page.keyboard.press('Escape');}
  expect(await page.locator('main').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(route.replace(/[^a-z0-9]+/gi,'-')+'.png'),fullPage:true});
 }
});

test('mobile detail pages retain the shared sidebar entry',async({page,request})=>{
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.setViewportSize({width:390,height:950});
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Mobile detail navigation'}})).json();
 const asset=await(await request.post('/api/v2/assets',{data:{kind:'document',title:'Mobile resource navigation'}})).json();
 for(const route of ['/tasks/'+task.id,'/library/'+asset.id]){await page.goto(route);const toggle=page.getByRole('button',{name:'Open sidebar',exact:true});await expect(toggle).toBeVisible();await toggle.click();await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible();await page.keyboard.press('Escape');}
});

test('deleting the last Agent keeps autosave visible in the directory header',async({page,request})=>{
 const snapshot=await(await request.get('/api/config')).json();snapshot.config.agents=[{id:'last-header-agent',name:'Last header Agent',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];snapshot.config.projects=[];await request.put('/api/config',{data:snapshot});
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.goto('/agents/last-header-agent');
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);await page.route('**/api/config',async route=>{if(route.request().method()==='PUT')await gate;await route.continue();});
 await page.getByRole('button',{name:'Object actions'}).click();await page.getByRole('menuitem',{name:'Delete Agent',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Delete Agent',exact:true}).click();
 await expect(page).toHaveURL(/\/agents$/);await expect(page.locator('.workspace-page-header .settings-autosave')).toBeVisible();await expect(page.locator('.workspace-page-header .settings-autosave')).toHaveText(/Saving|Waiting/);release();await expect(page.locator('.workspace-page-header .settings-autosave')).toContainText('All changes saved');
});
