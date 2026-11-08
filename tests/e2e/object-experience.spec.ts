import {expect, test} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {waitForAutosave} from './helpers/settings';

test.beforeEach(async ({request}) => {
 const {revision,config}=await (await request.get('/api/config')).json();
 const agents=['writer','reader'].map(id=>({id,name:id==='writer'?'Writer':'Reader',instructions:'Review evidence before answering.',defaultCli:'codex',models:{},mcp:[],skills:[]}));
 const projects=['alpha','beta'].map(id=>({id,name:id==='alpha'?'Alpha':'Beta',background:'Original background',cwd:'/tmp',resources:[],agentIds:id==='alpha'?['writer']:[],mcp:[],skills:[]}));
 expect((await request.put('/api/config',{data:{revision,config:{...config,projects,agents:[...config.agents.filter((agent:{systemRole?:string})=>agent.systemRole),...agents]}}})).ok()).toBe(true);
});

test('project edits in place and switches directly without losing saved background',async({page})=>{
 await page.goto('/projects/alpha/overview');
 await expect(page.getByRole('navigation',{name:'项目导航'}).getByRole('link')).toHaveText(['概览','资料库','设置']);
 const background=page.getByRole('region',{name:'项目背景',exact:true});
 await background.getByRole('button',{name:'编辑',exact:true}).click();
 await background.getByRole('textbox',{name:'项目背景',exact:true}).fill('项目的新背景：先确认目标。');
 await waitForAutosave(page);
 await background.getByRole('button',{name:'完成',exact:true}).click();
 await chooseOption(page,'切换项目','beta');
 await expect(page).toHaveURL(/\/projects\/beta\/overview/);
 await chooseOption(page,'切换项目','alpha');
 await page.reload();
 await expect(background).toContainText('项目的新背景：先确认目标。');
});

test('associations are editable in both directions and removing one preserves shared identity and chats',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'alpha',agentId:'writer',cli:'codex'}})).json();
 await page.goto('/projects/alpha/overview');
 await page.getByRole('button',{name:'添加关联',exact:true}).click();
 await page.getByRole('searchbox',{name:'搜索关联对象'}).fill('Reader');
 await page.getByRole('checkbox',{name:'Reader',exact:true}).check();await waitForAutosave(page);await page.keyboard.press('Escape');
 await page.getByRole('region',{name:'关联智能体'}).getByRole('link',{name:'Reader',exact:true}).click();
 await expect(page.getByRole('tablist',{name:'智能体 内容'}).getByRole('tab')).toHaveText(['概览','设置']);
 await expect(page.getByRole('region',{name:'关联项目'})).toContainText('Alpha');
 await page.getByRole('button',{name:'添加关联',exact:true}).click();await page.getByRole('checkbox',{name:'Beta',exact:true}).check();await waitForAutosave(page);await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'关联操作：Alpha',exact:true}).click();await page.getByRole('menuitem',{name:'解除关联'}).click();await waitForAutosave(page);
 await page.reload();await expect(page.getByRole('region',{name:'关联项目'})).not.toContainText('Alpha');await expect(page.getByRole('region',{name:'关联项目'})).toContainText('Beta');
 const {config}=await(await request.get('/api/config')).json();expect(config.agents.filter((agent:{systemRole?:string})=>!agent.systemRole)).toHaveLength(2);expect(config.projects[0].agentIds).toEqual(['writer']);expect(config.projects[1].agentIds).toEqual(['reader']);
 expect((await request.get('/api/conversations/'+chat.id)).ok()).toBe(true);
});

test('Agent roles edit inline and chat context is explicit and independent of the previous project',async({page})=>{
 await page.goto('/agents/writer?project=alpha');
 await expect(page.getByRole('combobox',{name:'对话所属项目'})).toHaveAttribute('data-value','alpha');
 const role=page.getByRole('region',{name:'职责与指令',exact:true});await role.getByRole('button',{name:'编辑',exact:true}).click();await role.getByRole('textbox').fill('用中文核对证据，避免猜测。');await waitForAutosave(page);await role.getByRole('button',{name:'完成',exact:true}).click();
 await chooseOption(page,'切换智能体','reader');await expect(page.getByRole('combobox',{name:'对话所属项目'})).toHaveAttribute('data-value','');
 await chooseOption(page,'切换智能体','writer');await expect(role).toContainText('用中文核对证据，避免猜测。');await expect(page.getByRole('combobox',{name:'对话所属项目'})).toHaveAttribute('data-value','alpha');
 await chooseOption(page,'对话所属项目','');
 await page.getByRole('button',{name:'开始对话',exact:true}).last().click();await expect(page).toHaveURL(url=>url.pathname==='/'&&url.searchParams.get('agent')==='writer'&&url.searchParams.get('project')==='');
});

test('failed saves retain text and prevent switching until retry succeeds',async({page})=>{
 await page.goto('/projects/alpha/overview');
 let fail=true;await page.route('**/api/config',route=>route.request().method()==='PUT'&&fail?route.fulfill({status:503,json:{error:'Synthetic save unavailable'}}):route.continue());
 const background=page.getByRole('region',{name:'项目背景',exact:true});await background.getByRole('button',{name:'编辑',exact:true}).click();await background.getByRole('textbox').fill('Keep this unsaved input');
 await expect(page.getByRole('alert')).toContainText('Synthetic save unavailable');await expect(page.getByRole('combobox',{name:'切换项目'})).toBeDisabled();await expect(background.getByRole('textbox')).toHaveValue('Keep this unsaved input');
 fail=false;await page.getByRole('button',{name:'重试自动保存'}).click();await waitForAutosave(page);await chooseOption(page,'切换项目','beta');await chooseOption(page,'切换项目','alpha');await expect(background).toContainText('Keep this unsaved input');
});

test('summary includes participating tasks and links to matching all-history lists',async({page,request})=>{
 for(const data of [{goal:'Owned by writer',assigneeAgentId:'writer',participantAgentIds:['writer']},{goal:'Reader task with writer participating',assigneeAgentId:'reader',participantAgentIds:['writer']},{goal:'Unrelated reader task',assigneeAgentId:'reader',participantAgentIds:[]}]) {
  const result=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{...data,projectId:'alpha'}});expect(result.ok()).toBe(true);
 }
 await page.goto('/agents/writer');const summary=page.getByRole('region',{name:'工作与记忆概况'});await expect(summary.getByRole('link',{name:/关联任务/}).locator('strong')).toHaveText('2');
 await summary.getByRole('link',{name:/关联任务/}).click();await expect(page).toHaveURL(url=>url.pathname==='/tasks'&&url.searchParams.get('agent')==='writer'&&url.searchParams.get('scope')==='all');
 await expect(page.getByRole('link',{name:'Owned by writer',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Reader task with writer participating',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Unrelated reader task',exact:true})).toHaveCount(0);
 await page.reload();await expect(page.getByRole('link',{name:'Reader task with writer participating',exact:true})).toBeVisible();
});

test('old work and memory links open scoped modules and memory scope survives reload and history',async({page})=>{
 await page.goto('/projects/alpha/tasks');await expect(page).toHaveURL(url=>url.pathname==='/tasks'&&url.searchParams.get('project')==='alpha');
 await page.goto('/agents/writer?tab=work');await expect(page).toHaveURL(url=>url.pathname==='/tasks'&&url.searchParams.get('agent')==='writer');
 await page.goto('/agents/writer/memory');await expect(page).toHaveURL(url=>url.pathname==='/mana'&&url.searchParams.get('agent')==='writer');
 await page.getByText('高级筛选',{exact:false}).first().click();await expect(page.getByRole('combobox',{name:'Agent',exact:true})).toHaveAttribute('data-value','writer');
 await page.getByRole('combobox',{name:'Agent',exact:true}).click();await page.getByRole('listbox').locator('[role="option"][data-value="reader"]').click();await expect(page).toHaveURL(url=>url.searchParams.get('agent')==='reader');
 await page.reload();await page.getByText('高级筛选',{exact:false}).first().click();await expect(page.getByRole('combobox',{name:'Agent',exact:true})).toHaveAttribute('data-value','reader');
 await page.goBack();if(!await page.getByRole('combobox',{name:'Agent',exact:true}).isVisible())await page.getByText('高级筛选',{exact:false}).first().click();await expect(page.getByRole('combobox',{name:'Agent',exact:true})).toHaveAttribute('data-value','writer');
});

for(const width of [1440,1024,768,390])for(const theme of ['light','dark'])test(`grouped layouts ${width} ${theme}`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:1000});await page.addInitScript(theme=>localStorage.setItem('mana-theme',theme),theme);
 for(const path of ['/projects/alpha/overview','/agents/writer','/projects/alpha/settings?tab=resources','/agents/writer?tab=execution']){
  await page.goto(path);await expect(page.locator('.object-header h1')).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  if(path.includes('overview')||path==='/agents/writer')await expect(page.locator('.object-summary-item').last().locator('strong')).toHaveText('0');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const header=await page.locator('.object-header').boundingBox(),group=await page.locator('.object-group').first().boundingBox();
  const workspaceTop=await page.locator('.object-header').evaluate(element=>{const main=element.closest('main')!;return main.getBoundingClientRect().top+parseFloat(getComputedStyle(main).borderTopWidth);});
  expect(header!.y-workspaceTop).toBe(44);expect(Math.abs(header!.x-group!.x)).toBeLessThan(2);expect(Math.abs(header!.width-group!.width)).toBeLessThan(2);expect(header!.width).toBeLessThanOrEqual(960);
  await page.screenshot({path:testInfo.outputPath(path.replace(/[^a-z0-9]+/gi,'-')+'.png'),fullPage:true});
 }
});

for(const route of ['/agents/writer','/settings/agents?agent=writer'])test('identity failure is recoverable without losing focus or leaving '+route,async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto(route);let fail=true;
 await page.route('**/api/config',route=>route.request().method()==='PUT'&&fail?route.fulfill({status:503,json:{error:'Synthetic identity failure'}}):route.continue());
 await page.getByRole('button',{name:'对象操作'}).click();await page.getByRole('menuitem',{name:'编辑名称与外观'}).click();
 const dialog=page.getByRole('dialog',{name:'名称与外观'}),name=dialog.getByRole('textbox',{name:'名称',exact:true});await name.fill('Writer renamed');await expect(name).toBeFocused();
 await expect(page.locator('.settings-save-error')).toContainText('Synthetic identity failure');await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).toHaveCount(0);
 await page.keyboard.press('Meta+n');await expect(page).toHaveURL(new RegExp(route.replace(/[?]/g,'\\?')+'$'));await expect(page.locator('.object-header h1')).toHaveText('Writer renamed');
 fail=false;await page.getByRole('button',{name:'重试自动保存'}).click();await waitForAutosave(page);await page.reload();await expect(page.locator('.object-header h1')).toHaveText('Writer renamed');
});

test('conflicting background edits remain visible until explicit reload',async({page,request})=>{
 await page.goto('/projects/alpha/overview');await expect(page.getByRole('heading',{name:'Alpha',exact:true})).toBeVisible();
 const current=await(await request.get('/api/config')).json();current.config.projects[0].background='External edit';expect((await request.put('/api/config',{data:current})).ok()).toBe(true);
 const group=page.getByRole('region',{name:'项目背景',exact:true});await group.getByRole('button',{name:'编辑',exact:true}).click();await group.getByRole('textbox').fill('Local conflict draft');
 await expect(page.getByRole('button',{name:'重新读取配置'})).toBeVisible();await expect(group.getByRole('textbox')).toHaveValue('Local conflict draft');await expect(page.getByRole('combobox',{name:'切换项目'})).toBeDisabled();
 await page.getByRole('button',{name:'重新读取配置'}).click();await expect(group.getByRole('textbox')).toHaveValue('External edit');
});

test('failed summaries stay unknown and attention stays scoped and bounded',async({page})=>{
 const tasks=Array.from({length:5},(_,i)=>({id:'attention-'+i,goal:'Review item '+i,state:i%2?'review':'waiting',assigneeAgentId:'writer',participantAgentIds:[],projectId:'alpha',createdAt:'2026-10-29T00:00:00Z'}));
 await page.route('**/api/v2/tasks',route=>route.fulfill({json:tasks}));
 await page.route('**/api/v2/memory/records?status=active',route=>route.fulfill({status:503,json:{error:'Unavailable'}}));
 await page.goto('/agents/writer');const summary=page.getByRole('region',{name:'工作与记忆概况'});await expect(summary.getByRole('link',{name:/有效记忆/}).locator('strong')).toHaveText('暂不可用');await expect(summary.locator('.object-summary-task')).toHaveCount(3);await expect(summary.getByRole('link',{name:/关联任务/}).locator('strong')).toHaveText('5');
 await chooseOption(page,'切换智能体','reader');await expect(summary.getByRole('link',{name:/关联任务/}).locator('strong')).toHaveText('0');await expect(summary.locator('.object-summary-task')).toHaveCount(0);
});

test('long content, keyboard switching and history retain the source position',async({page,request})=>{
 const snapshot=await(await request.get('/api/config')).json();
 snapshot.config.projects[0].background=Array.from({length:24},(_,i)=>`背景 Background ${i}：保持目标与证据。`).join('\n\n');
 await request.put('/api/config',{data:snapshot});
 await page.setViewportSize({width:390,height:650});await page.goto('/projects/alpha/overview');
 const group=page.getByRole('region',{name:'项目背景',exact:true});await group.getByRole('button',{name:'展开全文'}).click();await expect(group).toContainText('Background 23');await group.getByRole('button',{name:'收起',exact:true}).click();
 const association=page.getByRole('region',{name:'关联智能体'}).getByRole('link',{name:'Writer',exact:true});await association.scrollIntoViewIfNeeded();
 const scroller=page.locator('.project-workbench');const before=await scroller.evaluate(node=>node.scrollTop);expect(before).toBeGreaterThan(0);
 await association.click();await expect(page.getByRole('link',{name:'返回项目'})).toBeVisible();await page.goBack();await expect(page.locator('.object-header h1')).toHaveText('Alpha');await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).toBeCloseTo(before,0);
 await page.getByRole('combobox',{name:'切换项目'}).click();await page.getByRole('searchbox').fill('Beta');await page.keyboard.press('Escape');await expect(page.getByRole('combobox',{name:'切换项目'})).toBeFocused();
 await page.getByRole('combobox',{name:'切换项目'}).click();await page.getByRole('searchbox').fill('Beta');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await expect(page.locator('.object-header h1')).toHaveText('Beta');
});

test('late summary responses cannot overwrite the next Agent',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
 await page.route('**/api/v2/memory/records?status=active',async route=>{
  const first=++calls===1;if(first)await gate;
  await route.fulfill({json:{records:first?[{recordId:'stale',collectionId:'reader-memory',layer:'L1',contentType:'fact',status:'active',text:'Late old snapshot',evidence:[]}]:[],collections:[{id:'reader-memory',agentId:'reader',projectId:null}]}}).catch(()=>{});
 });
 await page.goto('/agents/writer');await expect.poll(()=>calls).toBe(1);await chooseOption(page,'切换智能体','reader');const count=page.getByRole('region',{name:'工作与记忆概况'}).getByRole('link',{name:/有效记忆/}).locator('strong');await expect(count).toHaveText('0');release();await expect(count).toHaveText('0');
});

test('Project Library cannot leave a failed identity draft through its asset links',async({page})=>{
 await page.goto('/projects/alpha/library');await page.route('**/api/config',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{error:'Library save failed'}}):route.continue());
 await page.getByRole('button',{name:'对象操作'}).click();await page.getByRole('menuitem',{name:'编辑名称与外观'}).click();await page.getByRole('textbox',{name:'名称',exact:true}).fill('Unsaved Alpha');await expect(page.locator('.settings-save-error')).toContainText('Library save failed');await page.keyboard.press('Escape');
 await page.getByRole('link',{name:'打开资料库',exact:true}).click({force:true});await expect(page).toHaveURL(/\/projects\/alpha\/library$/);await expect(page.locator('.object-header h1')).toHaveText('Unsaved Alpha');
});

 test('failed Project edits cannot leave through capability management',async({page})=>{
  await page.goto('/projects/alpha/settings?tab=capabilities');await page.route('**/api/config',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{error:'Settings save failed'}}):route.continue());
  await page.getByRole('button',{name:'对象操作'}).click();await page.getByRole('menuitem',{name:'编辑名称与外观'}).click();await page.getByRole('textbox',{name:'名称',exact:true}).fill('Unsaved Alpha');await expect(page.locator('.settings-save-error')).toContainText('Settings save failed');await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'管理目录',exact:true}).first().click();await expect(page).toHaveURL(/\/projects\/alpha\/settings\?tab=capabilities$/);
 });
