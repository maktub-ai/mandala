import { seedRuleForEditing } from './helpers/automation';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { chooseOption } from './helpers/select';
import { mkdirSync } from 'node:fs';
async function seed(request: APIRequestContext, runtimes = ['omp']) {
 const { config:current, revision } = await (await request.get('/api/config')).json();
 const config={...current,version:2,runtimes,projects:[{id:'runtime-p',name:'Runtime Project',icon:'workflow',color:'#34785c',cwd:'/tmp',agentIds:['runtime-a'],resources:[],mcp:[],skills:[]}],agents:[...current.agents.filter((agent:any)=>agent.systemRole),{id:'runtime-a',name:'Runtime Agent',defaultCli:'codex',instructions:'Synthetic',models:{},mcp:[],skills:[]}]};
 expect((await request.put('/api/config',{data:{revision,config}})).ok()).toBe(true);
}
test('status transport failure reaches a terminal label and retry keeps catalog failure separate',async({page,request})=>{
 await seed(request,['codex']);let retry=false;
 await page.route('**/api/cli/status?*',route=>retry?route.fulfill({json:{status:'ready',version:'synthetic'}}):route.abort('failed'));
 await page.route('**/api/models?*',route=>retry?route.fulfill({status:500,json:{error:'Synthetic catalog failure'}}):route.fulfill({json:[]}));
 await page.goto('/settings/runtimes/codex');
 await expect(page.locator('.runtime-connection-status')).toHaveText('CLI 不可用');
 await expect(page.locator('.form-error')).toBeVisible();
 await page.locator('summary').filter({hasText:'连接诊断'}).click();retry=true;
 await page.getByRole('button',{name:'重新检测',exact:true}).click();
 await expect(page.locator('.runtime-connection-status')).toContainText('CLI 可启动');
 await expect(page.getByText('Synthetic catalog failure',{exact:true})).toBeVisible();
 await expect(page.locator('.runtime-connection-status')).not.toContainText('正在检测');
});
test('independent add cancels cleanly, saves meaningful defaults, configures and disables without losing defaults',async({page,request})=>{
 await seed(request);await page.goto('/settings/runtimes');
 await expect(page.locator('.runtime-connection')).toHaveCount(5);await expect(page.getByRole('region',{name:'Codex',exact:true})).toContainText('未启用');
 await page.getByRole('button',{name:'新增 CLI',exact:true}).click();
 await chooseOption(page,'选择 CLI','codex');
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--strict-config');
 await page.getByRole('button',{name:'返回 CLI 接入',exact:true}).click();
 expect((await (await request.get('/api/config')).json()).config.runtimes).toEqual(['omp']);
 await expect(page.getByRole('button',{name:'新增 CLI',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'新增 CLI',exact:true}).click();
 await chooseOption(page,'选择 CLI','codex');
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--strict-config');
 await chooseOption(page,'审批模式','auto');
 await chooseOption(page,'文件和网络权限','native');
 await page.getByRole('button',{name:'启用 CLI',exact:true}).click();
 await expect(page).toHaveURL('/settings/runtimes');await page.reload();
 const card=page.getByRole('region',{name:'Codex',exact:true});
 await expect(card.locator('[data-runtime="codex"]')).toBeVisible();await card.getByRole('button',{name:'配置',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('--strict-config');
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--profile\npersonal');
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.runtimeDefaults.codex.args).toEqual(['--profile','personal']);
 await page.getByRole('button',{name:'停用 CLI',exact:true}).click();
 await expect(page).toHaveURL('/settings/runtimes');
 const saved=(await (await request.get('/api/config')).json()).config;
 expect(saved.runtimes).toEqual(['omp']);expect(saved.runtimeDefaults.codex).toEqual({args:['--profile','personal'],approvalMode:'auto',fullAccess:false});
});
test('invalid input and revision conflicts preserve input until a deliberate reload',async({page,request})=>{
 await seed(request,['codex']);await page.goto('/settings/runtimes/codex');
 await page.getByRole('button',{name:'添加环境变量引用',exact:true}).click();
 await expect(page.getByRole('button',{name:'保存配置',exact:true})).toHaveCount(0);
 await page.getByRole('textbox',{name:'变量名称',exact:true}).fill('SERVICE');await page.getByRole('textbox',{name:'环境变量来源名称',exact:true}).fill('SERVICE_SOURCE');
 await page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true}).fill('--strict-config');
 const current=await (await request.get('/api/config')).json();current.config.agents[0].name='External edit';
 await request.put('/api/config',{data:current});
 await expect(page.getByRole('alert')).toContainText('重新读取');
 await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('--strict-config');
 mkdirSync('/tmp/openmana-runtime-ui-visuals',{recursive:true});await page.setViewportSize({width:390,height:900});
 for(const theme of ['light','dark']) {await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);await page.getByRole('alert').scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/openmana-runtime-ui-visuals/${theme}-390-conflict.png`,fullPage:true});}
 let releaseReload!:()=>void,startedReload!:()=>void;
 const reloadGate=new Promise<void>(resolve=>{releaseReload=resolve;}),reloadStarted=new Promise<void>(resolve=>{startedReload=resolve;});
 let reloadReleased=false,prematureWrites=0;
 page.on('request',request=>{if(!reloadReleased&&new URL(request.url()).pathname==='/api/config'&&request.method()==='PUT')prematureWrites++;});
 await page.route('**/api/config',async route=>{if(route.request().method()==='GET'){startedReload();await reloadGate;}await route.continue();});
 const reloaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/config'&&response.request().method()==='GET');
 await page.getByRole('button',{name:'重新读取配置',exact:true}).click();await reloadStarted;
 try {
  await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('--strict-config');
  expect(prematureWrites).toBe(0);
 } finally {reloadReleased=true;releaseReload();}
 const refreshed=await reloaded;expect(refreshed.ok()).toBe(true);const latest=await refreshed.json();expect(latest.config.agents[0].name).toBe('External edit');
 await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveValue('');
 const saved=(await (await request.get('/api/config')).json()).config;
 expect(saved.agents[0].name).toBe('External edit');expect(saved.runtimeDefaults?.codex?.env).toBeUndefined();
});
test('configured missing/login entries stay visible, all-five add view is empty and keyboard selection works',async({page,request})=>{
 await seed(request,['codex','omp','claude','gemini','opencode']);
 await page.route('**/api/cli/status?*',route=>route.fulfill({json:{status:new URL(route.request().url()).searchParams.get('cli')==='omp'?'login-required':'unavailable',version:null}}));
 await page.route('**/api/models?*',route=>route.fulfill({status:400,json:{error:'Synthetic model error'}}));
 await page.goto('/settings/runtimes');await expect(page.locator('.runtime-connection')).toHaveCount(5);
 await expect(page.getByRole('region',{name:'OMP',exact:true})).toContainText('CLI 要求登录');
 await page.getByRole('button',{name:'新增 CLI',exact:true}).click();await expect(page.getByText('所有支持的 CLI 均已启用。')).toBeVisible();
 await page.getByRole('button',{name:'返回 CLI 接入',exact:true}).click();
 await page.getByRole('region',{name:'Gemini CLI',exact:true}).getByRole('button',{name:'配置',exact:true}).click();await expect(page.getByText('Synthetic model error',{exact:true})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'返回 CLI 接入',exact:true}).click();await expect(page.getByRole('region',{name:'Gemini CLI',exact:true}).getByRole('button',{name:'配置',exact:true})).toBeFocused();
 await seed(request);await page.goto('/settings/runtimes/new');
 await page.getByRole('combobox',{name:'选择 CLI',exact:true}).focus();await page.keyboard.press('Enter');
 mkdirSync('/tmp/openmana-runtime-ui-visuals',{recursive:true});await page.setViewportSize({width:390,height:900});
 for(const theme of ['light','dark']) {await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);await page.screenshot({path:`/tmp/openmana-runtime-ui-visuals/${theme}-390-add.png`,fullPage:true});}
 await page.keyboard.press('Enter');
 await expect(page.getByRole('combobox',{name:'选择 CLI',exact:true})).toHaveAttribute('data-value','codex');
});
test('automation Project trigger/menu use the saved project identity and Runtime glyph',async({page,request})=>{
 await seed(request,['codex']);await page.goto('/tasks?rules=1&project=runtime-p');
 const project=page.getByRole('combobox',{name:'项目筛选',exact:true});
 await expect(project.locator('[data-project-icon="workflow"]')).toBeVisible();
 await project.click();await expect(page.getByRole('option',{name:'Runtime Project',exact:true}).locator('[data-project-icon="workflow"]')).toBeVisible();await page.keyboard.press('Escape');
 await seedRuleForEditing(request,page,'runtime-p','runtime-a');await expect(page.getByRole('form',{name:'编辑计划',exact:true}).getByRole('combobox',{name:'执行方式',exact:true})).toHaveAttribute('data-value','independent');
 await expect(page.getByRole('combobox',{name:'执行端',exact:true}).locator('[data-runtime="codex"]')).toBeVisible();
});
test('synthetic Runtime pages remain usable in both themes at narrow/tablet/desktop widths',async({page,request})=>{
 await seed(request,['codex','omp','claude']);mkdirSync('/tmp/openmana-runtime-ui-visuals',{recursive:true});
 await page.route('**/api/cli/status?*',route=>route.fulfill({json:{status:'login-required',version:null}}));
 await page.route('**/api/models?*',route=>route.fulfill({json:[{id:'synthetic-model',label:'Synthetic model'}]}));
 for(const theme of ['light','dark'])for(const width of [390,768,1280]) {
  await page.addInitScript(value=>localStorage.setItem('mana-theme',value),theme);await page.setViewportSize({width,height:900});await page.goto('/settings/runtimes');
  await expect(page.getByRole('region',{name:'Codex',exact:true})).toContainText('CLI 要求登录');
  await page.screenshot({path:`/tmp/openmana-runtime-ui-visuals/${theme}-${width}-list.png`,fullPage:true});
  await page.getByRole('region',{name:'Codex',exact:true}).getByRole('button',{name:'配置',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true})).toBeVisible();
  await page.locator('summary').filter({hasText:'连接诊断'}).click();
  await page.locator('.settings-main').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:`/tmp/openmana-runtime-ui-visuals/${theme}-${width}-config.png`,fullPage:true});
  await page.locator('.runtime-actions').scrollIntoViewIfNeeded();
  await page.screenshot({path:`/tmp/openmana-runtime-ui-visuals/${theme}-${width}-config-bottom.png`,fullPage:true});
  await page.getByRole('combobox',{name:'审批模式',exact:true}).click();
  await page.screenshot({path:`/tmp/openmana-runtime-ui-visuals/${theme}-${width}-select.png`,fullPage:true});await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
