import {test,expect} from './helpers/execution-fixture';
import {chooseOption} from './helpers/select';
import {waitForAutosave} from './helpers/settings';

test('SC1 appearance applies and persists immediately without a save button',async({page})=>{
 await page.goto('/settings/general');
 await page.getByRole('button',{name:'GitHub Light',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-palette','github-light');
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('mandala-appearance-v1')??'null')?.light)).toBe('github-light');
 await expect(page.getByRole('button',{name:/保存外观|Save appearance/})).toHaveCount(0);
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-palette','github-light');
 await page.setViewportSize({width:390,height:844});
 const footer=await page.locator('.theme-save-bar').boundingBox(),last=await page.locator('.theme-palette').last().boundingBox();
 expect(footer!.y).toBeGreaterThanOrEqual(last!.y+last!.height);
});

test('SC2 system preferences use switches and one model control with custom fallback',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,runtimes:['codex','omp'],projects:[],agents:[]}}});
 await page.route('**/api/models?**',route=>route.fulfill({json:[{id:'sample-model',label:'Sample model'}]}));
 await page.goto('/settings/system');
 const title=page.getByRole('region',{name:'自动标题',exact:true});
 const toggle=title.getByRole('switch',{name:'自动生成对话标题',exact:true});
 await toggle.check();await waitForAutosave(page);
 await expect(title.getByRole('combobox')).toHaveCount(2);
 await expect(title.getByRole('textbox',{name:'模型',exact:true})).toHaveCount(0);
 await chooseOption(page,title.getByRole('combobox',{name:'模型',exact:true}),'sample-model');
 await title.getByRole('combobox',{name:'模型',exact:true}).click();
 await page.getByRole('searchbox',{name:'模型 · 搜索选项',exact:true}).fill('my/private-model');
 await page.getByRole('option',{name:/my\/private-model/}).click();await waitForAutosave(page);
 expect((await(await request.get('/api/config')).json()).config.system.tasks.title.model).toBe('my/private-model');
 await page.reload();await expect(title.getByRole('combobox',{name:'模型',exact:true})).toHaveAttribute('data-value','my/private-model');
 await expect(toggle).toBeChecked();
});

test('SC3 shortcuts live in settings and sidebar rows use switches with keyboard ordering',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'用户菜单',exact:true}).click();
 const menu=page.getByRole('menu',{name:'用户菜单',exact:true});
 await expect(menu.getByRole('button',{name:'快捷键',exact:true})).toHaveCount(0);
 await menu.locator('[data-area=settings]').click();
 await page.getByRole('button',{name:'快捷键',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'快捷键',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 const modules=page.getByRole('region',{name:'侧边栏模块',exact:true});
 await modules.getByRole('switch',{name:'显示市场',exact:true}).check();
 const handle=modules.getByRole('button',{name:'调整市场顺序',exact:true});
 await handle.focus();await handle.press('ArrowUp');
 await page.reload();await expect(modules.getByRole('switch',{name:'显示市场',exact:true})).toBeChecked();
 expect(await modules.locator('.module-visibility-row').evaluateAll(rows=>rows.map(row=>row.textContent?.trim()))).toEqual(['任务','项目','市场','智能体','资料库','记忆','自动化','用量','设置']);
});

for(const scene of [{width:1280,language:'en',theme:'dark'},{width:390,language:'zh-CN',theme:'light'}])test(`SC4 menu is unclipped and settings fields align ${scene.width}`,async({page})=>{
 const en=scene.language==='en';
 await page.addInitScript(scene=>{localStorage.setItem('mana-language',scene.language);localStorage.setItem('mana-theme',scene.theme);},scene);
 await page.setViewportSize({width:scene.width,height:850});
 await page.route('**/auth/session',route=>route.fulfill({json:{mode:'local',user:{id:'synthetic-menu',username:'Preview'},connection:null}}));
 await page.route('**/api/models?**',route=>route.fulfill({json:[]}));
 await page.goto('/settings/system');
 for(const row of await page.locator('.system-profile-fields').all()){
  const fields=await row.locator('.ui-select-trigger').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {y:b.y,h:b.height};}));
  if(scene.width>600){expect(Math.abs(fields[0].y-fields[1].y)).toBeLessThan(1);expect(fields[0].h).toBe(fields[1].h);}
 }
 if(scene.width<600)await page.getByRole('button',{name:en?'Open sidebar':'打开侧栏',exact:true}).click();
 await page.getByRole('button',{name:en?'User menu':'用户菜单',exact:true}).click();
 const menu=page.getByRole('menu',{name:en?'User menu':'用户菜单',exact:true});
 await expect(menu.getByRole('menuitem',{name:en?'Command palette':'命令面板',exact:true})).toHaveCount(0);
 await expect(menu.getByRole('menuitem',{name:en?'Account':'账号',exact:true})).toBeVisible();
 await expect(menu).toHaveCSS('opacity','1');
 const rows=await menu.locator('.sidebar-destination').evaluateAll(nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,bg:getComputedStyle(node).backgroundColor})));
 expect(Math.max(...rows.map(row=>row.height))-Math.min(...rows.map(row=>row.height))).toBeLessThanOrEqual(1);
 await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('SC5 Runtime automatic save fails visibly, retains input and retries without a save form',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,runtimes:['codex'],projects:[],agents:[]}}});
 let fail=true;
 await page.route('**/api/config',route=>route.request().method()==='PUT'&&route.request().postDataJSON()?.config.runtimeDefaults?.codex?.args?.[0]==='--profile'&&fail?route.fulfill({status:500,json:{error:'Synthetic automatic save failure'}}):route.continue());
 await page.goto('/settings/runtimes/codex');
 const args=page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true});
 await args.fill('--profile\nkeep-this');
 await expect(page.getByRole('alert')).toContainText('Synthetic automatic save failure');
 await expect(args).toHaveValue('--profile\nkeep-this');
 expect((await(await request.get('/api/config')).json()).config.runtimeDefaults?.codex?.args).toBeUndefined();
 fail=false;await page.getByRole('button',{name:'重试自动保存',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.runtimeDefaults?.codex?.args).toEqual(['--profile','keep-this']);
 await page.reload();await expect(args).toHaveValue('--profile\nkeep-this');
});

test('SC6 Progress exposes linked chats once and keeps unlinked same-title work separate',async({page,request})=>{
 const f=await(await request.post('/__test__/progress-fixture')).json();
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'cleanup-same-title-'+f.long},data:{goal:f.longTitle}});expect(response.ok()).toBe(true);const sameTitleTask=await response.json();
 await page.goto('/tasks?view=list');
 const root=page.locator('.progress-item').filter({has:page.locator('.progress-item-title[href="/tasks/'+f.task+'?view=list"]')});
 await expect(root.getByRole('button',{name:/展开详情/})).toContainText('1 个关联对话');
 await expect(page.locator('[data-conversation-id="'+f.recent+'"]')).toHaveCount(0);
 await root.getByRole('button',{name:/展开详情/}).click();await expect(root.locator('[data-linked-conversation-id="'+f.recent+'"]')).toBeVisible();
 const chat=page.locator('[data-conversation-id="'+f.long+'"]');
 await expect(chat).toBeVisible();await expect(chat.locator('.progress-item-preview')).toHaveCount(0);
 await expect(page.getByRole('region',{name:'进行中与最近',exact:true})).toBeVisible();
 await expect(page.locator('.progress-item:has(.progress-item-title[href="/tasks/'+sameTitleTask.id+'?view=list"]), [data-conversation-id="'+f.long+'"]').locator('.progress-item-title').filter({hasText:f.longTitle.slice(0,70)})).toHaveCount(2);
 await chat.getByRole('button',{name:/展开详情/}).click();await expect(chat.locator('.progress-item-title')).toHaveText(f.longTitle);
});


test('SC7 leaving Runtime immediately flushes input and explicit conflict reload never replays stale input',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,runtimes:['codex'],projects:[],agents:[],runtimeDefaults:{codex:{args:['--baseline']}}}}});
 await page.goto('/settings/runtimes/codex');
 const args=page.getByRole('textbox',{name:'启动参数（每行一个）',exact:true});
 await args.fill('--rapid-back');await page.getByRole('button',{name:'返回 CLI 接入',exact:true}).click();
 await expect(page).toHaveURL('/settings/runtimes');
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.runtimeDefaults?.codex?.args).toEqual(['--rapid-back']);
 await page.getByRole('region',{name:'Codex',exact:true}).getByRole('button',{name:'配置',exact:true}).click();
 await expect(args).toHaveValue('--rapid-back');
 const external=await(await request.get('/api/config')).json();external.config.runtimeDefaults.codex.args=['--external-version'];
 expect((await request.put('/api/config',{data:external})).ok()).toBe(true);
 await args.fill('--stale-local-version');await expect(page.getByRole('alert')).toContainText('配置');
 await expect(args).toHaveValue('--stale-local-version');
 await page.getByRole('button',{name:'重新读取配置',exact:true}).click();
 await expect(args).toHaveValue('--external-version');
 await expect(page.locator('.settings-autosave')).toContainText('所有修改已保存');
 expect((await(await request.get('/api/config')).json()).config.runtimeDefaults.codex.args).toEqual(['--external-version']);
 await page.reload();await expect(args).toHaveValue('--external-version');
});

test('SC8 selecting inherited system model does not create a profile that drops inherited model',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,runtimes:['codex'],projects:[],agents:[],system:{cli:'codex',model:'system-default-model'}}}});
 await page.route('**/api/models?**',route=>route.fulfill({json:[]}));
 await page.goto('/settings/system');const title=page.getByRole('region',{name:'自动标题',exact:true});
 await chooseOption(page,title.getByRole('combobox',{name:'模型',exact:true}),'');await waitForAutosave(page);
 const config=(await(await request.get('/api/config')).json()).config;
 expect(config.system.tasks?.title).toBeUndefined();expect(config.system.model).toBe('system-default-model');
});

test('SC9 custom model IME confirmation does not select until a real Enter',async({page})=>{
 await page.route('**/api/models?**',route=>route.fulfill({json:[]}));await page.goto('/settings/system');
 await page.getByRole('region',{name:'自动标题',exact:true}).getByRole('combobox',{name:'模型',exact:true}).click();
 const search=page.getByRole('searchbox',{name:'模型 · 搜索选项',exact:true});await search.fill('私有模型');
 await search.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:false});
 await expect(page.getByRole('listbox',{name:'模型',exact:true})).toBeVisible();
 await search.press('Enter');await expect(page.getByRole('region',{name:'自动标题',exact:true}).getByRole('combobox',{name:'模型',exact:true})).toHaveAttribute('data-value','私有模型');
});
