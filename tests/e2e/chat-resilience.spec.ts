import { interruptSend } from './helpers/select';
import { test, expect } from './helpers/execution-fixture';

test.beforeEach(async ({ request, executionDirectory }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  const agents=['first','second'].map(id => ({ id, name: id, instructions: 'Synthetic fixture only.', defaultCli: 'codex', models: {}, mcp: [], skills: [] }));
  const saved=await request.put('/api/config', { data: { revision, config: {
    ...config, runtimes: ['codex'],
    projects: [{ id: 'resilience', name: 'Synthetic resilience', cwd: executionDirectory, agentIds: ['first', 'second'], resources: [], mcp: [], skills: [] }],
    agents: [...config.agents.filter((agent:{id:string})=>!agents.some(item=>item.id===agent.id)),...agents],
  } } });
  expect(saved.ok(),await saved.text()).toBe(true);
});

test('a delayed send response preserves the next message typed while sending', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  let release!: () => void, processed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const accepted = new Promise<void>(resolve => { processed = resolve; });
  await page.route(`**/api/conversations/${chat.id}/queue`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); processed();
    await held; await route.fulfill({ response });
  });
  await page.goto(`/?project=resilience&conversation=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill('First request');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await accepted;
  try { await composer.fill('Next unsent request'); } finally { release(); }
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  await expect(composer).toHaveValue('Next unsent request');
});

test('an attachment for a queued message can be removed while the previous turn runs', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'hold' } });
  try {
    await page.goto(`/?project=resilience&conversation=${chat.id}`);
    await expect(page.getByTestId('chat-status')).toHaveText('执行中');
    await page.locator('input[type="file"][aria-label="上传附件"]').setInputFiles({ name: 'remove-me.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    const remove = page.getByRole('button', { name: '移除附件 remove-me.txt', exact: true });
    await expect(remove).toBeEnabled();
    await remove.click(); await expect(page.locator('.composer-attachments')).toHaveCount(0);
  } finally { await request.post(`/api/conversations/${chat.id}/stop`); }
});

test('an explicit Agent-only URL opens new context instead of the remembered conversation', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  await page.goto(`/?project=resilience&conversation=${chat.id}`);
  await expect(page.getByRole('button', { name: '重命名对话', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mana-chat'))).toBe(chat.id);
  await page.goto('/?agent=second');
  await expect(page.getByRole('region', { name: '新对话准备', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '当前 智能体', exact: true })).toHaveAttribute('data-value', 'second');
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toHaveAttribute('data-value', '');
});

for (const fresh of [false, true]) for (const attachment of [false, true]) test(`reading back an accepted send does not execute twice: new chat=${fresh}, attachment=${attachment}`, async ({ page, request }) => {
  const chat = fresh ? null : await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  let lost = false;
  let uploads = 0, posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/attachments?')) uploads++; });
  await page.route('**/api/conversations/*/queue', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    if (lost) return route.continue();
    lost = true; const response = await route.fetch(); expect(response.status()).toBe(202);
    // Lose the receipt once the persisted input has a transcript, avoiding a transient unrecorded preparation.
    const id=route.request().url().split('/').at(-2)!;
    await expect.poll(async () => (await (await request.get(`/api/conversations/${id}/queue`)).json())[0]?.state).toBe('completed');
    await route.fulfill({ status: 503, json: { error: 'Synthetic response lost after acceptance' } });
  });
  await page.goto(chat ? `/?project=resilience&conversation=${chat.id}` : '/?project=resilience&agent=first');
  if (chat) await expect(page.getByRole('button', { name: '重命名对话', exact: true })).toBeVisible();
  else await expect(page.getByRole('combobox', { name: '当前 智能体', exact: true })).toHaveAttribute('data-value', 'first');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  if (attachment) {
    await page.locator('input[type="file"]').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic retry attachment') });
    await expect(page.locator('.composer-attachments')).toContainText('retry.txt');
  }
  await composer.fill('Exactly one request');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get('conversation')!;
  await expect(page.getByText('Fixture reply: Exactly one request', { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/conversations/${id}/queue`)).json())[0]?.state).toBe('completed');
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  expect(posts).toBe(1);
  await expect(page.getByText('Fixture reply: Exactly one request', { exact: true })).toHaveCount(1);
  const inputs = await (await request.get(`/api/conversations/${id}/queue`)).json();
  expect(inputs.filter((input: { text: string }) => input.text === 'Exactly one request')).toHaveLength(1);
  expect(inputs[0].attachments ?? []).toHaveLength(attachment ? 1 : 0);
  expect(uploads).toBe(attachment ? 1 : 0);
  await expect(composer).toHaveValue('');
  await composer.fill('Exactly one request');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/conversations/${id}/queue`)).json()).length).toBe(2);
  expect(posts).toBe(2);
  expect(uploads).toBe(attachment ? 1 : 0);
});

test('a lost interrupt-and-send receipt is checked without repeating the interruption', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'hold' } });
  let interrupts = 0;
  const active=await (await request.get(`/api/conversations/${chat.id}`)).json();
  await page.route(`**/api/conversations/${chat.id}/queue`, route => {
    if(route.request().method()!=='POST'||!route.request().postDataJSON().expectedExecutionId)return route.continue();
    expect(route.request().postDataJSON().expectedExecutionId).toBe(active.executionId);
    interrupts++; return route.abort();
  });
  try {
    await page.goto(`/?project=resilience&conversation=${chat.id}`);
    await expect(page.getByTestId('chat-status')).toHaveText('执行中');
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('Queue instead of interrupting');
    await interruptSend(page);
    await expect(page.getByRole('alert').filter({hasText:'提交状态待确认'})).toBeVisible();
    await expect(composer).toHaveValue('Queue instead of interrupting');
    await page.getByRole('button', { name: '核对上次发送', exact: true }).click();
    expect(interrupts).toBe(1);expect(await(await request.get(`/api/conversations/${chat.id}/queue`)).json()).toHaveLength(0);
    await page.getByRole('button',{name:'结束本次恢复',exact:true}).click();const resolution=page.getByRole('dialog',{name:'结束本次恢复',exact:true});await resolution.getByRole('checkbox',{name:'我已检查对话历史',exact:true}).check();await resolution.getByRole('button',{name:'保留草稿并结束',exact:true}).click();
    await page.getByRole('button', { name: '排队发送', exact: true }).click();
    await expect(page.getByRole('region', { name: '等待发送', exact: true })).toContainText('Queue instead of interrupting');
    expect(interrupts).toBe(1);
  } finally { await request.post(`/api/conversations/${chat.id}/stop`); }
});


// Exercise the writer conflict without unrelated asynchronous memory jobs
// affecting its intentionally conservative chronological recovery predicate.
const writerConflictTest = test.extend<{ quietMemory: true }>({
  quietMemory: [async ({request}, use) => {
    const {config,revision}=await (await request.get('/api/config')).json();
    const original=config.system?.memoryCapture;
    config.system={...config.system,memoryCapture:false};
    expect((await request.put('/api/config',{data:{config,revision}})).ok()).toBe(true);
    try { await use(true); }
    finally {
      const current=await (await request.get('/api/config')).json();
      current.config.system={...current.config.system,memoryCapture:original};
      expect((await request.put('/api/config',{data:current})).ok()).toBe(true);
    }
  },{auto:true}],
});
writerConflictTest('writer conflict retains the submitted request and attachment across reload and copies them into a new draft', async ({ page, request }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  const first = config.agents.find((agent: {id: string}) => agent.id === 'first');
  expect(first).toBeDefined();
  first.runtime = { codex: { args: ['--resume-conflict'] } };
  const configured = await request.put('/api/config', { data: { config, revision } });
  expect(configured.ok(), await configured.text()).toBe(true);
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'Establish native thread' } });
  await expect.poll(async () => (await (await request.get(`/api/conversations/${chat.id}`)).json()).conversation.status).toBe('idle');
  await page.goto(`/?project=resilience&conversation=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(page.getByRole('button', { name: '重命名对话', exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: 'keep-me.txt', mimeType: 'text/plain', buffer: Buffer.from('Retained attachment') });
  await expect(page.locator('.composer-attachments')).toContainText('keep-me.txt');
  await composer.fill('Retain my failed request');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert').filter({hasText:'另一个 Codex 客户端仍占用此对话'})).toBeVisible();
  await expect(page.getByText('Fixture reply: Retain my failed request', {exact:true})).toHaveCount(0);
  await expect(page.locator('.message.user').last()).toContainText('Retain my failed request');
  await expect(composer).toHaveValue('');
  const lateReply=await request.post('/__test__/writer-conflict-reply/'+chat.id);
  expect(lateReply.status()).toBe(204);
  await page.reload();
  await expect(page.getByText('Passive reply arrived after writer conflict',{exact:true})).toBeVisible();
  const message = page.locator('.message.user').last();
  await expect(message).toContainText('Retain my failed request');
  await expect(message).toContainText('keep-me.txt');
  await expect(message.getByRole('button', { name: '复制消息', exact: true })).toBeEnabled();
  const retryHere = message.getByRole('button', { name: '恢复到当前草稿', exact: true });
  await composer.fill('Another unsent draft');
  await expect(retryHere).toBeDisabled();
  await expect(composer).toHaveValue('Another unsent draft');
  await composer.fill('');
  let startDownload!: () => void, releaseDownload!: () => void;
  const downloadStarted = new Promise<void>(resolve => { startDownload = resolve; });
  const downloadReleased = new Promise<void>(resolve => { releaseDownload = resolve; });
  await page.route(`**/api/conversations/${chat.id}/attachments/*?download=1`, async route => {
    startDownload();
    await downloadReleased;
    await route.continue();
  }, { times: 1 });
  await retryHere.click();
  try {
    await downloadStarted;
    await composer.fill('Draft typed during recovery');
  } finally { releaseDownload(); }
  // This control is disabled for the lifetime of the restore; don't clear the
  // draft until the completed attachment request has been handled.
  await expect(message.getByRole('button', { name: '编辑消息', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Draft typed during recovery');
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
  await composer.fill('');
  await retryHere.click();
  await expect(composer).toHaveValue('Retain my failed request');
  await expect(page.locator('.composer-attachments')).toContainText('keep-me.txt');
  expect(new URL(page.url()).searchParams.get('conversation')).toBe(chat.id);
  await expect(page.getByText('Fixture reply: Retain my failed request', {exact:true})).toHaveCount(0);
  await page.getByRole('button', { name: '移除附件 keep-me.txt', exact: true }).click();
  await composer.fill('');
  let supersededStarted!: () => void, supersededRelease!: () => void;
  const supersededDownload = new Promise<void>(resolve => { supersededStarted = resolve; });
  const finishSupersededDownload = new Promise<void>(resolve => { supersededRelease = resolve; });
  await page.route(`**/api/conversations/${chat.id}/attachments/*?download=1`, async route => {
    supersededStarted();
    await finishSupersededDownload;
    await route.continue();
  }, { times: 1 });
  await retryHere.click();
  try {
    await supersededDownload;
    expect((await request.post('/__test__/writer-conflict-reply/'+chat.id+'/queued')).status()).toBe(204);
    await expect(page.getByText('Queued continuation arrived during restore',{exact:true})).toBeVisible();
    await expect(retryHere).toHaveCount(0);
  } finally { supersededRelease(); }
  await expect(message.getByRole('button', { name: '编辑消息', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.composer-attachments')).toHaveCount(0);
  const sourceScope=encodeURIComponent(JSON.stringify({kind:'chat',conversationId:chat.id}));const originalDraft=(await(await request.get('/api/drafts/entry?scope='+sourceScope)).json()).draft;
  await message.hover();
  await message.getByRole('button', { name: '在新对话中使用此请求', exact: true }).click();
  await expect(page.getByRole('region', { name: '新对话准备' })).toBeVisible();
  await expect(composer).toHaveValue('Retain my failed request');
  await expect(page.locator('.composer-attachments')).toContainText('keep-me.txt');
  expect(new URL(page.url()).searchParams.has('conversation')).toBe(false);
  expect((await(await request.get('/api/drafts/entry?scope='+sourceScope)).json()).draft).toEqual(originalDraft);
  const draftScope=encodeURIComponent(JSON.stringify({kind:'chat',conversationId:'',projectId:'resilience',agentId:'first'}));
  await expect.poll(async () => (await (await request.get('/api/drafts/entry?scope='+draftScope)).json()).draft?.text).toBe('Retain my failed request');
  await page.reload();
  await expect(composer).toHaveValue('Retain my failed request');
  await expect(page.locator('.composer-attachments')).toContainText('keep-me.txt');
  expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).conversation.status).toBe('error');
});


test('legacy accepted requests missing from the transcript remain accessible as saved drafts', async ({ page, request }) => {
  const targetScope={kind:'chat',conversationId:'',projectId:'resilience',agentId:'first'};const previous=await(await request.get('/api/drafts/entry?scope='+encodeURIComponent(JSON.stringify(targetScope)))).json();expect((await request.put('/api/drafts/entry',{data:{scope:targetScope,expectedRevision:previous.revision,draft:{text:'An unrelated prepared draft',references:[],attachments:[{name:'unrelated.txt',size:4,type:'text/plain',lastModified:12345}]}}})).ok()).toBe(true);
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  await page.route(`**/api/conversations/${chat.id}/queue`, route => route.fulfill({ json: [{ id: 'legacy-input', conversationId: chat.id, text: 'Legacy request retained in queue storage', state: 'completed', unrecorded: true, createdAt: new Date().toISOString() }] }));
  await page.goto(`/?project=resilience&conversation=${chat.id}`);
  const saved = page.getByRole('region', { name: '已保存的请求', exact: true });
  await expect(saved).toContainText('Legacy request retained in queue storage');
  await expect(saved.getByRole('button', { name: '复制消息', exact: true })).toBeEnabled();
  const sourceScope=encodeURIComponent(JSON.stringify({kind:'chat',conversationId:chat.id}));const originalDraft=(await(await request.get('/api/drafts/entry?scope='+sourceScope)).json()).draft;
  await saved.getByRole('button', { name: '在新对话中使用此请求', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('Legacy request retained in queue storage');await expect(page.locator('.composer-attachments .attachment-chip')).toHaveCount(0);await expect(page.getByText('unrelated.txt',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('region', { name: '新对话准备' })).toBeVisible();
  expect((await(await request.get('/api/drafts/entry?scope='+sourceScope)).json()).draft).toEqual(originalDraft);await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();await expect.poll(async()=>(await(await request.get('/api/drafts/entry?scope='+encodeURIComponent(JSON.stringify(targetScope)))).json()).draft).toEqual({text:'Legacy request retained in queue storage',references:[],attachments:[]});await page.reload();await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Legacy request retained in queue storage');await expect(page.getByText('unrelated.txt',{exact:true})).toHaveCount(0);
});


test('offline receipt readback preserves the draft and reconnect confirms it without replay', async ({ page, request }) => {
 const chat=await (await request.post('/api/conversations',{data:{projectId:'resilience',agentId:'first'}})).json();
 let online=false, submitted:any, posts=0;
 await page.route(`**/api/conversations/${chat.id}/queue`, async route=>{
  if(route.request().method()==='POST') { posts++;submitted=route.request().postDataJSON();return route.abort('connectionfailed'); }
  if(!online)return route.abort('connectionfailed');
  return route.fulfill({json:[{id:'accepted',conversationId:chat.id,text:submitted.text,commandKey:submitted.commandKey,state:'completed',createdAt:new Date().toISOString()}]});
 });
 await page.goto(`/?project=resilience&conversation=${chat.id}`);
 const composer=page.getByRole('textbox',{name:'消息',exact:true});
 await composer.fill('Keep this uncertain draft');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'提交状态待确认'})).toBeVisible();
 await expect(composer).toHaveValue('Keep this uncertain draft');
 expect(posts).toBe(1);
 await page.screenshot({path:'/tmp/mandala-task3-draft-retained.png',fullPage:true});
 online=true;
 await page.getByRole('button',{name:'核对上次发送',exact:true}).click();
 await expect(composer).toHaveValue('');
 expect(posts).toBe(1);
 await page.screenshot({path:'/tmp/mandala-task3-receipt-confirmed.png',fullPage:true});
});


for(const receipt of [{state:'unknown'},{state:'cancelled'},{state:'completed',unrecorded:true}])test(`unusable input receipt retains the draft without replay: ${JSON.stringify(receipt)}`,async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'resilience',agentId:'first'}})).json();
 let submitted:any,posts=0;
 await page.route(`**/api/conversations/${chat.id}/queue`,async route=>{
  if(route.request().method()==='POST'){posts++;submitted=route.request().postDataJSON();return route.fulfill({status:503,json:{error:'Synthetic receipt lost'}});}
  return route.fulfill({json:submitted?[{id:'uncertain-input',conversationId:chat.id,text:submitted.text,commandKey:submitted.commandKey,createdAt:new Date().toISOString(),...receipt}]:[]});
 });
 await page.goto(`/?project=resilience&conversation=${chat.id}`);
 const composer=page.getByRole('textbox',{name:'消息',exact:true});
 await composer.fill('Retain this request');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'输入已保留'})).toBeVisible();
 await expect(composer).toHaveValue('Retain this request');
 await page.getByRole('button',{name:'核对上次发送',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'输入已保留'})).toBeVisible();
 await expect(composer).toHaveValue('Retain this request');
 expect(posts).toBe(1);
});

for(const interrupt of [false,true])test(`lost keyed continuation receipt is read back without replay: interrupt=${interrupt}`,async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'resilience',agentId:'first'}})).json();
 await request.post(`/api/conversations/${chat.id}/messages`,{data:{text:'hold'}});
 if(!interrupt){
  const stopped=await request.post(`/api/conversations/${chat.id}/stop`,{data:{}});
  expect(stopped.ok(),await stopped.text()).toBe(true);
  expect((await stopped.json()).stopConfirmed).toBe(true);
  await expect.poll(async()=>(await(await request.get(`/api/conversations/${chat.id}`)).json()).conversation.status).toBe('interrupted');
 }
 let continuations=0,stops=0;
 page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith(`/conversations/${chat.id}/stop`))stops++;});
 await page.route(`**/api/conversations/${chat.id}/${interrupt?'queue':'continue'}`,async route=>{
  if(route.request().method()!=='POST')return route.continue();
  continuations++;
  const response=await route.fetch();expect(response.ok()).toBe(true);
  await expect.poll(async()=>(await(await request.get(`/api/conversations/${chat.id}/queue`)).json())[0]?.state).toBe('completed');
  return route.fulfill({status:503,json:{error:'Synthetic continuation receipt lost'}});
 });
 await page.goto(`/?project=resilience&conversation=${chat.id}`);
 const composer=page.getByRole('textbox',{name:'消息',exact:true});
 await composer.fill('Continue exactly once');
 if (interrupt) await interruptSend(page); else await page.getByRole('button', { name: '继续执行', exact: true }).click();
 await expect(composer).toHaveValue('');
 await expect(page.getByRole('alert')).toHaveCount(0);
 await expect(page.getByText('Fixture reply: Continue exactly once',{exact:true})).toBeVisible();
 expect(continuations).toBe(1);expect(stops).toBe(0);
 const inputs=await(await request.get(`/api/conversations/${chat.id}/queue`)).json();
 expect(inputs).toHaveLength(1);expect(inputs[0].commandKey).toEqual(expect.any(String));
});

test('a file accepted while the prepared draft loads survives hydration and reaches the real queue',async({page,request})=>{
 let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),reading=new Promise<void>(resolve=>entered=resolve);let delayed=false;
 await page.route('**/api/drafts/entry?*',async route=>{const scope=JSON.parse(new URL(route.request().url()).searchParams.get('scope')!);if(!delayed&&route.request().method()==='GET'&&scope.kind==='chat'&&!scope.conversationId){delayed=true;entered();await blocked;}await route.continue();});
 await page.goto('/?project=resilience&agent=second');await reading;const composer=page.getByRole('textbox',{name:'消息',exact:true});await expect(composer).toBeDisabled();
 try{await page.locator('input[type=file][aria-label="上传附件"]').setInputFiles({name:'early-file.txt',mimeType:'text/plain',buffer:Buffer.from('Retain these exact bytes')});await expect(page.locator('.composer-attachments')).toContainText('early-file.txt');}finally{release();}
 await expect(composer).toBeEnabled();await expect(page.locator('.composer-attachments')).toContainText('early-file.txt');await composer.fill('Keep the accepted early file');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByText('Fixture reply: Keep the accepted early file',{exact:true})).toBeVisible();const id=new URL(page.url()).searchParams.get('conversation')!;const inputs=await(await request.get('/api/conversations/'+id+'/queue')).json();expect(inputs).toHaveLength(1);expect(inputs[0].attachments).toHaveLength(1);
 const attachment=inputs[0].attachments[0];expect(await(await request.get('/api/conversations/'+id+'/attachments/'+attachment+'?download=1')).text()).toBe('Retain these exact bytes');
});

test('different file bytes with identical metadata survive draft hydration',async({page,request})=>{
 let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),reading=new Promise<void>(resolve=>entered=resolve);let delayed=false;
 await page.route('**/api/drafts/entry?*',async route=>{const scope=JSON.parse(new URL(route.request().url()).searchParams.get('scope')!);if(!delayed&&route.request().method()==='GET'&&scope.kind==='chat'&&!scope.conversationId){delayed=true;entered();await blocked;}await route.continue();});
 await page.goto('/?project=resilience&agent=second');await reading;const composer=page.getByRole('textbox',{name:'消息',exact:true});await expect(composer).toBeDisabled();
 try{await page.locator('input[type=file][aria-label="上传附件"]').evaluate((input:HTMLInputElement)=>{const transfer=new DataTransfer();for(const text of ['AAAA','BBBB'])transfer.items.add(new File([text],'same.txt',{type:'text/plain',lastModified:12345}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});await expect(page.locator('.composer-attachments .attachment-chip')).toHaveCount(2);}finally{release();}
 await expect(composer).toBeEnabled();await expect(page.locator('.composer-attachments .attachment-chip')).toHaveCount(2);await composer.fill('Keep the accepted early file');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByText('Fixture reply: Keep the accepted early file',{exact:true})).toBeVisible();const id=new URL(page.url()).searchParams.get('conversation')!;const inputs=await(await request.get('/api/conversations/'+id+'/queue')).json();expect(inputs).toHaveLength(1);expect(inputs[0].attachments).toHaveLength(2);
 const bytes=await Promise.all(inputs[0].attachments.map(async(attachment:string)=>(await request.get('/api/conversations/'+id+'/attachments/'+attachment+'?download=1')).text()));expect(bytes).toEqual(['AAAA','BBBB']);
});


writerConflictTest('recover a proven unsubmitted direct mailbox request without replacing or sending a draft', async ({ page, request }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  const first = config.agents.find((agent: {id: string}) => agent.id === 'first');
  first.runtime = { codex: { args: ['--fixture-mailbox-setup-failed'] } };
  const configured = await request.put('/api/config', { data: { config, revision } });
  expect(configured.ok(), await configured.text()).toBe(true);
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'resilience', agentId: 'first' } })).json();
  const failed = await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'Please retain this direct request' } });
  expect(failed.status()).toBe(500);

  const submissions: string[]=[];
  await page.route(`**/api/conversations/${chat.id}/**`, route=>{
    if(route.request().method()==='POST' && /\/(?:queue|messages|continue)$/.test(new URL(route.request().url()).pathname)){
      submissions.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`/?project=resilience&conversation=${chat.id}`);
  await expect(page.getByRole('alert').filter({hasText:'消息未发送到 Codex'})).toContainText('Windows 沙箱');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  const restore = page.getByRole('button', { name: '恢复到当前草稿', exact: true });
  await composer.fill('An existing new draft');
  await expect(restore).toBeDisabled();
  await expect(composer).toHaveValue('An existing new draft');
  await composer.fill('');
  await restore.click();
  await expect(composer).toHaveValue('Please retain this direct request');
  expect(new URL(page.url()).searchParams.get('conversation')).toBe(chat.id);
  expect(submissions).toEqual([]);
});

writerConflictTest('queued writer conflict restores a draft in the same chat and sends once only after release', async ({page,request})=>{
 const initial=await (await request.get('/api/config')).json();
 const agent=initial.config.agents.find((a:{id:string})=>a.id==='first');
 agent.runtime={codex:{args:['--resume-conflict']}};
 expect((await request.put('/api/config',{data:initial})).ok()).toBe(true);
 const chat=await (await request.post('/api/conversations',{data:{projectId:'resilience',agentId:'first'}})).json();
 expect((await request.post('/api/conversations/'+chat.id+'/messages',{data:{text:'Set up the original native thread'}})).ok()).toBe(true);
 const readChat=async()=>(await(await request.get('/api/conversations/'+chat.id)).json()).conversation;
 await expect.poll(async()=>(await readChat()).status).toBe('idle');
 const nativeId=(await readChat()).nativeId;
 expect(nativeId).toBeTruthy();
 const text='Restore this rejected queued request';
 const queued=await request.post('/api/conversations/'+chat.id+'/queue',{data:{text,commandKey:'fixture-queued-writer-held'}});
 expect(queued.status()).toBe(202);
 await expect.poll(async()=>(await readChat()).status).toBe('error');
 await page.goto('/?project=resilience&conversation='+chat.id);
 const composer=page.getByRole('textbox',{name:'消息',exact:true});
 const restore=page.locator('.message.user').last().getByRole('button',{name:'恢复到当前草稿',exact:true});
 await expect(page.getByText('此请求未发送。等另一个 Codex 客户端释放这条会话后，可在原对话恢复草稿再发送。')).toBeVisible();
 await composer.fill('Do not replace my draft');
 await expect(restore).toBeDisabled();
 await composer.fill('');
 await restore.click();
 await expect(composer).toHaveValue(text);
 expect(new URL(page.url()).searchParams.get('conversation')).toBe(chat.id);
 await expect(page.getByText('Fixture reply: '+text,{exact:true})).toHaveCount(0);
 const released=await (await request.get('/api/config')).json();
 const releasedAgent=released.config.agents.find((a:{id:string})=>a.id==='first');
 delete releasedAgent.runtime;
 expect((await request.put('/api/config',{data:released})).ok()).toBe(true);
 await expect(page.getByText('Fixture reply: '+text,{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'继续执行',exact:true}).click();
 await expect(page.getByText('Fixture reply: '+text,{exact:true})).toHaveCount(1);
 expect((await readChat()).nativeId).toBe(nativeId);
 expect(new URL(page.url()).searchParams.get('conversation')).toBe(chat.id);
});
