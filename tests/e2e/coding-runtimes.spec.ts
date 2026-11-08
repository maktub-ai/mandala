import {defaultPreferences,themeStorageKey} from '../../shared/themes';
import {putRuntimeConfig} from './helpers/runtime-config';
import {test,expect} from './helpers/execution-fixture';
import {chooseOption} from './helpers/select';
import {waitForAutosave} from './helpers/settings';
import {runtimeIds} from '../../shared/runtimes';

test('local coding runtimes are configurable and only tools-disabled runtimes can run system tasks',async({page,request})=>{
 const {revision}=await (await request.get('/api/config')).json();
 expect((await putRuntimeConfig(request, {version:2,projects:[],agents:[],runtimes:[...runtimeIds]})).ok()).toBe(true);
 await page.route('**/api/cli/status?**',route=>route.fulfill({json:{status:'ready',version:'fixture'}}));
 await page.route('**/api/models?**',route=>{const cli=new URL(route.request().url()).searchParams.get('cli');return route.fulfill({json:[{id:cli+'-fixture',label:cli+' fixture'}]});});
 await page.goto('/settings/runtimes');
 await expect(page.locator('.runtime-connection')).toHaveCount(14);
 for(const cli of ['codebuddy','pi','cursor','kimi','dsh','antigravity','grok','hermes','openclaw'])await expect(page.locator(`[data-runtime-configure="${cli}"]`)).toBeVisible();
 for(const cli of ['trae'])await expect(page.locator(`[data-runtime-configure="${cli}"]`)).toHaveCount(0);
 await page.locator('[data-runtime-configure="pi"]').click();
 await chooseOption(page,page.getByRole('combobox',{name:'Pi 模型',exact:true}),'pi-fixture');
 await waitForAutosave(page);
 let saved=(await (await request.get('/api/config')).json()).config;
 expect(saved.chatDefaults.pi.model).toBe('pi-fixture');
 await page.goto('/settings/system');
 const choices=page.getByRole('radiogroup',{name:'系统任务执行端',exact:true});
 await expect(choices.getByRole('radio',{name:'Cursor Agent',exact:true})).toBeDisabled();
 await expect(choices.getByRole('radio',{name:'Antigravity',exact:true})).toBeDisabled();
 await expect(choices.getByRole('radio',{name:'Hermes Agent',exact:true})).toBeDisabled();
 await expect(choices.getByRole('radio',{name:'OpenClaw',exact:true})).toBeDisabled();
 await choices.getByRole('radio',{name:'Pi',exact:true}).click();await waitForAutosave(page);
 saved=(await (await request.get('/api/config')).json()).config;expect(saved.system.cli).toBe('pi');
 await page.reload();await expect(choices.getByRole('radio',{name:'Pi',exact:true})).toHaveAttribute('data-state','checked');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for(const [cli,label] of [['hermes','Hermes Agent'],['openclaw','OpenClaw']] as const){
 test(`${label} can be added, saved, disabled and selected in Agent and chat`,async({page,request,executionDirectory},testInfo)=>{
  expect((await putRuntimeConfig(request,{version:2,runtimes:['codex','omp'],runtimeDefaults:{codex:{fullAccess:false}},
   projects:[{id:'gateway-project',name:'Gateway test',cwd:executionDirectory,agentIds:['gateway-agent'],resources:[],mcp:[],skills:[]}],
   agents:[{id:'gateway-agent',name:'Gateway Agent',instructions:'Temporary UI test',defaultCli:'codex',models:{},mcp:[],skills:[]}]})).ok()).toBe(true);
  await page.route('**/api/cli/status?**',route=>route.fulfill({json:{status:'ready',version:'protocol-fixture'}}));
  await page.route('**/api/models?**',route=>route.fulfill({json:[{id:'native-model',label:'Native default',isDefault:true}]}));
  await page.goto('/settings/runtimes/new?runtime='+cli);
  await expect(page.getByRole('combobox',{name:'选择 CLI',exact:true})).toHaveAttribute('data-value',cli);
  await expect(page.getByText(/原生 Gateway 执行任务/)).toBeVisible();
  if(cli==='openclaw')await expect(page.getByText(/不支持会话级 MCP 绑定/)).toBeVisible();
  await chooseOption(page,page.getByRole('combobox',{name:'审批模式',exact:true}),'strict');
  await chooseOption(page,page.getByRole('combobox',{name:label+' 模型',exact:true}),'native-model');
  await page.getByRole('button',{name:'启用 CLI',exact:true}).click();await expect(page).toHaveURL('/settings/runtimes');
  await page.reload();await page.locator(`[data-runtime-configure="${cli}"]`).click();
  await expect(page.getByRole('combobox',{name:'审批模式',exact:true})).toHaveAttribute('data-value','strict');
  await expect(page.getByRole('combobox',{name:label+' 模型',exact:true})).toHaveAttribute('data-value','native-model');
  for(const theme of ['light','dark'])for(const width of [1280,390]){
   await page.setViewportSize({width,height:900});await page.evaluate(({key,value})=>{localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},{key:themeStorageKey,value:JSON.stringify({...defaultPreferences(),mode:theme})});
   await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
   await expect(page.getByRole('button',{name:'停用 CLI',exact:true})).toBeVisible();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:testInfo.outputPath(`${cli}-${theme}-${width}.png`),fullPage:true,animations:'disabled'});
  }
  await page.getByRole('button',{name:'停用 CLI',exact:true}).click();await expect(page).toHaveURL('/settings/runtimes');
  let saved=(await(await request.get('/api/config')).json()).config;
  expect(saved.runtimes).not.toContain(cli);expect(saved.runtimeDefaults[cli].approvalMode).toBe('strict');
  expect(saved.runtimeDefaults.codex.fullAccess).toBe(false);expect(saved.agents[0].defaultCli).toBe('codex');
  await page.goto('/settings/runtimes/new?runtime='+cli);await page.getByRole('button',{name:'启用 CLI',exact:true}).click();
  await expect(page).toHaveURL('/settings/runtimes');await page.setViewportSize({width:1280,height:900});
  await page.goto('/agents/gateway-agent?tab=settings');await chooseOption(page,'默认执行端',cli);await waitForAutosave(page);await page.reload();
  await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toHaveAttribute('data-value',cli);
  await page.goto('/?project=gateway-project&agent=gateway-agent');
  await expect(page.getByRole('combobox',{name:'当前 CLI',exact:true})).toHaveAttribute('data-value',cli);
  saved=(await(await request.get('/api/config')).json()).config;expect(saved.chatDefaults[cli].model).toBe('native-model');
 });
}
