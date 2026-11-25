import { expect, test } from '@playwright/test';

test('waiting gives way to live text and stops without leaving a pending reply', async ({ page, request }, info) => {
  const { conversation } = await (await request.get('/api/mandala')).json();
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/mandala');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  const stop = page.getByRole('button', { name: '停止执行', exact: true });
  const typing = page.locator('.mandala-typing[role=status]');
  try {
    await composer.fill('activity-flow');
    await composer.press('Enter');
    await expect(stop).toBeEnabled();
    await expect(typing).toBeVisible();
    await expect(typing).toHaveAccessibleName('等待回复');
    await expect(typing.locator('.typing-dots i').first()).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.chat-turn').filter({ has: typing }).getByRole('button', { name: '查看本轮执行详情' })).toBeHidden();
    await expect(page.locator('.turn-process,.turn-hooks-toggle')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('waiting.png'), animations: 'disabled' });
    await page.clock.fastForward(15_000);
    await expect(typing).toHaveText('仍在等待回复…');
    const reply = await request.post('/__test__/live-output-update', { data: { id: conversation.id, stage: 'answer', tagged: true } });
    expect(reply.ok()).toBe(true);
    await expect(page.getByText('核对完成，真实合计为 885。', { exact: true })).toBeVisible();
    await expect(typing).toBeHidden();
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(stop).toBeHidden();

    await composer.fill('activity-flow');
    await composer.press('Enter');
    await expect(typing).toBeVisible();
    await stop.click();
    await expect(typing).toBeHidden();
    await page.reload();
    await expect(composer).toBeVisible();
    await expect(typing).toBeHidden();
  } finally {
    await request.post('/api/conversations/' + conversation.id + '/stop');
  }
});

test('each reply and the original request copy only their own text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/mandala');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill('observed-flow');
  await composer.press('Enter');
  const turn = page.locator('.chat-turn').filter({ has: page.getByRole('article', { name: '你的消息' }).filter({ hasText: 'observed-flow' }) }).last();
  const messages = turn.locator('article.chat-reply-bubble');
  const texts = ['Checking both resources', 'Both resources are ready.', 'Evidence: A and B verified.'];
  await expect(messages).toHaveCount(texts.length);
  for (const [index, text] of [...texts, 'observed-flow'].entries()) {
    const message = index < texts.length ? messages.nth(index) : turn.getByRole('article', { name: '你的消息' });
    await message.hover();
    const copy = message.getByRole('button', { name: '复制消息', exact: true });
    await copy.click();
    await expect(copy).toHaveAttribute('title', '已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  }
  await expect(turn.locator('.turn-footer').getByRole('button', { name: '复制消息', exact: true })).toHaveCount(0);
});

test('a timed-out turn shows one readable notice and reveals its raw cause on request', async ({ page, request }, info) => {
  const fixture = await request.post('/__test__/main-chat-timeout');
  expect(fixture.ok()).toBe(true);
  const { runId } = await fixture.json();
  const raw = 'CLI request timed out: thread/resume';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mandala');
  const turn = page.locator(`.chat-turn[data-run-id="${runId}"]`);
  const notice = turn.getByRole('alert');
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText(/超时.*保留/);
  await expect(page.getByText(raw, { exact: true })).toBeHidden();
  await expect(page.locator('.mandala-typing')).toBeHidden();
  await notice.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('timeout-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole('dialog', { name: '右侧栏' });
  await panel.getByRole('button', { name: '收起右侧栏' }).click();
  await expect(panel).toBeHidden();
  await notice.scrollIntoViewIfNeeded();
  await expect(notice).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('timeout-narrow.png'), animations: 'disabled' });
  await expect(turn.getByRole('button', {name:/执行详情/})).toHaveCount(0);
  await page.locator('.mandala-header-identity button').click();
  const details = page.getByRole('checkbox', {name:'显示执行详情'});
  await details.check();
  await page.getByRole('button', {name:'保存',exact:true}).click();
  await expect(turn.getByText(raw, { exact: true })).toBeVisible();
  await page.locator('.mandala-header-identity button').click();
  await details.uncheck();
  await page.getByRole('button', {name:'保存',exact:true}).click();
  const mainUrl = page.url();
  const recovery = turn.getByRole('button', { name: '取回到当前输入框' });
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill('另一个草稿');
  await expect(recovery).toBeDisabled();
  await composer.fill('');
  await recovery.click();
  await expect(page).toHaveURL(mainUrl);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('请帮我核对参会名单。');
});

test('keeps a child-only reply out of the main answer and respects execution details',async({page,request})=>{
  const {conversation}=await(await request.get('/api/mandala')).json();
  await page.goto('/mandala');
  const preference=async(enabled:boolean)=>{
    await page.locator('.mandala-header-identity button').click();
    await page.getByRole('checkbox',{name:'显示执行详情'}).setChecked(enabled);
    await page.getByRole('button',{name:'保存',exact:true}).click();
  };
  const composer=page.getByRole('textbox',{name:'消息',exact:true});
  try {
    await preference(false);await composer.fill('activity-flow');await composer.press('Enter');
    await expect.poll(async()=>(await(await request.get('/api/conversations/'+conversation.id)).json()).conversation.turnId).toBeTruthy();
    for(const stage of ['spawn-child','child-result']){
      expect((await request.post('/__test__/live-output-update',{data:{id:conversation.id,stage}})).ok()).toBe(true);
    }
    const turn=page.locator('.chat-turn').last();
    await expect(turn.getByText('正在等待主代理回复…',{exact:true})).toBeVisible();
    await expect(turn).not.toContainText('升级步骤已经核对。');
    await preference(true);
    await turn.getByRole('button',{name:'展开本轮过程',exact:true}).click();
    const row=turn.locator('.native-subagent-row');
    await row.locator('summary').click();
    await expect(row.getByText('升级步骤已经核对。',{exact:true})).toBeVisible();
    await expect(row.locator('.identity-avatar')).toHaveCount(0);
    await expect(turn.locator('article.chat-reply-bubble')).toHaveCount(0);
  } finally {
    await request.post('/api/conversations/'+conversation.id+'/stop');
    await preference(false);
  }
});
