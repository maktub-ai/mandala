import { expect, test } from '@playwright/test';

test('managed models persist per runtime and status follows idle configuration versus active execution', async ({ page, request },testInfo) => {
  const initial=await(await request.get('/api/mandala')).json();
  const settings={name:'Mandala',soul:'',cli:'codex',maxParallel:3,models:{codex:'',omp:'saved-omp-model'}};
  expect((await request.put('/api/mandala',{data:{revision:initial.revision,settings}})).ok()).toBe(true);
  const probes:string[]=[];
  page.on('request',req=>{if(req.url().includes('/api/cli/status?'))probes.push(new URL(req.url()).searchParams.get('cli')!);});
  await page.route('**/api/cli/status?*',route=>new URL(route.request().url()).searchParams.get('cli')==='omp'
    ?route.fulfill({json:{status:'login-required',version:'omp-fixture'}}):route.continue());
  await page.route('**/api/models?*',route=>new URL(route.request().url()).searchParams.get('cli')==='omp'
    ?route.fulfill({json:[]}):route.continue());
  await page.goto('/mandala');
  const status=page.getByRole('button',{name:'执行端状态',exact:true});
  const open=()=>page.locator('.mandala-header-identity button').click();
  const model=page.getByRole('combobox',{name:'模型',exact:true});
  const runtime=page.getByRole('combobox',{name:'Runtime',exact:true});
  const chooseRuntime=async(value:string)=>{await runtime.click();await page.getByRole('option',{name:value,exact:true}).click();await expect(page.getByRole('listbox')).toHaveCount(0);await expect(runtime).toBeFocused();};
  const save=async()=>{await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
  const composer=page.getByRole('textbox',{name:'消息',exact:true});
  await composer.fill('未发送的设置草稿');
  await open();
  await expect(page.getByText('已读取 2 个候选',{exact:true})).toBeVisible();
  await model.click();
  await page.getByRole('option',{name:'Second fixture',exact:true}).click();
  await chooseRuntime('OMP');
  await expect(model).toHaveAttribute('data-value','saved-omp-model');
  await model.focus();await page.keyboard.press('Enter');
  await page.getByRole('searchbox',{name:'模型 · 搜索选项',exact:true}).fill('provider/custom-model');
  await page.keyboard.press('Enter');
  await expect(model).toBeFocused();
  await chooseRuntime('Codex');
  await expect(model).toHaveAttribute('data-value','model-second');
  await chooseRuntime('OMP');await save();
  await expect(status).toHaveText('OMP');
  await expect.poll(()=>probes.at(-1)).toBe('omp');
  await expect(page.locator('.cli-notice')).toContainText('OMP');
  await expect(composer).toHaveValue('未发送的设置草稿');
  await status.click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'OMP',exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('omp-fixture');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(status).toHaveText('OMP');
  await expect(composer).toHaveValue('未发送的设置草稿');
  await open();await expect(model).toHaveAttribute('data-value','provider/custom-model');
  await chooseRuntime('Codex');await expect(model).toHaveAttribute('data-value','model-second');await save();
  await composer.fill('Prepare selected model');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect(page.getByText(/^Fixture reply:/).last()).toContainText('Prepare selected model');
  await expect.poll(async()=>(await(await request.get('/api/mandala')).json()).conversation.status).toBe('idle');
  await composer.fill('hold');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect.poll(async()=>(await(await request.get('/api/mandala')).json()).conversation.status).toBe('running');
  await open();await model.click();await page.getByRole('option',{name:'Fixture',exact:true}).click();await save();
  await expect(status).toContainText('下轮：切换模型');
  expect((await(await request.get('/api/mandala')).json()).conversation.model).toBe('model-second');
  await open();await chooseRuntime('OMP');await save();
  await expect(status).toContainText('Codex');await expect(status).toContainText('下轮：OMP');
  await expect.poll(()=>probes.at(-1)).toBe('codex');
  await page.setViewportSize({width:390,height:900});
  await page.getByRole('button',{name:'收起右侧栏',exact:true}).click();
  await expect(status).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('pending-runtime-390.png'),animations:'disabled'});
  await page.setViewportSize({width:1280,height:850});
  await page.reload();await expect(status).toContainText('Codex');await expect(status).toContainText('下轮：OMP');
  expect((await request.post('/api/conversations/'+initial.conversation.id+'/stop',{data:{}})).ok()).toBe(true);
  await expect(status).toHaveText('OMP');
  await expect.poll(()=>probes.at(-1)).toBe('omp');
  await open();await chooseRuntime('Codex');await model.click();
  await page.getByRole('option',{name:'留空，沿用原生默认模型',exact:true}).click();await save();
  const saved=await(await request.get('/api/mandala')).json();
  expect(saved.config.agents.find((agent:{id:string})=>agent.id===saved.config.mandala.agentId).models).toEqual({codex:'',omp:'provider/custom-model'});
});

test('catalog loading, failure and empty states retain custom choices and use managed identity',async({page,request})=>{
  const system=await(await request.get('/api/mandala')).json();
  await page.goto('/mandala');
  await expect(page.locator('.mandala-header-identity')).toBeVisible();
  let resolveCatalog:()=>void=()=>{};
  const delayed=new Promise<void>(resolve=>{resolveCatalog=resolve;});
  let requests=0;
  await page.route('**/api/models?*',async route=>{
    const url=new URL(route.request().url());
    if(!url.searchParams.has('projectId')){
      expect(url.searchParams.get('agentId')).toBe(system.config.mandala.agentId);
      requests++;
      if(requests===1){await delayed;return route.fulfill({status:503,json:{error:'Catalog unavailable'}});}
      return route.fulfill({json:[]});
    }
    return route.continue();
  });
  await page.locator('.mandala-header-identity button').click();
  await expect(page.getByText('正在读取模型候选…',{exact:true})).toBeVisible();
  resolveCatalog();
  await expect(page.getByText('Catalog unavailable',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'刷新模型目录',exact:true}).click();
  await expect(page.getByText('CLI 未返回模型候选；可输入自定义模型 ID。',{exact:true})).toBeVisible();
  const model=page.getByRole('combobox',{name:'模型',exact:true});
  await model.click();await page.getByRole('searchbox',{name:'模型 · 搜索选项',exact:true}).fill('unknown-model');await page.keyboard.press('Enter');
  await expect(model).toHaveAttribute('data-value','unknown-model');
  await model.click();await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();await expect(model).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
});


test('English model settings remain usable on a narrow viewport',async({page},testInfo)=>{
  await page.addInitScript(()=>localStorage.setItem('mana-language','en'));
  await page.setViewportSize({width:390,height:900});
  await page.goto('/mandala');await page.locator('.mandala-header-identity button').click();
  await expect(page.getByRole('dialog')).toContainText('Runtime and model apply to the next main-chat turn');
  await expect(page.getByRole('combobox',{name:'Model',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('english-settings-390.png'),animations:'disabled'});
  await page.keyboard.press('Escape');await expect(page.locator('.mandala-header-identity button')).toBeFocused();
});
