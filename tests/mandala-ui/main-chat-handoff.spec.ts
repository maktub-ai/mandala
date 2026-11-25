import { expect, test } from '@playwright/test';

test('the main chat accepts a clarification while working and keeps partial replies on stop', async ({ page, request }) => {
  const system = await (await request.get('/api/mandala')).json();
  const agent = system.config.agents.find((item: {id:string}) => item.id === system.config.mandala.agentId);
  const queue = '/api/conversations/' + system.conversation.id + '/queue';
  await page.goto('/mandala');
  const composer = page.getByRole('textbox', {name:'消息', exact:true});
  const send = page.getByRole('button', {name:'发送消息', exact:true});
  const stop = page.getByRole('button', {name:'停止执行', exact:true});
  await expect(composer).toHaveAttribute('placeholder', '给 ' + agent.name + ' 发消息…');
  const partial = page.locator('.chat-reply-bubble').getByText('Fixture reply: hold', {exact:true});
  const previous = await partial.count();
  await composer.fill('hold');
  await composer.press('Enter');
  await expect(partial).toHaveCount(previous + 1);
  await expect(stop).toBeEnabled();
  await composer.fill('/compact');
  await composer.press('Enter');
  const compact = page.locator('.composer-reference-tag').filter({hasText:'/compact'});
  await expect(compact).toBeVisible();
  await composer.press('Enter');
  await expect(page.getByRole('alert').filter({hasText:'请等当前执行结束后再整理上下文。'})).toBeVisible();
  await compact.getByRole('button').click();
  await composer.fill('请先核对库存');
  await expect(send).toBeEnabled();
  const sent = page.waitForRequest(req => req.url().endsWith(queue) && req.method() === 'POST');
  await send.click();
  expect((await sent).postDataJSON()).toMatchObject({text:'请先核对库存', steer:true});
  await expect(page.getByText('Fixture reply: 请先核对库存', {exact:true})).toBeVisible();
  await expect(page.getByText('请先核对库存', {exact:true})).toHaveCount(1);
  await expect(partial).toHaveCount(previous + 1);
  await composer.fill('hold');
  await composer.press('Enter');
  await expect(partial).toHaveCount(previous + 2);
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(page.locator('.run-incomplete,.turn-process,.turn-hooks-toggle')).toHaveCount(0);
  await page.reload();
  await expect(partial).toHaveCount(previous + 2);
  await expect(page.locator('.run-incomplete,.turn-process,.turn-hooks-toggle')).toHaveCount(0);
  await composer.fill('换个话题');
  await send.click();
  await expect(page.getByText('Fixture reply: 换个话题',{exact:true})).toBeVisible();
});

test('execution details are opt-in', async ({page,request}) => {
  const fixture = await (await request.post('/__test__/operation-outcomes')).json();
  await page.goto('/mandala');
  const turn = page.locator(`.chat-turn[data-run-id="${fixture.invocationId}"]`);
  await expect(turn.locator('.chat-reply-bubble')).toBeVisible();
  await expect(turn.locator('.turn-process,.turn-hooks-toggle,.run-overview-button')).toHaveCount(0);
  const detailsButtons = page.locator('.chat-turn').getByRole('button', {name:/执行详情|本轮过程|执行总览|Hooks/});
  await expect(detailsButtons).toHaveCount(0);
  await page.locator('.mandala-header-identity button').click();
  const preference = page.getByRole('switch', {name:'显示执行详情', exact:true});
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect(page.locator('.mandala-settings-page .settings-autosave')).toHaveText('已保存');
  await page.goBack();
  await expect(turn.locator('.turn-process')).toBeVisible();
  await page.reload();
  await expect(turn.locator('.turn-process')).toBeVisible();
  await page.locator('.mandala-header-identity button').click();
  await preference.uncheck();
  await expect(page.locator('.mandala-settings-page .settings-autosave')).toHaveText('已保存');
  await page.goBack();
  await expect(turn.locator('.turn-process')).toHaveCount(0);
  await expect(detailsButtons).toHaveCount(0);
  const composer = page.getByRole('textbox', {name:'消息',exact:true});
  await composer.fill('确认设置已关闭');
  await composer.press('Enter');
  await expect(page.getByText('Fixture reply: 确认设置已关闭',{exact:true})).toBeVisible();
  await expect(detailsButtons).toHaveCount(0);
});

test('the main chat compacts only on slash command submission and preserves attachments', async ({page,request}) => {
  const {conversation} = await (await request.get('/api/mandala')).json();
  const compactPath = '/api/conversations/' + conversation.id + '/compact';
  const messagePosts: string[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && /\/(queue|continue|attachments)$/.test(req.url())) messagePosts.push(req.url());
  });
  let attempts = 0;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  await page.route('**'+compactPath, async route => {
    expect(route.request().method()).toBe('POST');
    attempts++;
    if (attempts === 1) return route.fulfill({status:409,json:{error:'fixture busy'}});
    await paused;
    await route.fulfill({json:{status:'noop'}});
  });
  await page.goto('/mandala');
  const composer = page.getByRole('textbox', {name:'消息',exact:true});
  const send = page.getByRole('button', {name:'发送消息',exact:true});
  await expect(composer).toBeVisible();
  await expect(page.getByRole('button', {name:'整理上下文',exact:true})).toHaveCount(0);
  await page.locator('.composer input[type=file]').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('draft')});
  await composer.fill('/task');
  await page.getByRole('option', {name:/创建任务/}).click();
  const task = page.locator('.composer-reference-tag').filter({hasText:'创建任务'});
  const chip = page.locator('.composer-reference-tag').filter({hasText:'/compact'});
  await composer.fill('/com');
  await page.getByRole('option', {name:/整理上下文/}).click();
  await expect(chip).toBeVisible();
  await expect(composer).toHaveValue('');
  expect(attempts).toBe(0);
  await chip.getByRole('button').click();
  await expect(chip).toHaveCount(0);
  await expect(task).toBeVisible();
  await composer.fill('/compact');
  await composer.press('Enter');
  await expect(chip).toBeVisible();
  await composer.fill('待会再发送的草稿');
  await send.click();
  await expect(page.getByRole('alert').filter({hasText:'fixture busy'})).toBeVisible();
  await expect(chip).toBeVisible();
  await composer.press('Enter');
  await expect(page.getByRole('status').filter({hasText:'正在整理上下文'})).toBeVisible();
  await composer.press('Enter');
  await expect(send).toBeDisabled();
  release();
  await expect(page.getByRole('status').filter({hasText:'当前上下文无需整理。'})).toBeVisible();
  await expect(composer).toHaveValue('待会再发送的草稿');
  await expect(chip).toHaveCount(0);
  await expect(task).toBeVisible();
  await task.getByRole('button').click();
  await expect(page.locator('.composer-attachments')).toContainText('draft.txt');
  expect(attempts).toBe(2);
  expect(messagePosts).toEqual([]);
  await composer.fill('讨论 /compact');
  const sent = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/queue'));
  await composer.press('Enter');
  expect((await sent).postDataJSON().text).toBe('讨论 /compact');
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('status').filter({hasText:'当前上下文无需整理。'})).toBeHidden({timeout:10000});
  expect(attempts).toBe(2);
});

test('the main chat keeps actionable approvals and real failures visible with details hidden', async ({page}) => {
  await page.goto('/mandala');
  const composer = page.getByRole('textbox',{name:'消息',exact:true});
  await composer.fill('mcp-approval-once');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const card = page.locator('.approval-card');
  await expect(card).toBeVisible();
  await expect(page.locator('.mandala-typing')).toBeHidden();
  await expect(page.locator('.turn-process')).toHaveCount(0);
  // This fixture expects approval. Rejecting it makes the runtime return a concrete error.
  await card.getByRole('button',{name:'拒绝',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Invalid MCP elicitation response'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert').filter({hasText:'Invalid MCP elicitation response'})).toBeVisible();
});

for (const reason of ['context-window','interrupted'] as const) {
  test(`a clarification waiting on ${reason} can be retried or cancelled`, async ({page,request}) => {
    const {conversation} = await (await request.get('/api/mandala')).json();
    const path = '/api/conversations/' + conversation.id;
    const text = '保留这条说明 ' + reason;
    const input = {id:'pending-' + reason, conversationId:conversation.id, state:'queued', text, createdAt:new Date().toISOString(),
      ...(reason==='context-window'?{waitingReason:reason}:{})};
    let visible=true;
    if(reason==='context-window'){
      const event={id:1,conversationId:conversation.id,kind:'user',data:{queuedInputId:input.id,text},createdAt:input.createdAt};
      await page.route('**'+path+'/events',route=>route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(event)+'\n\nevent: history-ready\ndata: {}\n\n'}));
    }
    await page.route('**'+path, async route=>{
      const response=await route.fetch();
      const snapshot=await response.json();
      await route.fulfill({response,json:{...snapshot,conversation:{...snapshot.conversation,status:reason==='interrupted'?'interrupted':'idle'}}});
    });
    await page.route('**'+path+'/queue', route=>route.fulfill({json:visible?[input]:[]}));
    await page.route('**'+path+'/queue/'+input.id, route=>{
      visible=false;
      return route.fulfill({json:{}});
    });
    await page.goto('/mandala');
    const row=page.locator('.queued-input');
    await expect(row).toBeVisible();
    if(reason==='context-window')await expect(row).toContainText('切换到上下文更大的模型');
    await expect(page.getByText(text,{exact:true})).toHaveCount(1);
    const retry=row.getByRole('button',{name:'继续发送',exact:true});
    const cancel=row.getByRole('button',{name:'取消排队',exact:true});
    await expect(retry).toBeEnabled();
    await expect(cancel).toBeEnabled();
    const sent=page.waitForRequest(req=>req.url().endsWith('/queue/'+input.id));
    await (reason==='context-window'?retry:cancel).click();
    expect((await sent).method()).toBe(reason==='context-window'?'POST':'DELETE');
    await expect(row).toHaveCount(0);
  });
}

for (const edited of [false,true]) test(`Enter on a freshly opened main chat respects draft edits while loading: ${edited}`, async ({page}) => {
  let release!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/drafts/entry?*',async route=>{await paused;await route.continue();});
  let posts=0;
  page.on('request',req=>{if(req.method()==='POST' && /\/api\/conversations\/[^/]+\/(queue|continue)$/.test(req.url()))posts++;});
  await page.goto('/mandala');
  const composer=page.getByRole('textbox',{name:'消息',exact:true});
  await composer.fill('在载入时发送');
  await composer.press('Enter');
  if (edited) await composer.fill('载入时修改了草稿');
  release();
  if (edited) {
    const send=page.getByRole('button',{name:'发送消息',exact:true});
    await expect(send).toBeEnabled();
    expect(posts).toBe(0);
    await send.click();
  }
  await expect(page.getByText('Fixture reply: '+(edited?'载入时修改了草稿':'在载入时发送'),{exact:true})).toBeVisible();
  expect(posts).toBe(1);
});
