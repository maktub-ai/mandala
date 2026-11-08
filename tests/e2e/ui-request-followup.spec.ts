import { seedRuleForEditing } from './helpers/automation';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { chooseOption } from './helpers/select';
import { openSidebar } from './helpers/navigation';
async function seed(request: APIRequestContext) {
 const {revision}=await (await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,runtimes:['codex','omp','claude','gemini','opencode'],projects:[{id:'icons-p',name:'Icon Project',icon:'star',color:'#34785c',cwd:'/tmp',agentIds:['icons-a'],resources:[],mcp:[],skills:[]}],agents:[{id:'icons-a',name:'Icon Agent',defaultCli:'codex',instructions:'Synthetic',models:{},avatarSeed:'saved-avatar',mcp:[],skills:[]}],chatDefaults:{codex:{model:'model-fixture',effort:'high'}}}}});
}
test('Runtime uses bundled product logos and new-chat defaults belong to its own automatic settings',async({page,request})=>{
 await seed(request);await page.goto('/settings/general');
 await expect(page.getByRole('combobox',{name:'Codex 模型',exact:true})).toHaveCount(0);
 await page.goto('/settings/runtimes');
 for(const cli of ['codex','omp','claude','gemini','opencode']){
  const logo=page.locator(`[data-runtime="${cli}"] img:visible`);await expect(logo).toBeVisible();
  await expect.poll(()=>logo.evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0)).toBe(true);
 }
 await page.locator('[data-runtime-configure="codex"]').click();
 await chooseOption(page,'Codex 模型','model-second');
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.chatDefaults.codex.model).toBe('model-second');
 await page.getByRole('button',{name:'返回已接入 Runtime',exact:true}).click();
 await page.locator('[data-runtime-configure="codex"]').click();await page.reload();
 expect((await (await request.get('/api/config')).json()).config.chatDefaults.codex.model).toBe('model-second');
 await page.goto('/?project=&agent=');await expect(page.getByRole('combobox',{name:'模型',exact:true})).toContainText('Second fixture');
});
test('new-chat selectors carry saved Project and Agent identities',async({page,request})=>{
 await seed(request);await page.goto('/?project=&agent=');
 for(const [label,value,kind] of [['当前项目','icons-p','project'],['当前 智能体','icons-a','agent']] as const){
  await chooseOption(page,label,value);
  const trigger=page.getByRole('combobox',{name:label,exact:true});await expect(trigger.locator(`[data-identity-kind="${kind}"]`)).toBeVisible();
  if(kind==='project')await expect(trigger.locator('[data-project-icon]')).toHaveAttribute('data-project-icon','star');
  await trigger.click();await expect(page.getByRole('option').filter({hasText:kind==='project'?'Icon Project':'Icon Agent'}).locator(`[data-identity-kind="${kind}"]`)).toBeVisible();await page.keyboard.press('Escape');
 }
});
test('Runtime product logos keep their compact size beside labels in Select triggers and options',async({page,request})=>{
 await seed(request);await page.goto('/tasks?rules=1&project=icons-p');await seedRuleForEditing(request,page,'icons-p','icons-a');
 const trigger=page.getByRole('combobox',{name:'执行端',exact:true});
 const compactLogo=async(container:typeof trigger)=>{
  const logo=container.locator('.runtime-logo');await expect(logo).toBeVisible();
  await expect.poll(()=>logo.locator('img:visible').evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0)).toBe(true);
  const box=await logo.boundingBox();expect(box).not.toBeNull();expect(box!.width).toBeLessThanOrEqual(20);expect(box!.width).toBeCloseTo(box!.height,0);
 };
 await compactLogo(trigger);await trigger.click();await compactLogo(page.getByRole('option',{name:'Codex',exact:true}));
});
for(const width of [1280,390])test(`user menu contains modules directly and Settings last with keyboard and focus at ${width}`,async({page,request})=>{
 await seed(request);await page.setViewportSize({width,height:844});await page.goto('/');await openSidebar(page);
 const nav=page.getByRole('navigation',{name:'主导航',exact:true});
 await expect(nav.getByRole('link',{name:'设置',exact:true})).toHaveCount(0);
 await expect(nav.getByRole('button',{name:'更多模块',exact:true})).toHaveCount(0);
 const trigger=nav.getByRole('button',{name:'用户菜单',exact:true});await trigger.click();
 const menu=page.getByRole('region',{name:'用户菜单',exact:true});await expect(menu.getByRole('link',{name:'设置',exact:true})).toBeVisible();
 await expect(menu.getByRole('link')).toHaveText(['市场','用量','设置']);
 await expect(menu.getByRole('button',{name:'更多模块',exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await trigger.click();await menu.getByRole('link',{name:'设置',exact:true}).click();await expect(page).toHaveURL('/settings/general');
});
test('retired summary organization never queues historical conversations',async({page,request})=>{
 await seed(request);const calls:unknown[]=[];
 await page.route('**/api/v2/memory/organize',route=>{calls.push(route.request().postDataJSON());return route.fulfill({json:{jobs:[]}});});
 await page.goto('/mana?tab=memory');
 await expect(page.getByRole('tab',{name:'会话摘要',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'立即整理',exact:true})).toHaveCount(0);
 await expect(page.getByRole('dialog',{name:'整理对话',exact:true})).toHaveCount(0);expect(calls).toEqual([]);
});
