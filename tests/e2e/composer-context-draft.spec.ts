import { test, expect } from './helpers/execution-fixture';
import { chooseOption, expectSelection } from './helpers/select';
import { openArea, openModuleMenu } from './helpers/navigation';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'zh-CN'));
});

let projectA:string,projectB:string,writerId:string,reviewerId:string;
test.beforeEach(async ({ request, executionDirectory },testInfo) => {
  const suffix=testInfo.testId.replace(/[^a-zA-Z0-9]/g,'').slice(-20);projectA='draft-a-'+suffix;projectB='draft-b-'+suffix;writerId='writer-'+suffix;reviewerId='reviewer-'+suffix;
  const { revision } = await (await request.get('/api/config')).json();
  const response = await request.put('/api/config', { data: { revision, config: {
    version: 2,
    system: { cli: 'codex', memory: { language: 'zh-CN', request: { read: false, generate: false }, session: { read: false, generate: false } } },
    projects: [projectA, projectB].map(id => ({ id, name: id === projectA ? '草稿项目 A' : '草稿项目 B', cwd: executionDirectory, agentIds: [writerId, reviewerId], resources: [], mcp: [], skills: [] })),
    agents: [writerId, reviewerId].map(id => ({ id, name: id === writerId ? '草稿写作助手' : '草稿评审助手', instructions: 'Synthetic composer fixture.', defaultCli: 'codex', models: { codex: 'model-fixture' }, mcp: [], skills: [] })),
  } } });
  expect(response.ok(), await response.text()).toBe(true);
});

test('prepared Agent scopes retain their own unsent text', async ({ page, request }) => {
  const before = (await (await request.get('/api/conversations')).json()).map((chat: { id: string }) => chat.id);
  await page.goto(`/?project=${projectA}&agent=${writerId}`);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('未发送：请整理当前方案。');
  await chooseOption(page, '当前 智能体', reviewerId);
  await expect(input).toHaveValue('');await input.fill('评审助手的独立草稿');
  await chooseOption(page, '当前 智能体', writerId);
  await expect(input).toHaveValue('未发送：请整理当前方案。');
  expect((await (await request.get('/api/conversations')).json()).map((chat: { id: string }) => chat.id)).toEqual(before);
});

test('prepared Project and Agent scopes send only their own text', async ({ page, request }) => {
  const before = (await (await request.get('/api/conversations')).json()).map((chat: { id: string }) => chat.id);
  await page.goto(`/?project=${projectA}&agent=${writerId}`);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('未发送：请审核项目 B 的验收要求。');
  await chooseOption(page, '当前项目', projectB);
  await expect(input).toHaveValue('');
  await chooseOption(page, '当前 智能体', reviewerId);
  await expect(input).toHaveValue('');await input.fill('未发送：请审核项目 B 的验收要求。');
  expect((await (await request.get('/api/conversations')).json()).map((chat: { id: string }) => chat.id)).toEqual(before);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: 未发送：请审核项目 B 的验收要求。', { exact: true })).toBeVisible();
  const conversations = await (await request.get('/api/conversations')).json();
  const created = conversations.filter((chat: { id: string }) => !before.includes(chat.id));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ projectId: projectB, agentId: reviewerId });
});

test('back and forward between prepared Projects preserve the unsent text', async ({ page }) => {
  await page.goto(`/?project=${projectA}&agent=${writerId}`);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('未发送：切换项目后仍需保留。');
  await chooseOption(page, '当前项目', projectB);
  await expect(input).toHaveValue('');await input.fill('项目 B 的独立草稿');
  await page.goBack();
  await expectSelection(page.getByRole('combobox', { name: '当前项目', exact: true }), projectA);
  await expect(input).toHaveValue('未发送：切换项目后仍需保留。');
  await page.goForward();
  await expectSelection(page.getByRole('combobox', { name: '当前项目', exact: true }), projectB);
  await expect(input).toHaveValue('项目 B 的独立草稿');
});

test('moving between a saved conversation and new preparation does not transfer their unrelated text', async ({ page, request }) => {
  const response = await request.post('/api/conversations', { data: { projectId: projectA, agentId: writerId, cli: 'codex' } });
  expect(response.ok()).toBe(true);
  const chat = await response.json();
  await page.goto(`/?project=${projectA}&conversation=` + chat.id);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('仅供已有会话使用的文字');
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill('仅供新对话使用的文字');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('conversation=' + chat.id));
  await expect(input).toHaveValue('仅供已有会话使用的文字');
  await input.fill('旧会话的另一段文字');
  await page.goForward();
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toBeVisible();
  await expect(input).toHaveValue('仅供新对话使用的文字');
});

test('conversation drafts retain text and attachments across chats and other pages', async ({ page, request }) => {
  const ids: string[] = [];
  for (const title of ['草稿对话 A', '草稿对话 B']) {
    const response = await request.post('/api/conversations', { data: { projectId: projectA, agentId: writerId, cli: 'codex' } });
    expect(response.ok()).toBe(true);
    const { id } = await response.json();
    expect((await request.patch(`/api/conversations/${id}`, { data: { title } })).ok()).toBe(true);
    ids.push(id);
  }
  await page.goto(`/?project=${projectA}&conversation=` + ids[0]);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('草稿 A：中文和 English\n第二行');
  await page.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft attachment') });
  await page.getByRole('button', { name: '草稿对话 B', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: '移除附件 draft.txt', exact: true })).toHaveCount(0);
  await input.fill('草稿 B');
  await page.getByRole('button', { name: '草稿对话 A', exact: true }).click();
  await expect(input).toHaveValue('草稿 A：中文和 English\n第二行');
  await expect(page.getByRole('button', { name: '移除附件 draft.txt', exact: true })).toBeVisible();
  for (const area of ['用量', '设置', '任务']) {
    if (area === '用量') {
      const menu=await openModuleMenu(page);await menu.getByRole('menuitem', { name: '用量', exact: true }).click();
    } else await openArea(page, area);
    await page.getByRole('button', { name: '草稿对话 A', exact: true }).click();
    await expect(input).toHaveValue('草稿 A：中文和 English\n第二行');
  }
  await page.getByRole('button', { name: '草稿对话 B', exact: true }).click();
  await expect(input).toHaveValue('草稿 B');
  await input.clear();
  await page.getByRole('button', { name: '草稿对话 A', exact: true }).click();
  await page.getByRole('button', { name: '草稿对话 B', exact: true }).click();
  await expect(input).toHaveValue('');
});

for (const accepted of [true, false]) test(`a send finishing after navigation ${accepted ? 'clears its submitted draft' : 'retains its rejected draft'}`, async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: projectA, agentId: writerId, cli: 'codex' } })).json();
  let release!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`**/api/conversations/${chat.id}/queue`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    entered(); await released;
    if (accepted) await route.continue();
    else await route.fulfill({ status: 400, json: { error: 'Synthetic rejected send' } });
  });
  await page.goto(`/?project=${projectA}&conversation=` + chat.id);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('提交中的草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await started;
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await input.fill('另一份未提交的草稿');
  const finished = page.waitForResponse(response => response.url().endsWith(`/conversations/${chat.id}/queue`) && response.request().method() === 'POST');
  release(); await finished;
  if (accepted) await expect.poll(async () => (await (await request.get(`/api/conversations/${chat.id}/queue`)).json())[0]?.state).toBe('completed');
  await expect(input).toHaveValue('另一份未提交的草稿');
  await page.locator(`.library-open[aria-describedby^="library-context-${chat.id} "]`).click();
  await expect(input).toHaveValue(accepted ? '' : '提交中的草稿');
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await expect(input).toHaveValue('另一份未提交的草稿');
});

test('a new-chat send accepted after leaving clears the prepared draft', async ({ page, request }) => {
  const saved = await (await request.post('/api/conversations', { data: { projectId: projectA, agentId: writerId, cli: 'codex' } })).json();
  let release!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/conversations', async route => {
    if (route.request().method() === 'POST') { entered(); await released; }
    await route.continue();
  });
  await page.goto(`/?project=${projectA}&agent=${writerId}`);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('创建期间提交的草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await started;
  await page.locator(`.library-open[aria-describedby^="library-context-${saved.id} "]`).click();
  const accepted = page.waitForResponse(response => response.url().endsWith('/queue') && response.request().method() === 'POST');
  release(); await accepted;
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await expect(input).toHaveValue('');
});

test('a queued autosave preserves the newest offline text and actual File bytes',async({page})=>{
 let releaseFirst!:()=>void,releaseSecond!:()=>void,firstRead!:()=>void,secondRead!:()=>void;const firstGate=new Promise<void>(resolve=>releaseFirst=resolve),secondGate=new Promise<void>(resolve=>releaseSecond=resolve),first=new Promise<void>(resolve=>firstRead=resolve),second=new Promise<void>(resolve=>secondRead=resolve);let puts=0;
 await page.route('**/api/drafts/entry',async route=>{if(route.request().method()!=='PUT')return route.continue();const n=++puts,response=await route.fetch();if(n===1){firstRead();await firstGate;}if(n===2){secondRead();await secondGate;}return route.fulfill({response});});
 try{await page.goto(`/?project=${projectA}&agent=${writerId}`);const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('Snapshot A');await first;await input.fill('Snapshot B');await page.waitForTimeout(240);await input.fill('Newest snapshot C');await page.locator('input[type=file]').setInputFiles({name:'newest.txt',mimeType:'text/plain',buffer:Buffer.from('Newest bytes must survive')});releaseFirst();await second;await expect(input).toHaveValue('Newest snapshot C');const buffered=await page.evaluate(async()=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('mandala-composer-drafts',1);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});const rows:any[]=await new Promise((resolve,reject)=>{const req=db.transaction('drafts').objectStore('drafts').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});return Promise.all(rows.map(async row=>({text:row.draft?.text,files:await Promise.all((row.files??[]).map(async(file:File)=>({name:file.name,bytes:await file.text()})))})));});expect(buffered).toContainEqual({text:'Newest snapshot C',files:[{name:'newest.txt',bytes:'Newest bytes must survive'}]});}finally{releaseFirst();releaseSecond();}
});
