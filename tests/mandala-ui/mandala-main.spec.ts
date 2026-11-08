import { expect, test } from '@playwright/test';

test('Mandala keeps one chat, allows only its settings, and preserves composed Chinese text', async ({ page, request }) => {
  await page.goto('/mandala');
  await expect(page.getByRole('button', { name: 'Mandala 设置', exact:true })).toBeVisible();
  const first = await (await request.get('/api/mandala')).json();
  await page.getByRole('button', { name: 'Mandala 设置', exact:true }).click();
  await page.getByRole('textbox', { name: '名字', exact:true }).fill('Mandala 测试');
  await page.getByRole('textbox', { name: 'soul.md', exact:true }).fill('简明地协作，保留中文偏好。');
  await page.getByRole('spinbutton', { name: '后台总并行上限', exact:true }).fill('4');
  await page.getByRole('button', { name: '保存', exact:true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name:'Mandala 测试 设置',exact:true })).toBeVisible();
  const composer=page.getByRole('textbox',{name:'消息',exact:true});
  await composer.fill('中文输入尚未发送');
  await composer.dispatchEvent('compositionstart');
  await composer.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  await expect(composer).toHaveValue('中文输入尚未发送');
  await composer.dispatchEvent('compositionend');
  await composer.fill('hello');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect(page.getByText('Fixture reply: hello',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText('Fixture reply: hello',{exact:true})).toBeVisible();
  await expect(page.getByRole('button', { name:'Mandala 测试 设置',exact:true })).toBeVisible();
  const second = await (await request.get('/api/mandala')).json();
  expect(second.conversation.id).toBe(first.conversation.id);
  expect(second.config.mandala).toMatchObject({maxParallel:4,soul:'简明地协作，保留中文偏好。'});
  await page.getByRole('button', { name:'Mandala 测试 设置',exact:true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/agents/'+first.config.mandala.agentId);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox',{name:'soul.md',exact:true})).toHaveValue('简明地协作，保留中文偏好。');
  await expect(page.getByRole('textbox',{name:'职责与指令',exact:true})).toHaveCount(0);
});

for(const mode of ['light','dark'] as const) for(const width of [1440,1024,768,390]) {
  test(`Mandala renders ${mode} at ${width}px with accessible settings`,async({page},testInfo)=>{
    await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);
    await page.setViewportSize({width,height:900});
    await page.goto('/mandala');
    await expect(page.locator('.mandala-header-identity')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`mandala-${mode}-${width}.png`),fullPage:true,animations:'disabled'});
    await page.locator('.mandala-header-identity button').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('textbox',{name:'名字',exact:true})).toBeVisible();
    await expect.poll(()=>page.getByRole('dialog').evaluate(element=>Number(getComputedStyle(element).opacity))).toBe(1);
    const bounds=await page.getByRole('dialog').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(900);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`mandala-settings-${mode}-${width}.png`),fullPage:true,animations:'disabled'});
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.mandala-header-identity button')).toBeFocused();
  });
}

test('a failed primary bootstrap preserves the main entry and offers retry',async({page})=>{
  await page.route('**/api/mandala',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporarily unavailable'})}),{times:1});
  await page.goto('/mandala');
  await expect(page.getByRole('alert')).toContainText('Temporarily unavailable');
  await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.locator('.mandala-header-identity')).toBeVisible();
});

test('ordinary New Chat excludes Mandala and clears a managed preselection before first send',async({page,request})=>{
  const system=await(await request.get('/api/mandala')).json();
  const identity=system.config.agents.find((agent:{id:string})=>agent.id===system.config.mandala.agentId);
  await page.goto('/?project=&agent=');
  const picker=page.getByRole('combobox',{name:'当前 智能体',exact:true});
  await picker.click();
  await expect(page.getByRole('option',{name:identity.name,exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/?project=&agent='+identity.id);
  await expect(picker).toContainText('不使用 智能体');
  await page.getByRole('textbox',{name:'消息',exact:true}).fill('ordinary first send');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect(page.getByText('Fixture reply: ordinary first send',{exact:true})).toBeVisible();
  const conversationId=new URL(page.url()).searchParams.get('conversation');
  expect(conversationId).not.toBe(system.conversation.id);
  const created=await(await request.get('/api/conversations/'+conversationId)).json();
  expect(created.conversation.agentId).toBe('');
});
