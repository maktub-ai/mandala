import {expect,test} from '@playwright/test';

for(const language of ['zh-CN','en'] as const) for(const width of [1440,1024,768,390]) {
  test(`empty primary guidance fits ${language} at ${width}px`,async({page},testInfo)=>{
    await page.addInitScript(language=>{localStorage.setItem('mana-language',language);localStorage.setItem('mana-theme',language==='en'?'light':'dark');},language);
    await page.setViewportSize({width,height:850});
    await page.goto('/mandala');
    const guide=page.locator('.mandala-welcome');
    await expect(guide).toBeVisible();
    await expect(guide.getByRole('button')).toHaveCount(3);
    await expect(guide.getByRole('button').first()).toBeEnabled();
    for(const button of await guide.getByRole('button').all()) {
      const bounds=await button.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
      expect(await button.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`welcome-${language}-${width}.png`),fullPage:true,animations:'disabled'});
  });
}

test('suggestions prepare an editable draft, preserve it on reload, and disappear after sending',async({page,request})=>{
  await page.goto('/mandala');
  const guide=page.locator('.mandala-welcome'),composer=page.getByRole('textbox',{name:'消息',exact:true});
  const system=await(await request.get('/api/mandala')).json();
  const before=await(await request.get('/api/conversations/'+system.conversation.id+'/history')).json();
  const executions:string[]=[];
  page.on('request',req=>{if(req.method()==='POST'&&/\/api\/conversations\/[^/]+\/(messages|queue)$/.test(new URL(req.url()).pathname))executions.push(req.url());});
  await guide.getByRole('button',{name:/梳理现有工作/}).focus();
  await page.keyboard.press('Enter');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(/按业务整理 Project.*知识可复用的模块建议 Agent/);
  await expect(guide.getByRole('button').first()).toBeDisabled();
  await composer.fill('保留我自己编辑的业务描述');
  await page.reload();
  await expect(composer).toHaveValue('保留我自己编辑的业务描述');
  await expect(guide.getByRole('button').first()).toBeDisabled();
  expect(executions).toEqual([]);
  expect(await(await request.get('/api/conversations/'+system.conversation.id+'/history')).json()).toEqual(before);
  await composer.fill('');
  await guide.getByRole('button',{name:/介绍我的业务/}).click();
  await expect(composer).toHaveValue(/先问我主要负责哪些业务/);
  await composer.fill('');
  await guide.getByRole('button',{name:/先推进一件事/}).click();
  await expect(composer).toHaveValue(/相关工作路径和完成标准/);
  expect(executions).toEqual([]);
  await composer.fill('hello');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect(page.getByText('Fixture reply: hello',{exact:true})).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Fixture reply: hello',{exact:true})).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.goto('/?project=&agent=');
  await expect(guide).toHaveCount(0);
});
