import {createTaskWithExecutionChats} from './helpers/task-executions';
import { expect,test } from '@playwright/test';
import { storedUiState } from './helpers/preferences';
let first:string,second:string,task:string;
test.use({storageState:storedUiState('en')});
test.beforeEach(async({request})=>{
 const snapshot=await(await request.get('/api/config')).json();
 const agents=['reply-first','reply-second'].map(id=>({id,name:id,instructions:'Inspect synthetic evidence',defaultCli:'codex',models:{},mcp:[],skills:[]}));
 expect((await request.put('/api/config',{data:{revision:snapshot.revision,config:{...snapshot.config,agents:[...snapshot.config.agents.filter((existing:any)=>!agents.some(agent=>agent.id===existing.id)),...agents]}}})).ok()).toBe(true);
 first=(await(await request.post('/api/conversations',{data:{projectId:'',agentId:agents[0].id,cli:'codex',model:'model-fixture'}})).json()).id;
 second=(await(await request.post('/api/conversations',{data:{projectId:'',agentId:agents[1].id,cli:'codex',model:'model-fixture'}})).json()).id;
 const created=await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Targeted task reply',criteria:[],acceptance:'delivery',assigneeAgentId:agents[1].id}},[first]);task=(await created.json()).id;
});
const reply=(page:any)=>page.locator('.task-reply');
async function openReply(page:any){await expect(page.locator('.task-reply-section')).toBeVisible({timeout:15000});await expect(reply(page)).toBeVisible();}
test('one Chat preselects its actual Agent, durable HOME restores without origin storage, reply does not start Task',async({page,request,browser})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page)).toContainText('reply-first');await expect(reply(page)).toContainText('Codex');
 await reply(page).getByRole('textbox',{name:'Task reply',exact:true}).fill('Durable bilingual draft · 草稿');
 await expect(reply(page).locator('.composer-draft-feedback')).toHaveCount(0);
 await expect.poll(async()=>{const data=await(await request.get('/api/drafts')).json();return data.entries.some((entry:any)=>entry.scope.taskId===task&&entry.draft.text==='Durable bilingual draft · 草稿');}).toBe(true);
 const context=await browser.newContext({baseURL:new URL(page.url()).origin,locale:'en-US'}),fresh=await context.newPage();await fresh.goto('/tasks/'+task);await openReply(fresh);
 await expect(reply(fresh).getByRole('textbox')).toHaveValue('Durable bilingual draft · 草稿');
 await reply(fresh).getByRole('button',{name:'Send reply',exact:true}).click();
 await expect(reply(fresh).getByRole('textbox')).toHaveValue('');
 const detail=await(await request.get('/api/v2/tasks/'+task)).json();expect(detail.task.state).toBe('todo');expect(detail.runs).toHaveLength(0);
 expect((await(await request.get('/api/conversations/'+first+'/queue')).json()).some((input:any)=>input.text==='Durable bilingual draft · 草稿')).toBe(true);
 await context.close();
});
test('multiple Chats require explicit choice and preserve independent target drafts',async({page,request})=>{
 const detail=await(await request.get('/api/v2/tasks/'+task)).json();expect((await request.post('/api/v2/tasks/'+task+'/executions',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{conversationId:second,expectedRevision:detail.task.revision}})).ok()).toBe(true);
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeDisabled();
 const target=reply(page).getByRole('combobox',{name:'Target Chat',exact:true});await target.click();await page.getByRole('option').filter({hasText:'reply-first'}).click();
 await reply(page).getByRole('textbox').fill('First target draft');await target.click();await page.getByRole('option').filter({hasText:'reply-second'}).click();
 await expect(reply(page).getByRole('textbox')).toHaveValue('');await reply(page).getByRole('textbox').fill('Second target draft');await target.click();await page.getByRole('option').filter({hasText:'reply-first'}).click();
 await expect(reply(page).getByRole('textbox')).toHaveValue('First target draft');
});
test('offline browser buffer survives refresh and reconnect never sends',async({page})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeEnabled();let posts=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/queue'))posts++;});
 await page.route('**/api/drafts/**',route=>route.abort());await reply(page).getByRole('textbox').fill('Offline local draft');await expect(reply(page)).toContainText('Draft buffered');
 await page.reload();await expect(reply(page).getByRole('textbox')).toHaveValue('Offline local draft');await page.unroute('**/api/drafts/**');await reply(page).getByRole('button',{name:'Retry save',exact:true}).click();await expect(reply(page).locator('.composer-draft-feedback')).toHaveCount(0);expect(posts).toBe(0);
});
test('unknown attachment send restores and only checks original key; lost DELETE ack leaves no resendable old draft',async({page,request})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeEnabled();await reply(page).getByRole('textbox').fill('Synthetic attachment reply');
 await reply(page).locator('input[type=file]').setInputFiles({name:'evidence.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic evidence')});
 let offline=true,posts=0;await page.route('**/api/conversations/*/queue',async route=>{if(route.request().method()==='POST'){posts++;await route.fetch();await route.abort();}else if(offline)await route.abort();else await route.continue();});
 await reply(page).getByRole('button',{name:'Send reply',exact:true}).click();await expect(reply(page).getByRole('button',{name:'Check previous send',exact:true})).toBeVisible();
 await page.reload();await expect(reply(page).getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();offline=false;
 await page.route('**/api/drafts/pending',async route=>{if(route.request().method()==='DELETE'){await route.fetch();await route.abort();}else await route.continue();});
 await reply(page).getByRole('button',{name:'Check previous send',exact:true}).click();await expect.poll(async()=>{const data=await(await request.get('/api/drafts')).json();return data.pending.some((entry:any)=>entry.scope.taskId===task);}).toBe(false);
 await page.reload();await openReply(page);await expect(reply(page).getByRole('textbox')).toHaveValue('');await expect(reply(page).getByText('Reselect attachments:',{exact:false})).toHaveCount(0);await expect(reply(page).getByRole('button',{name:'Send reply',exact:true})).toBeDisabled();expect(posts).toBe(1);
});

test('a failed accepted-draft write keeps recovery through reload instead of enabling a second POST',async({page})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeEnabled();await reply(page).getByRole('textbox').fill('Only once despite cleanup failure');
 let posts=0,failClear=true;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/queue'))posts++;});
 await page.route('**/api/drafts/entry',async route=>{if(route.request().method()==='PUT'&&route.request().postDataJSON().draft.text===''&&failClear)await route.abort();else await route.continue();});
 await reply(page).getByRole('button',{name:'Send reply',exact:true}).click();await expect(reply(page).getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();await page.reload();
 await expect(reply(page).getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();failClear=false;await reply(page).getByRole('button',{name:'Check previous send',exact:true}).click();await expect(reply(page).getByRole('button',{name:'Send reply',exact:true})).toBeDisabled();expect(posts).toBe(1);
});
test('new text typed while an accepted request waits for its acknowledgment remains a distinct draft',async({page})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeEnabled();await reply(page).getByRole('textbox').fill('Original accepted text');
 let release:()=>void=()=>{};const acknowledgment=new Promise<void>(resolve=>{release=resolve;});let posted=false;
 await page.route('**/api/conversations/*/queue',async route=>{if(route.request().method()==='POST'){posted=true;const response=await route.fetch();await acknowledgment;await route.fulfill({response});}else await route.continue();});
 await reply(page).getByRole('button',{name:'Send reply',exact:true}).click();await expect.poll(()=>posted).toBe(true);await reply(page).getByRole('textbox').fill('New unsent text while waiting');release();
 await expect(reply(page).getByRole('button',{name:'Send reply',exact:true})).toBeEnabled();await expect(reply(page).getByRole('textbox')).toHaveValue('New unsent text while waiting');await page.reload();await openReply(page);await expect(reply(page).getByRole('textbox')).toHaveValue('New unsent text while waiting');
});
test('unknown queue absence can be explicitly resolved after history confirmation without replay',async({page})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeEnabled();await reply(page).getByRole('textbox').fill('Request never reached the host');let posts=0;
 await page.route('**/api/conversations/*/queue',route=>{if(route.request().method()==='POST'){posts++;return route.abort();}return route.fulfill({json:[]});});
 await reply(page).getByRole('button',{name:'Send reply',exact:true}).click();await expect(reply(page).getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();
 await reply(page).getByRole('button',{name:'Resolve this recovery',exact:true}).click();await page.getByRole('checkbox',{name:'I have checked Chat history',exact:true}).check();await page.getByRole('button',{name:'Keep draft and resolve',exact:true}).click();
 await expect(reply(page).getByRole('button',{name:'Send reply',exact:true})).toBeEnabled();await expect(reply(page).getByRole('textbox')).toHaveValue('Request never reached the host');expect(posts).toBe(1);
});
test('pending input prevents removing an execution and preserves unknown-send recovery',async({page,request})=>{
 await page.goto('/tasks/'+task);await openReply(page);await expect(reply(page).getByRole('textbox')).toBeEnabled();await reply(page).getByRole('textbox').fill('Pending execution input');let posts=0;
 await page.route('**/api/conversations/*/queue',async route=>{if(route.request().method()==='POST'){posts++;await route.fetch();await route.abort();}else await route.abort();});
 await reply(page).getByRole('button',{name:'Send reply',exact:true}).click();await expect(reply(page).getByRole('button',{name:'Check previous send',exact:true})).toBeVisible();
 await reply(page).getByRole('button',{name:'Remove execution Chat',exact:true}).click();await expect(reply(page)).toContainText('has history or pending input/reports');
 const detail=await(await request.get('/api/v2/tasks/'+task)).json();expect(detail.task.conversationIds).toEqual([first]);
 await page.unroute('**/api/conversations/*/queue');await reply(page).getByRole('button',{name:'Check previous send',exact:true}).click();await expect(reply(page).getByRole('button',{name:'Send reply',exact:true})).toBeDisabled();expect(posts).toBe(1);
});
test('preparing an unassigned Task Chat requires an explicit Agent and never executes',async({page,request},testInfo)=>{
 const created=await(await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Explicit runtime preparation',criteria:[]}},[])).json();
 await page.goto('/tasks/'+created.id);await openReply(page);await reply(page).getByRole('button',{name:'Set / open execution Chat',exact:true}).click();const prepare=reply(page).getByRole('button',{name:'New execution Chat',exact:true});await expect(prepare).toBeDisabled();
 await reply(page).getByRole('combobox',{name:'New Chat Agent',exact:true}).click();await page.getByRole('option',{name:'reply-first',exact:true}).click();await prepare.click();await expect(reply(page).locator('.task-reply-link')).toHaveCount(0);
 await expect(reply(page).locator('.workspace-metadata')).toContainText('reply-first');await expect(reply(page)).toContainText('Codex');const detail=await(await request.get('/api/v2/tasks/'+created.id)).json();expect(detail.task.state).toBe('todo');expect(detail.runs).toHaveLength(0);expect(detail.readableAssociatedChats).toHaveLength(1);expect(detail.readableAssociatedChats[0]).toMatchObject({agentId:'reply-first',cli:'codex',status:'idle'});await page.screenshot({path:testInfo.outputPath('new-execution-chat.png'),fullPage:true});
});

test('existing Agent Chat attaches once and pristine execution can be removed',async({page,request},testInfo)=>{
 await page.goto('/tasks/'+task);await openReply(page);await reply(page).getByRole('button',{name:'Set execution Chat',exact:true}).click();await reply(page).getByRole('combobox',{name:'Existing Chat',exact:true}).click();await page.locator('[role=option][data-value="'+second+'"]').click();await reply(page).getByRole('button',{name:'Set execution Chat',exact:true}).last().click();
 await expect(reply(page).getByRole('combobox',{name:'Target Chat',exact:true})).toHaveAttribute('data-value',second);
 for(const theme of ['light','dark']){await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await page.setViewportSize({width:theme==='light'?1280:390,height:900});await expect(reply(page)).toBeVisible();await page.screenshot({path:testInfo.outputPath('execution-chats-'+theme+'.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await reply(page).getByRole('combobox',{name:'Target Chat',exact:true}).click();await page.locator('[role=option][data-value="'+second+'"]').click();await reply(page).getByRole('button',{name:'Remove execution Chat',exact:true}).click();await expect.poll(async()=>((await(await request.get('/api/v2/tasks/'+task)).json()).task.conversationIds)).toEqual([first]);
});

test('Agentless and already-owned Chats show actionable execution errors',async({page,request})=>{
 const plain=await(await request.post('/api/conversations',{data:{agentId:'',projectId:'',cli:'codex'}})).json();await page.goto('/tasks/'+task);await openReply(page);await reply(page).getByRole('button',{name:'Set execution Chat',exact:true}).click();await reply(page).getByRole('combobox',{name:'Existing Chat',exact:true}).click();await page.locator('[role=option][data-value="'+plain.id+'"]').click();await reply(page).getByRole('button',{name:'Set execution Chat',exact:true}).last().click();await expect(reply(page)).toContainText('Choose a Chat with an Agent.');
 const other=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Other execution owner'}})).json();await page.goto('/tasks/'+other.id);await openReply(page);await reply(page).getByRole('button',{name:'Set / open execution Chat',exact:true}).click();await reply(page).getByRole('combobox',{name:'Existing Chat',exact:true}).click();await page.locator('[role=option][data-value="'+first+'"]').click();await reply(page).getByRole('button',{name:'Set execution Chat',exact:true}).click();await expect(reply(page)).toContainText('already executes another Task');
});
