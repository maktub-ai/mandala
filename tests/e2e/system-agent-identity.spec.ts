import {expect,test} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {chooseOption} from './helpers/select';
import {waitForAutosave} from './helpers/settings';

let systemId:string,primaryId:string;
test.beforeEach(async({request})=>{
 const seeded=await(await request.get('/api/mandala')).json();systemId=seeded.config.mandala.agentId;primaryId=seeded.conversation.id;
 await request.put('/api/mandala',{data:{revision:seeded.revision,settings:{name:'Mandala',soul:'',cli:'codex',models:{codex:'model-fixture'},maxParallel:3}}});
 const {config,revision}=await(await request.get('/api/config')).json();
 config.agents=[config.agents.find((a:any)=>a.id===systemId),{id:'writer',name:'Writer',instructions:'Review evidence.',defaultCli:'codex',models:{},mcp:[],skills:[]}];
 config.projects=[{id:'alpha',name:'Alpha',cwd:'/tmp',resources:[],agentIds:['writer'],mcp:[],skills:[]},{id:'empty',name:'Empty',cwd:'/tmp',resources:[],agentIds:[],mcp:[],skills:[]}];
 expect((await request.put('/api/config',{data:{revision,config}})).ok()).toBe(true);
});

test('primary coordination stays out of task lists and boards while normal Mandala chats remain',async({page,request})=>{
 const response=await request.post('/api/conversations',{data:{agentId:systemId,projectId:'alpha',cli:'codex',model:'model-fixture'}});
 expect(response.ok()).toBe(true);const execution=await response.json();
 const rows=await(await request.get('/api/conversation-progress')).json();
 expect(rows.some((row:{id:string})=>row.id===primaryId)).toBe(false);
 expect(rows.some((row:{id:string})=>row.id===execution.id)).toBe(true);
 for(const type of ['all','conversations'])for(const view of ['list','board']){
  await page.goto(`/tasks?type=${type}&view=${view}&scope=all`);
  const progress=page.locator('.conversation-progress');
  await expect(progress.locator(`a[href="/?conversation=${execution.id}"]`).first()).toBeVisible();
  await expect(progress.locator(`a[href="/?conversation=${primaryId}"]`)).toHaveCount(0);
 }
 await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'Mandala',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('conversation='+primaryId));
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
});

test('opening system coordination and Market preserves remembered chat choices',async({page})=>{
 const remembered={projectId:'',agentId:systemId,cli:'codex',model:'model-second',effort:'high',onboardingCompleted:true};
 await page.addInitScript(value=>{localStorage.setItem('mana-chat-preferences',JSON.stringify(value));},remembered);
 await page.goto('/mandala?conversation='+primaryId);
 await expect(page.getByRole('button',{name:'Mandala 设置',exact:true})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('mana-chat-preferences')!))).toEqual(remembered);
 await page.getByRole('button',{name:'用户菜单',exact:true}).click();
 await page.getByRole('menuitem',{name:'市场',exact:true}).click();
 await expect(page.getByRole('heading',{name:'市场',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('mana-chat-preferences')!))).toEqual(remembered);
});

test('system and ordinary agent labels align in the chat picker',async({page})=>{
 await page.goto('/?project=alpha');await page.getByRole('combobox',{name:'当前 智能体',exact:true}).click();
 const list=page.getByRole('listbox');
 const system=await list.getByRole('option',{name:'Mandala',exact:true}).locator('strong').boundingBox();
 const ordinary=await list.getByRole('option',{name:'Writer',exact:true}).locator('strong').boundingBox();
 expect(system).not.toBeNull();expect(ordinary).not.toBeNull();expect(Math.abs(system!.x-ordinary!.x)).toBeLessThan(1);
});

test('pinned identity is searchable, separate from ordinary count and opens settings directly',async({page})=>{
 let primaryReads=0;page.on('request',request=>{if(request.url().endsWith('/api/mandala')&&request.method()==='GET')primaryReads++;});
 await page.goto('/agents');const system=page.getByRole('region',{name:'系统智能体',exact:true});
 await expect(system).toContainText('了解全局任务，协调项目与智能体，也可独立执行工作。');
 await expect(page.locator('.workspace-page-heading')).toContainText('1');await expect(page.locator('.workspace-directory-row')).toHaveCount(1);
 await page.getByRole('searchbox',{name:'智能体',exact:true}).fill('协调项目');await expect(system).toBeVisible();await expect(page.locator('.workspace-directory-row')).toHaveCount(0);
 await system.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'Mandala 设置'})).toBeVisible();await expect(page).toHaveURL(/\/agents$/);expect(primaryReads).toBe(0);
 await expect(page.getByRole('dialog')).toContainText('系统角色');await page.keyboard.press('Escape');await expect(system).toBeVisible();
 await page.goto('/agents?agent='+systemId);await expect(page.getByRole('dialog',{name:'Mandala 设置'})).toBeVisible();expect(primaryReads).toBe(0);
});

test('system group supports ordinary Project chats, keyboard selection and task assignment',async({page,request})=>{
 await page.goto('/?project=empty');const picker=page.getByRole('combobox',{name:'当前 智能体',exact:true});await picker.click();
 await expect(page.getByRole('listbox').getByText('系统智能体',{exact:true})).toBeVisible();await page.getByRole('searchbox').last().fill('Mandala');await page.keyboard.press('Enter');await expect(picker).toHaveAttribute('data-value',systemId);
 await chooseOption(page,'当前项目','alpha');await expect(picker).toHaveAttribute('data-value',systemId);await chooseOption(page,'审批模式','strict');
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Identity ordinary chat check');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page).toHaveURL(/conversation=/);const id=new URL(page.url()).searchParams.get('conversation')!;const chat=await(await request.get('/api/conversations/'+id)).json();expect(chat.conversation.purpose).not.toBe('mandala-main');expect(chat.conversation.projectId).toBe('alpha');expect(chat.conversation.agentId).toBe(systemId);expect(chat.conversation.approvalMode).toBe('strict');
 await expect(page.getByRole('combobox',{name:'审批模式',exact:true})).toHaveAttribute('data-value','strict');await chooseOption(page,'审批模式','auto');await expect(page.getByRole('combobox',{name:'审批模式',exact:true})).toHaveAttribute('data-value','auto');
 const preference=await(await request.get('/api/chat-preferences/approval?'+new URLSearchParams({agentId:systemId,cli:'codex'}))).json();expect(preference.approvalMode).toBeNull();
 await page.goto('/tasks?project=empty');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();await chooseOption(page,'执行智能体',systemId);await expect(page.getByRole('combobox',{name:'执行智能体',exact:true})).toHaveAttribute('data-value',systemId);
});

for(const theme of ['light','dark'])for(const width of [1440,1024,768,390])test(`system identity rendered ${theme} ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('mana-theme',theme),theme);await page.goto('/agents');
 await expect(page.getByRole('region',{name:'系统智能体',exact:true})).toBeVisible();const add=page.getByRole('button',{name:'添加智能体',exact:true});await expect(add).toBeEnabled();await expect.poll(()=>add.evaluate(node=>getComputedStyle(node).opacity)).toBe('1');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await mkdir('.impeccable/review',{recursive:true});await page.screenshot({path:`.impeccable/review/system-agent-${theme}-${width}.png`,fullPage:true});
});


test('saved system settings refresh directory and the next ordinary edit revision',async({page})=>{
 await page.goto('/agents?agent='+systemId);const dialog=page.getByRole('dialog',{name:'Mandala 设置'});await dialog.getByRole('textbox',{name:'名字',exact:true}).fill('Mandala renamed');await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await expect(dialog).toHaveCount(0);await expect(page.getByRole('region',{name:'系统智能体',exact:true})).toContainText('Mandala renamed');
 await page.locator('.workspace-directory-row').filter({hasText:'Writer'}).click();const role=page.getByRole('region',{name:'职责与指令',exact:true});await role.getByRole('button',{name:'编辑',exact:true}).click();await role.getByRole('textbox').fill('Updated after system save');await waitForAutosave(page);await expect(page.locator('.settings-save-error')).toHaveCount(0);
});


test('pinned New chat uses current system defaults after another runtime and preserves saved appearance',async({page,request})=>{
 const previous=await(await request.post('/api/conversations',{data:{projectId:'alpha',agentId:'writer',cli:'omp',model:'model-second'}})).json();
 await page.goto('/?project=alpha&conversation='+previous.id);await expect(page.getByRole('button',{name:'执行端状态'})).toContainText('OMP');
 await page.evaluate(()=>localStorage.setItem('identity-preference-marker','saved'));await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'智能体',exact:true}).click();
 await page.getByRole('region',{name:'系统智能体',exact:true}).getByRole('link',{name:'新建对话',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'当前 CLI',exact:true})).toHaveAttribute('data-value','codex');await expect(page.getByRole('combobox',{name:'当前 智能体',exact:true})).toHaveAttribute('data-value',systemId);
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('New system default check');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page).toHaveURL(/conversation=/);
 const next=await(await request.get('/api/conversations/'+new URL(page.url()).searchParams.get('conversation'))).json();expect(next.conversation).toMatchObject({cli:'codex',model:'model-fixture',agentId:systemId});expect(next.conversation.purpose).not.toBe('mandala-main');
 const original=await(await request.get('/api/conversations/'+previous.id)).json();expect(original.conversation).toMatchObject({cli:'omp',model:'model-second'});expect(await page.evaluate(()=>localStorage.getItem('identity-preference-marker'))).toBe('saved');
 await expect(page.locator('.topbar')).toContainText('Mandala');const composerSettings=page.getByRole('button',{name:'输入区设置'});if(await composerSettings.isVisible())await composerSettings.click();await expect(page.getByRole('combobox',{name:'模型',exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'审批模式',exact:true})).toBeVisible();
});

test('Project membership rows, counts and association editor omit a synthetic legacy system link',async({page,request})=>{
 const snapshot=await(await request.get('/api/config')).json();snapshot.config.projects[0].agentIds.push(systemId);
 await page.route('**/api/config',route=>route.request().method()==='GET'?route.fulfill({json:snapshot}):route.continue());await page.goto('/projects');
 await expect(page.locator('.workspace-directory-row').filter({hasText:'Alpha'})).toContainText('1 智能体');await page.locator('.workspace-directory-row').filter({hasText:'Alpha'}).click();
 const associations=page.getByRole('region',{name:'关联智能体',exact:true});await expect(associations).toContainText('Writer');await expect(associations).not.toContainText('Mandala');
 await associations.getByRole('button',{name:'添加关联',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Mandala',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
 await page.getByRole('combobox',{name:'选择对话智能体',exact:true}).click();await expect(page.getByRole('group',{name:'系统智能体',exact:true})).toContainText('Mandala');
});

test('long system name wraps at narrow width and empty/search/error states remain useful',async({page,request})=>{
 const snapshot=await(await request.get('/api/config')).json();const name='长期协调智能体 Long-lived workspace coordinator '.repeat(2);
 expect((await request.put('/api/mandala',{data:{revision:snapshot.revision,settings:{name,soul:'',cli:'codex',maxParallel:3}}})).ok()).toBe(true);
 const current=await(await request.get('/api/config')).json();current.config.agents=current.config.agents.filter((a:any)=>a.id===systemId);current.config.projects.forEach((p:any)=>p.agentIds=[]);expect((await request.put('/api/config',{data:current})).ok()).toBe(true);await page.setViewportSize({width:390,height:844});await page.goto('/agents');
 await expect(page.getByRole('region',{name:'系统智能体',exact:true})).toContainText(name.trim());await expect(page.getByText('添加智能体以开始配置。',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('searchbox',{name:'智能体',exact:true}).fill('unmatched identity');await expect(page.getByText('没有匹配选项',{exact:true})).toBeVisible();await page.getByRole('searchbox',{name:'智能体',exact:true}).fill('');
 let requests=0;await page.route('**/api/config',route=>++requests===2?route.fulfill({status:503,json:{error:'Synthetic settings unavailable'}}):route.continue());await page.getByRole('region',{name:'系统智能体',exact:true}).getByRole('link',{name:'设置',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Mandala 设置'});await expect(dialog.getByRole('alert')).toContainText('Synthetic settings unavailable');await dialog.getByRole('button',{name:'重新读取',exact:true}).click();await expect(dialog.getByRole('textbox',{name:'名字',exact:true})).toHaveValue(name.trim());
});


test('provisioned system identity preserves first-use CLI guidance and explicit system New chat',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();current.config.agents=current.config.agents.filter((a:any)=>a.id===systemId);current.config.projects=[];expect((await request.put('/api/config',{data:current})).ok()).toBe(true);
 await page.route(url=>url.pathname==='/api/conversations',route=>route.request().method()==='GET'?route.fulfill({json:[]}):route.continue());
 await page.route('**/api/drafts/entry?*',async route=>{const response=await route.fetch();await route.fulfill({json:{...await response.json(),draft:null}});});await page.goto('/');await expect(page.getByRole('region',{name:'开始使用 Mandala',exact:true})).toBeVisible();
 await page.goto('/agents');await page.getByRole('region',{name:'系统智能体',exact:true}).getByRole('link',{name:'新建对话',exact:true}).click();await expect(page.getByRole('region',{name:'开始使用 Mandala',exact:true})).toHaveCount(0);await expect(page.getByRole('combobox',{name:'当前 智能体',exact:true})).toHaveAttribute('data-value',systemId);
});


test('task reply prepares a normal system Project chat and excludes primary linking',async({page,request})=>{
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Prepare a normal system execution chat',projectId:'empty',assigneeAgentId:systemId}});expect(response.ok()).toBe(true);const task=await response.json();
 await page.goto('/tasks/'+task.id);const reply=page.getByRole('region',{name:'回复任务',exact:true});await reply.getByRole('button',{name:'关联或准备对话',exact:true}).click();
 await reply.getByRole('combobox',{name:'关联已有对话',exact:true}).click();await expect(page.getByRole('listbox').locator('[role="option"][data-value='+JSON.stringify(primaryId)+']')).toHaveCount(0);await page.keyboard.press('Escape');
 await chooseOption(page,'新对话智能体',systemId);await expect(reply.getByRole('combobox',{name:'新对话执行端',exact:true})).toHaveAttribute('data-value','codex');await reply.getByRole('button',{name:'准备新对话',exact:true}).click();
 await expect(reply.getByRole('combobox',{name:'目标对话',exact:true})).not.toHaveAttribute('data-value','');const id=await reply.getByRole('combobox',{name:'目标对话',exact:true}).getAttribute('data-value');const prepared=await(await request.get('/api/conversations/'+id)).json();expect(prepared.conversation).toMatchObject({agentId:systemId,projectId:'empty',cli:'codex',model:'model-fixture'});expect(prepared.conversation.purpose).not.toBe('mandala-main');
});
