import { expect, test } from '@playwright/test';
import { chooseOption } from './helpers/select';

test('root opens chat while usage and history preserve the draft', async ({page}) => {
 await page.goto('/');
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
 await page.locator('aside.sidebar').getByRole('button',{name:'开始对话',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Preserve workbench draft');
 await page.getByRole('button',{name:'用户菜单',exact:true}).click();await page.getByRole('menu',{name:'用户菜单',exact:true}).locator('[data-area=usage]').click();
 await expect(page.getByRole('heading',{name:'用量',exact:true})).toBeVisible();
 await page.goBack();
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Preserve workbench draft');
 await page.reload();
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
});

test('new chat selects a different Agent runtime without carrying chat draft, model or attachments',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[{id:'start-codex',name:'Previous Codex',defaultCli:'codex',instructions:'',models:{codex:'old-model'},mcp:[],skills:[]},{id:'start-omp',name:'Next OMP',defaultCli:'omp',instructions:'',models:{omp:'model-fixture'},mcp:[],skills:[]}]}}})).ok()).toBe(true);
 const previous=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'start-codex',cli:'codex',model:'old-model'}})).json();
 await page.goto('/?conversation='+previous.id+'&project=');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Previous unsent draft');
 await page.locator('input[type=file]').setInputFiles({name:'old.txt',mimeType:'text/plain',buffer:Buffer.from('previous attachment')});
 await page.locator('aside.sidebar .sidebar-start .new-chat').click();
 await chooseOption(page,'当前 智能体','start-omp');await page.getByRole('textbox',{name:'消息',exact:true}).fill('New OMP work');
 // The fixture only supplies a synthetic Codex runtime. Assert OMP dispatch at
 // the shared queue boundary instead of invoking the user's installed OMP.
 await page.route('**/api/conversations/*/queue',route=>route.fulfill({status:route.request().method()==='POST'?202:200,json:route.request().method()==='POST'?{id:'synthetic-input',state:'queued'}:[]}));
 const queuedPromise=page.waitForRequest(request=>request.url().endsWith('/queue')&&request.method()==='POST');
 const createdPromise=page.waitForResponse(response=>response.url().endsWith('/api/conversations')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const response=await createdPromise;expect(response.ok(),await response.text()).toBe(true);const current=await response.json();
 expect(current).toMatchObject({agentId:'start-omp',cli:'omp',model:'model-fixture'});expect(current.id).not.toBe(previous.id);
 await expect(page).toHaveURL(new RegExp('conversation='+current.id));
 expect((await queuedPromise).postDataJSON()).toMatchObject({text:'New OMP work',attachments:[]});
 await page.unroute('**/api/conversations/*/queue');
 await page.locator('aside.sidebar .sidebar-start .new-chat').click();
 await chooseOption(page,'当前 智能体','start-codex');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Synthetic Codex quick work');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('Fixture reply: Synthetic Codex quick work',{exact:true})).toBeVisible();
});

test('review deep link leaves user focus alone during task polling',async({page,request})=>{
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'review-focus'},data:{goal:'Review focus objective',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}});const task=await response.json();
 await request.post('/api/v2/tasks/'+task.id+'/complete',{data:{expectedRevision:task.revision}});
 await page.goto('/tasks/'+task.id+'?action=review');await page.getByRole('button',{name:'要求修改',exact:true}).click();const reason=page.getByRole('textbox',{name:'原因',exact:true});await reason.fill('Keep reading and typing');
 let reads=0;page.on('response',response=>{if(new URL(response.url()).pathname==='/api/v2/tasks/'+task.id)reads++;});
 await expect.poll(()=>reads,{timeout:6000}).toBeGreaterThan(0);await expect(reason).toBeFocused();await expect(reason).toHaveValue('Keep reading and typing');
});

for(const theme of ['dark','light'])test('usage preserves partial and unknown records on narrow '+theme+' layout',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.addInitScript(value=>localStorage.setItem('mana-theme',value),theme);

 await page.route('**/api/usage?*',route=>route.fulfill({json:{window:{start:'2026-10-09T00:00:00Z',end:'2026-10-10T00:00:00Z',timeZone:'Asia/Singapore',period:'today'},generatedAt:'2026-10-09T05:00:00Z',coverage:{observed:0,partial:1,unknown:1,total:2},totals:{inputTokens:100,outputTokens:30,totalTokens:130,cachedInputTokens:40,cacheWriteInputTokens:null,reasoningOutputTokens:10},daily:[],groups:{category:[],agent:[],project:[],cli:[],model:[]},recent:[]}}));
 await page.goto('/usage');const usage=page.getByRole('region',{name:'已记录用量',exact:true});await expect(usage).toContainText('130');await usage.getByText('统计口径',{exact:true}).click();await expect(usage.locator('.usage-coverage > div').filter({hasText:'部分记录'}).locator('dd')).toHaveText('1');await expect(usage.locator('.usage-coverage > div').filter({hasText:'未上报'}).locator('dd')).toHaveText('1');
 await expect(usage).toContainText('缓存包含在输入内');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const directory='/tmp';await page.screenshot({path:directory+'/workbench-narrow-'+theme+'.png',fullPage:true});
});

test('task action links open forms without changing task acceptance',async({page,request})=>{
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'palette-route-task'},data:{goal:'Palette route task',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}});
 const task=await response.json();expect(response.ok()).toBe(true);
 await page.goto('/tasks?action=create');await page.getByRole('button',{name:'手动填写',exact:true}).click();await expect(page.getByRole('form',{name:'新建任务',exact:true})).toBeVisible();
 await page.goto('/tasks/'+task.id+'?action=edit');await expect(page.getByRole('form',{name:'编辑任务',exact:true})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'父任务',exact:true})).toHaveCount(0);
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');
 const palette=page.getByRole('dialog',{name:'命令面板',exact:true});await palette.getByRole('combobox').fill('> 添加子任务');await expect(palette.getByRole('option',{name:'添加子任务',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
 await page.goto('/tasks/'+task.id+'?action=review');await expect(page.getByRole('form',{name:'编辑任务',exact:true})).toHaveCount(0);
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).task.state).toBe('todo');
});

test('fixround1 cancelled create and edit commands can open the same forms again',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'repeat-task'},data:{goal:'Repeat task',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}})).json();
 for(const action of ['create','edit'] as const) {
  const href=action==='create'?'/tasks?action=create':'/tasks/'+task.id+'?action='+action,formName=action==='edit'?'编辑任务':'新建任务';
  await page.goto(href);if(action==='create')await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByRole('form',{name:formName,exact:true}).getByRole('button',{name:'取消编辑',exact:true}).click();expect(new URL(page.url()).searchParams.has('action')).toBe(false);
  await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');const palette=page.getByRole('dialog',{name:'命令面板',exact:true}),input=palette.getByRole('combobox',{name:'搜索命令或对象',exact:true});await input.fill('> '+({create:'创建任务',edit:'编辑任务'}[action]));await input.press('Enter');if(action!=='create')await palette.getByRole('option').filter({hasText:'Repeat task'}).click();
  if(action==='create')await page.getByRole('button',{name:'手动填写',exact:true}).click();
  await expect(page.getByRole('form',{name:formName,exact:true})).toBeVisible();await page.getByRole('form',{name:formName,exact:true}).getByRole('button',{name:'取消编辑',exact:true}).click();
 }
});

for(const exit of ['breadcrumb','back'])test('fixround1 task draft survives '+exit+' navigation',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'task-navigation-'+exit},data:{goal:'Protected task '+exit,criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}})).json();
 await page.goto('/');await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();await page.locator('.progress-item-title[href="/tasks/'+task.id+'"]').click();
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');const palette=page.getByRole('dialog',{name:'命令面板',exact:true});await palette.getByRole('combobox',{name:'搜索命令或对象',exact:true}).fill('> 编辑任务');await palette.getByRole('combobox').press('Enter');await palette.getByRole('option').filter({hasText:'Protected task '+exit}).click();
 const editor=page.getByRole('form',{name:'编辑任务',exact:true});await editor.getByRole('textbox',{name:'任务标题',exact:true}).fill('Retain task draft');await expect(page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'智能体',exact:true})).toHaveAttribute('aria-disabled','true');
 if(exit==='back')await page.goBack();else await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await expect(editor.getByRole('textbox',{name:'任务标题',exact:true})).toHaveValue('Retain task draft');await expect(page).toHaveURL(new RegExp('/tasks/'+task.id+'\\?action=edit$'));
});

test('new chat uses target runtime default when Agent has no model override',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[{id:'catalog-old',name:'Old catalog Agent',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[]},{id:'catalog-new',name:'New catalog Agent',defaultCli:'omp',instructions:'',models:{},mcp:[],skills:[]}]}}});
 await page.route('**/api/models?*',async route=>{const target=new URL(route.request().url()).searchParams.get('cli')==='omp';if(target)await new Promise(resolve=>setTimeout(resolve,150));await route.fulfill({json:[{id:target?'new-omp-default':'old-default',label:'Runtime default',isDefault:true}]});});
 await page.route('**/api/conversations/*/queue',route=>route.fulfill({status:route.request().method()==='POST'?202:200,json:route.request().method()==='POST'?{id:'synthetic-input',state:'queued'}:[]}));
 await page.goto('/?project=&agent=catalog-old');await page.getByRole('combobox',{name:'模型',exact:true}).click();await expect(page.locator('[role=option][data-value=old-default]')).toBeVisible();await page.keyboard.press('Escape');
 await page.locator('aside.sidebar .sidebar-start .new-chat').click();await chooseOption(page,'当前 智能体','catalog-new');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Target runtime default work');const creation=page.waitForRequest(request=>request.url().endsWith('/api/conversations')&&request.method()==='POST');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 expect((await creation).postDataJSON()).toMatchObject({cli:'omp',agentId:'catalog-new',model:'new-omp-default'});
});

for(const mode of ['manual','agent'])test('fixround1 palette-created '+mode+' task drafts survive mode changes and browser Back leaves creation',async({page})=>{
 let createdTasks=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v2/tasks')createdTasks++;});
 await page.goto('/');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');const palette=page.getByRole('dialog',{name:'命令面板',exact:true});await palette.getByRole('combobox',{name:'搜索命令或对象',exact:true}).fill('> 创建任务');await palette.getByRole('combobox').press('Enter');
 await page.getByRole('button',{name:mode==='manual'?'手动填写':'智能体创建',exact:true}).click();
 const input=mode==='manual'?page.getByRole('form',{name:'新建任务',exact:true}).getByRole('textbox',{name:'任务标题',exact:true}):page.getByRole('textbox',{name:'描述任务需求',exact:true});
 await input.fill('Keep palette task draft');
 await page.getByRole('button',{name:mode==='manual'?'智能体创建':'手动填写',exact:true}).click();
 const other=mode==='manual'?page.getByRole('textbox',{name:'描述任务需求',exact:true}):page.getByRole('form',{name:'新建任务',exact:true}).getByRole('textbox',{name:'任务标题',exact:true});await other.fill('Keep alternate mode draft');
 await page.getByRole('button',{name:mode==='manual'?'手动填写':'智能体创建',exact:true}).click();await expect(input).toHaveValue('Keep palette task draft');
 await page.getByRole('button',{name:mode==='manual'?'智能体创建':'手动填写',exact:true}).click();await expect(other).toHaveValue('Keep alternate mode draft');await page.getByRole('button',{name:mode==='manual'?'手动填写':'智能体创建',exact:true}).click();
 await page.goBack();await expect(page).toHaveURL(url=>url.pathname==='/');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();await expect(input).toHaveCount(0);
 await expect(page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'智能体',exact:true})).not.toHaveAttribute('aria-disabled','true');
 await page.goForward();await expect(page).toHaveURL(/\/tasks\?action=create$/);await page.getByRole('button',{name:'智能体创建',exact:true}).click();await expect(page.getByRole('textbox',{name:'描述任务需求',exact:true})).toHaveValue('');await page.getByRole('button',{name:'手动填写',exact:true}).click();await expect(page.getByRole('form',{name:'新建任务',exact:true}).getByRole('textbox',{name:'任务标题',exact:true})).toHaveValue('');expect(createdTasks).toBe(0);
 await page.getByRole('button',{name:'取消编辑',exact:true}).click();
});

test('fixround2 protected Forward preserves history length, forward destination and Back index',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'history-index-regression'},data:{goal:'History index objective',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}})).json();
 await page.goto('/');await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();await page.locator('.progress-item-title[href="/tasks/'+task.id+'"]').click();await page.locator('aside.sidebar .sidebar-start .new-chat').click();
 await page.goBack();await page.getByRole('button',{name:'编辑任务',exact:true}).click();const editor=page.getByRole('form',{name:'编辑任务',exact:true}),input=editor.getByRole('textbox',{name:'任务标题',exact:true});await input.fill('Keep historical editor draft');const length=await page.evaluate(()=>history.length);
 // A visible, filled editor must already be protected; do not wait for the navigation lock here.
 await page.goForward();await expect(page).toHaveURL(new RegExp('/tasks/'+task.id+'$'));await expect(input).toHaveValue('Keep historical editor draft');expect(await page.evaluate(()=>history.length)).toBe(length);
 await editor.getByRole('button',{name:'取消编辑',exact:true}).click();await expect(page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'智能体',exact:true})).not.toHaveAttribute('aria-disabled','true');await page.goForward();await expect(page).toHaveURL(/\/\?project=/);await page.goBack();await expect(page).toHaveURL(new RegExp('/tasks/'+task.id+'$'));await page.goBack();await expect(page).toHaveURL(/\/tasks$/);
});

for(const destination of ['project','tasks'])for(const action of ['create','new-chat'])test('fixround2 palette '+action+' uses '+destination+' route scope instead of retained chat',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision,config:{version:2,projects:['scope-p','scope-q'].map(id=>({id,name:id==='scope-p'?'Retained chat project P':'Visible project Q',cwd:'',agentIds:['scope-agent'],resources:[],mcp:[],skills:[]})),agents:[{id:'scope-agent',name:'Retained chat Agent',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[]}]}}});
 const chat=await(await request.post('/api/conversations',{data:{projectId:'scope-p',agentId:'scope-agent',cli:'codex'}})).json();await page.goto('/?project=scope-p&conversation='+chat.id);
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();const shortcut=await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P';await page.keyboard.press(shortcut);const palette=page.getByRole('dialog',{name:'命令面板',exact:true}),input=palette.getByRole('combobox',{name:'搜索命令或对象',exact:true});await input.fill('Visible project Q');await palette.getByRole('option').filter({hasText:'Visible project Q'}).click();await expect(page).toHaveURL(/\/projects\/scope-q\/(?:overview|workbench)$/);
 if(destination==='tasks')await page.locator('main').getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();
 await page.keyboard.press(shortcut);await input.fill(action==='create'?'> 创建任务':'> 开始新对话');await input.press('Enter');
 expect(new URL(page.url()).searchParams.get('project')).toBe('scope-q');
 if(action==='create'){await page.getByRole('button',{name:'手动填写',exact:true}).click();await expect(page.getByRole('form',{name:'新建任务',exact:true}).getByRole('combobox',{name:'任务项目',exact:true})).toHaveAttribute('data-value','scope-q');}else expect(new URL(page.url()).searchParams.get('agent')).toBe('');
});

test('prepared draft autosave cannot race the atomic new Chat handoff',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[{id:'handoff-order',name:'Handoff ordering',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[]}]}}})).ok()).toBe(true);
 let sourceWrites=0;
 await page.route('**/api/drafts/entry*',async route=>{const req=route.request();if(req.method()==='PUT'&&!req.postDataJSON().scope.conversationId){sourceWrites++;const response=await route.fetch();if(sourceWrites===2)await new Promise(resolve=>setTimeout(resolve,600));return route.fulfill({response});}if(req.method()==='GET'&&JSON.parse(new URL(req.url()).searchParams.get('scope')!).conversationId)await new Promise(resolve=>setTimeout(resolve,300));return route.continue();});
 await page.goto('/?project=&agent=handoff-order');const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('Serialize this handoff');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page).toHaveURL(/conversation=/);await expect(page.getByText('Fixture reply: Serialize this handoff',{exact:true})).toBeVisible();expect(sourceWrites).toBeGreaterThanOrEqual(1);const id=new URL(page.url()).searchParams.get('conversation')!;expect(await(await request.get('/api/conversations/'+id+'/queue')).json()).toHaveLength(1);
});
