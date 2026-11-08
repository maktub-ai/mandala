import {expect,test,type APIRequestContext} from '@playwright/test';
import {chooseOption,enterModelId} from './helpers/select';
import {waitForAutosave} from './helpers/settings';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

async function fixture(request:APIRequestContext) {
 const {config,revision}=await(await request.get('/api/config')).json();
 const agent={id:'inline-agent',name:'Runtime Integration',instructions:'Review runtime integration.',defaultCli:'codex',models:{codex:'codex-existing',omp:'omp-existing'},mcp:[],skills:[]};
 const next={...config,runtimes:['codex','omp'],agents:[agent,...config.agents.filter((item:{systemRole?:string})=>item.systemRole)],projects:[{id:'inline-project',name:'Shared project',cwd:'/tmp',agentIds:[agent.id],resources:[],mcp:[],skills:[]}],connections:[{id:'inline-connection',name:'sample_connection',transport:'http',url:'https://example.com/mcp'}]};
 const response=await request.put('/api/config',{data:{revision,config:next}});
 expect(response.ok(),await response.text()).toBe(true);
 return agent;
}

test('settings exposes runtime and model directly and preserves each runtime default',async({page,request})=>{
 const agent=await fixture(request);
 await page.route('**/api/models?*',route=>route.fulfill({json:[{id:'catalog-model',label:'Catalog model'}]}));
 await page.goto('/agents/'+agent.id+'?tab=settings');
 await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'Codex 默认模型',exact:true})).toHaveAttribute('data-value','codex-existing');
 await expect(page.getByRole('button',{name:'配置',exact:true})).toHaveCount(0);
 await chooseOption(page,'默认执行端','omp');
 await expect(page.getByRole('combobox',{name:'OMP 默认模型',exact:true})).toHaveAttribute('data-value','omp-existing');
 await enterModelId(page,'OMP 默认模型','custom-omp');await waitForAutosave(page);
 await chooseOption(page,'默认执行端','codex');await waitForAutosave(page);
 await page.reload();
 await expect(page.getByRole('combobox',{name:'Codex 默认模型',exact:true})).toHaveAttribute('data-value','codex-existing');
 const saved=(await(await request.get('/api/config')).json()).config;
 expect(saved.agents[0].models).toEqual({codex:'codex-existing',omp:'custom-omp'});
 expect(saved.projects[0].agentIds).toEqual([agent.id]);
});

test('identity edits autosave together and overview displays them without another editor',async({page,request})=>{
 const agent=await fixture(request);await page.goto('/agents/'+agent.id+'?tab=settings');
 await page.getByRole('textbox',{name:'名称',exact:true}).fill('Renamed integration');
 await page.getByRole('textbox',{name:'职责与指令',exact:true}).fill('# Integration responsibilities\n\nKeep runtime changes scoped.');
 await chooseOption(page,page.getByRole('combobox',{name:/回答风格/,exact:false}),'concise');await waitForAutosave(page);
 await page.getByRole('tab',{name:'概览',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Integration responsibilities',exact:true})).toBeVisible();
 await expect(page.locator('.agent-overview').getByRole('textbox')).toHaveCount(0);
 await expect(page.locator('.agent-overview').getByRole('combobox')).toHaveCount(0);
 await page.getByRole('tab',{name:'设置',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'名称',exact:true})).toHaveValue('Renamed integration');
 const saved=(await(await request.get('/api/config')).json()).config.agents[0];
 expect(saved.responseStyle).toBe('concise');expect(saved.instructions).toContain('Keep runtime changes scoped.');
});

test('compact resource actions retain the real connection assignment and legacy deep links',async({page,request})=>{
 const agent=await fixture(request);await page.goto('/agents/'+agent.id+'?tab=settings');
 await page.getByRole('button',{name:'添加连接',exact:true}).click();
 const manager=page.getByRole('dialog',{name:'MCP 连接',exact:true});
 await manager.getByRole('button',{name:'添加连接',exact:true}).click();
 const picker=page.getByRole('dialog',{name:'添加连接',exact:true});
 await picker.getByRole('checkbox',{name:'sample_connection',exact:true}).check();
 await picker.getByRole('button',{name:'添加所选',exact:true}).click();await waitForAutosave(page);
 await manager.getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('.agent-resource-row').filter({hasText:'MCP 连接'})).toContainText('sample_connection');
 expect((await(await request.get('/api/config')).json()).config.agents[0].connectionIds).toEqual(['inline-connection']);
 await page.goto('/agents/'+agent.id+'?tab=knowledge');
 await expect(page.getByRole('dialog',{name:'参考知识',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toBeVisible();
 await page.goto('/agents/'+agent.id+'?tab=execution');
 await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toBeVisible();
});

test('advanced permissions retain inherited policy and validate concurrency without changing other fields',async({page,request})=>{
 const agent=await fixture(request);await page.goto('/agents/'+agent.id+'?tab=settings');
 const advanced=page.locator('.agent-settings-advanced');await expect(advanced).not.toHaveAttribute('open','');
 await expect(advanced.locator(':scope > summary')).toContainText('3');await advanced.locator(':scope > summary').click();
 await expect(page.getByRole('region',{name:'审批规则',exact:true})).toBeVisible();
 await page.getByRole('spinbutton',{name:'后台并行上限',exact:true}).fill('2');await waitForAutosave(page);
 await page.reload();await page.locator('.agent-settings-advanced > summary').click();
 await expect(page.getByRole('spinbutton',{name:'后台并行上限',exact:true})).toHaveValue('2');
 await page.getByRole('spinbutton',{name:'后台并行上限',exact:true}).fill('0');
 await expect(page.getByRole('spinbutton',{name:'后台并行上限',exact:true})).toHaveValue('2');
 expect((await(await request.get('/api/config')).json()).config.agents[0].runtime).toBeUndefined();
});

test('settings and managers fit narrow screens with keyboard focus preserved',async({page,request})=>{
 const agent=await fixture(request);await page.setViewportSize({width:390,height:844});
 await page.goto('/agents/'+agent.id+'?tab=settings');
 await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const button=page.getByRole('button',{name:'添加技能',exact:true});await button.click();
 await expect(page.getByRole('dialog',{name:'技能',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(button).toBeFocused();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('inline edits retain drafts after a save failure and retry the same configuration',async({page,request})=>{
 const agent=await fixture(request);await page.goto('/agents/'+agent.id+'?tab=settings');
 await expect(page.getByRole('textbox',{name:'职责与指令',exact:true})).toBeVisible();
 await page.route('**/api/config',async route=>{if(route.request().method()==='PUT')await route.fulfill({status:500,json:{error:'Synthetic save failure'}});else await route.continue();});
 await page.getByRole('textbox',{name:'职责与指令',exact:true}).fill('Keep this unsaved draft.');
 await expect(page.locator('.settings-save-error')).toBeVisible();
 await expect(page.getByRole('textbox',{name:'职责与指令',exact:true})).toHaveValue('Keep this unsaved draft.');
 await expect(page.getByRole('button',{name:'管理执行端接入',exact:true})).toBeDisabled();
 await page.unroute('**/api/config');await page.getByRole('button',{name:'重试自动保存',exact:true}).click();await waitForAutosave(page);
 expect((await(await request.get('/api/config')).json()).config.agents[0].instructions).toBe('Keep this unsaved draft.');
});

test('advanced approval reset preserves other runtimes and recovers from a failed reset',async({page,request})=>{
 const agent=await fixture(request);
 for(const cli of ['codex','omp'])expect((await request.patch('/api/chat-preferences/approval',{data:{agentId:agent.id,cli,approvalMode:'auto'}})).ok()).toBe(true);
 let fail=true;
 await page.route('**/api/chat-preferences/approval',route=>route.request().method()==='PATCH'&&fail?route.fulfill({status:503,json:{error:'Synthetic reset unavailable'}}):route.continue());
 await page.goto('/agents/'+agent.id+'?tab=execution');await page.locator('.agent-settings-advanced > summary').click();
 const approval=page.getByRole('region',{name:'审批规则',exact:true});
 await expect(approval).toContainText('已为你记住');
 await approval.getByRole('button',{name:'使用 Agent 默认',exact:true}).click();
 await expect(approval.getByRole('alert')).toContainText('Synthetic reset unavailable');
 expect((await(await request.get('/api/chat-preferences/approval?agentId='+agent.id+'&cli=codex')).json()).approvalMode).toBe('auto');
 fail=false;await approval.getByRole('button',{name:'使用 Agent 默认',exact:true}).click();
 await expect(approval).toContainText('当前使用 Agent 默认');
 expect((await(await request.get('/api/chat-preferences/approval?agentId='+agent.id+'&cli=codex')).json()).approvalMode).toBeNull();
 expect((await(await request.get('/api/chat-preferences/approval?agentId='+agent.id+'&cli=omp')).json()).approvalMode).toBe('auto');
});

test('advanced approval read failures keep effective preferences unconfirmed',async({page,request})=>{
 const agent=await fixture(request);let finish:(()=>void)|undefined;
 await page.route('**/api/chat-preferences/approval?*',async route=>{await new Promise<void>(resolve=>{finish=resolve;});await route.fulfill({status:503,json:{error:'Synthetic preference unavailable'}});});
 await page.goto('/agents/'+agent.id+'?tab=settings');await page.locator('.agent-settings-advanced > summary').click();
 const approval=page.getByRole('region',{name:'审批规则',exact:true});
 await expect(approval.getByRole('status')).toContainText('正在读取聊天偏好');
 await expect(approval).not.toContainText('新对话使用');finish!();
 await expect(approval.getByRole('alert')).toContainText('Synthetic preference unavailable');
 await expect(approval).not.toContainText('当前使用 Agent 默认');
});

test('settings preserve saved appearance and fit desktop, tablet and mobile in both themes',async({page,request})=>{
 const agent=await fixture(request);
 await page.route('**/api/models?*',route=>route.fulfill({json:[]}));
 const output=process.env.MANDALA_REVIEW_DIR;if(output)mkdirSync(output,{recursive:true});
 for(const mode of ['dark','light'])for(const width of [1440,1024,768,390]){
  await page.goto('/agents/'+agent.id+'?tab=settings');
  await page.evaluate(mode=>localStorage.setItem('mana-theme',mode),mode);
  await page.setViewportSize({width,height:1100});await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
  await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('main.settings-main').evaluate(element=>{element.scrollTop=0;});
  if(output)await page.screenshot({path:join(output,`${mode}-${width}.png`)});
  if(output&&mode==='dark'&&(width===1440||width===390)){
   const advanced=page.locator('.agent-settings-advanced > summary');await advanced.click();
   await page.locator('.agent-settings-advanced').evaluate(element=>element.scrollIntoView({block:'start'}));
   await page.screenshot({path:join(output,`advanced-${width}.png`)});await advanced.click();
   await page.getByRole('button',{name:'添加技能',exact:true}).click();
   const manager=page.getByRole('dialog',{name:'技能',exact:true});await expect(manager).toBeVisible();
   await expect(page.locator('.team-native-capabilities .ui-loading')).toHaveCount(0);
   await expect(manager).toHaveCSS('opacity','1');
   await page.screenshot({path:join(output,`manager-${width}.png`),animations:'disabled'});await page.keyboard.press('Escape');
  }
 }
});
