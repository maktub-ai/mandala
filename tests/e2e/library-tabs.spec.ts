import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { planEntry, handbookEntry } from '../fixtures/data-plugin';
import { setAppearanceMode } from './helpers/navigation';
import type { MarketSourceSnapshot } from '../../shared/market';

async function project(request: APIRequestContext, id: string, name: string, directories: string[]) {
  const current = await (await request.get('/api/config')).json();
  const workspaces = directories.map((cwd, index) => ({ id: 'work-' + index, name: 'Workspace ' + (index + 1), cwd, resources: [] }));
  current.config.projects.push({ id, name, cwd: directories[0], workspaces, agentIds: [], skills: [], resources: [], mcp: [] });
  expect((await request.put('/api/config', {data: current})).ok()).toBe(true);
}

async function togglePlugin(request: APIRequestContext, install: boolean, entry = planEntry) {
  const snapshot = await (await request.get('/api/market/extensions')).json();
  const catalogId = 'plugin:maktub-ai/mandala-plugins:' + entry.id;
  if ((snapshot.plugins ?? []).some((item: {catalogId: string}) => item.catalogId === catalogId) === install) return;
  const response = await request.post('/api/market/extensions/' + (install ? 'install' : 'uninstall'), {
    data: { catalogId, revision: snapshot.revision, version: entry.version, digest: entry.package.sha256 },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test('library loads a third-party archive section and sandboxes compatible local documents', async ({page,request}, info) => {
  test.setTimeout(70_000);
  const sandbox = await (await request.post('/__test__/execution-directory')).json();
  const todo = join(sandbox.directory, 'todo-app'), archive = join(sandbox.directory, 'todo-prototype');
  const blank = join(sandbox.directory, 'blank');
  for (const cwd of [todo, archive, blank]) await mkdir(cwd);
  const summary = JSON.parse(await readFile(new URL('../fixtures/omino-0.5.6/todo-app.summary.json', import.meta.url), 'utf8'));
  const nativeHtml = gunzipSync(await readFile(new URL('../fixtures/omino-0.5.6/todo-app.html.gz', import.meta.url)));
  const origins: string[] = [];
  await page.context().route('http://127.0.0.1:18331/hello?*', route => {
    origins.push(route.request().headers().origin);
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, json: { ok: false } });
  });
  const planDir = join(sandbox.ominoHome, 'projects', 'todo-app');
  for (const [id, cwd] of [['todo-app',todo], ['todo-prototype',archive]]) {
    const plan = join(sandbox.ominoHome,'projects',id);
    await mkdir(plan,{recursive:true});
    await writeFile(join(cwd,'.omino.json'),JSON.stringify({project:id}));
    await writeFile(join(plan,'summary.json'),JSON.stringify(id === 'todo-app' ? summary : {...summary,id,title:'原型验证',status:'closed'}));
  }
  await writeFile(join(planDir,'view.html'),nativeHtml);
  await project(request,'todo-single','待办清单',[todo]);
  await project(request,'todo-multi','待办工作组',[todo,archive]);
  await project(request,'todo-empty','便笺',[blank]);
  await togglePlugin(request,false);
  const single='/library?project=todo-single';
  await page.goto(single+'&tab=plan');
  await expect(page.getByRole('tab',{name:'最近'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect.poll(()=>new URL(page.url()).searchParams.get('tab')).not.toBe('plan');
  const original: MarketSourceSnapshot = await (await request.get('/api/market/sources')).json();
  const restoreEnabled = original.enabled && !original.enabled.includes('mandala-plugins') ? original.enabled : null;
  const setEnabled = async (revision: string, enabled: string[]) => {
    const saved = await request.put('/api/market/sources', { data: { revision, enabled, sources: original.sources.filter(source => source.adapter) } });
    expect(saved.ok(), await saved.text()).toBe(true);
  };
  try {
    if (restoreEnabled) await setEnabled(original.revision, [...restoreEnabled, 'mandala-plugins']);
    await page.goto('/market?kind=plugin&source=mandala-plugins');
    await page.getByRole('button',{name:'查看详情 Example Archive',exact:true}).click();
    const plugin = page.getByRole('dialog');
    await plugin.getByRole('button',{name:'安装',exact:true}).click();
    await expect(plugin.getByRole('button',{name:'卸载',exact:true})).toBeVisible();
    await page.goto(single);
    await expect(page.getByRole('tab',{name:/归档.*3/})).toBeVisible();
    await page.goto('/library?tab=plan');
    const singleProject = page.getByRole('link',{name:'打开 待办清单',exact:true});
    const severalProjects = page.getByRole('link',{name:'打开 待办工作组',exact:true});
    await expect(singleProject).toBeVisible();
    await expect(severalProjects).toBeVisible();
    await page.screenshot({path:info.outputPath('library-projects.png'),animations:'disabled'});
    await singleProject.click();
    await page.setViewportSize({width:1728,height:1040});
    const iframe=page.locator('iframe[title="个人 Todo App"]'), frame=page.frameLocator('iframe[title="个人 Todo App"]');
    await expect(iframe).toHaveAttribute('sandbox','allow-scripts');
    const nativePage = await request.get(await iframe.getAttribute('src') ?? '');
    expect(nativePage.ok()).toBe(true);
    expect((await nativePage.body()).equals(nativeHtml)).toBe(true);
    await expect(frame.locator('.foot')).toContainText('omino 0.5.6');
    await expect(frame.getByRole('button',{name:'关系图',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(frame.locator('.canvas')).toBeVisible();
    const blocked=await frame.locator('body').evaluate(() => {
      try { void parent.document.title; } catch (error) { return (error as Error).name; }
      return '';
    });
    expect(blocked).toBe('SecurityError');
    await expect.poll(()=>origins).toContain('null');
    await frame.getByRole('button',{name:'看板',exact:true}).click();
    await expect(frame.locator('.board')).toBeVisible();
    await frame.getByRole('button',{name:'列表',exact:true}).click();
    await expect(frame.locator('.listv')).toBeVisible();
    await frame.getByRole('button',{name:'关系图',exact:true}).click();
    await frame.locator('#attn-next').click();
    await expect(frame.locator('.note h2')).toHaveText('同步');
    await expect(frame.getByRole('button',{name:'确认无误'})).toBeVisible();
    await page.screenshot({path:info.outputPath('library-native-plan.png'),animations:'disabled'});
    await frame.getByRole('button',{name:'有问题…'}).click();
    await frame.getByPlaceholder('哪里不对？').fill('先完成本地版。');
    await expect(frame.getByRole('button',{name:'复制',exact:true})).toBeVisible();
    const [outside]=await Promise.all([page.waitForEvent('popup'),page.getByRole('link',{name:'在浏览器中打开'}).click()]);
    await expect(outside.locator('.canvas')).toBeVisible();
    await expect(outside.locator('.foot')).toContainText('omino 0.5.6');
    await outside.close();
    await page.getByRole('tab',{name:'知识库'}).click();
    await expect(page).toHaveURL(/tab=wiki/);
    await page.goBack();
    await page.reload();
    await expect(page.getByRole('tab',{name:/归档.*3/})).toHaveAttribute('aria-selected','true');
    await expect(frame.locator('.canvas')).toBeVisible();
    await page.goto('/library?project=todo-multi&tab=plan');
    await expect(page.getByRole('tab',{name:/归档.*3/})).toBeVisible();
    await expect(page.getByRole('link',{name:'打开 原型验证',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'打开 个人 Todo App',exact:true}).click();
    await expect(frame.locator('.canvas')).toBeVisible();
    await page.getByRole('link',{name:'返回文件列表'}).click();
    await expect(page.getByRole('link',{name:'打开 原型验证',exact:true})).toBeVisible();
    await page.goto('/library?project=todo-empty&tab=plan');
    await expect(page.getByText('这个项目还没有归档文件。')).toBeVisible();
    await page.goto(single+'&tab=plan');
    await expect(page.getByRole('tab',{name:/归档.*3/})).toHaveAttribute('aria-selected','true');
    await expect(frame.locator('.canvas')).toBeVisible();
    const handbook = '<!doctype html><html lang="zh"><title>操作手册</title><h1>如何归档待办</h1></html>';
    await mkdir(join(todo, 'docs'));
    await writeFile(join(todo, 'docs', 'handbook.html'), handbook);
    await togglePlugin(request, true, handbookEntry);
    try {
      await page.reload();
      const handbookTab = page.getByRole('tab', { name: '手册', exact: true });
      await expect(handbookTab).toBeVisible();
      await expect(page.getByRole('tab', { name: /归档.*3/ })).toBeVisible();
      await handbookTab.click();
      await expect(page).toHaveURL(/tab=handbook/);
      await expect(page.frameLocator('iframe').getByRole('heading', { name: '如何归档待办' })).toBeVisible();
      const file = await request.get(await page.locator('iframe').getAttribute('src') ?? '');
      expect(await file.text()).toBe(handbook);
      expect(file.headers()['content-security-policy']).toContain("connect-src 'none'");
      await page.getByRole('tab', { name: /归档.*3/ }).click();
      await expect(frame.locator('.canvas')).toBeVisible();
    } finally { await togglePlugin(request, false, handbookEntry); }
    await page.reload();
    await expect(page.getByRole('tab',{name:/归档.*3/})).toBeVisible();
    await writeFile(join(planDir,'summary.json'),JSON.stringify({...summary,waiting:[]}));
    await expect(page.getByRole('tab',{name:'归档',exact:true})).toBeVisible({timeout:17_000});
    await setAppearanceMode(page,'dark');
    await page.setViewportSize({width:390,height:844});
    await expect(frame.locator('.canvas')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('library-tabs-narrow-dark.png'),animations:'disabled'});
  } finally {
    await togglePlugin(request,false);
    if (restoreEnabled) {
      const current: MarketSourceSnapshot = await (await request.get('/api/market/sources')).json();
      await setEnabled(current.revision, restoreEnabled);
    }
  }
});

test('Wiki feature and unfeature reorder only the current scope',async({page,request})=>{
  const {directory}=await (await request.post('/__test__/execution-directory')).json();
  await project(request,'todo-wiki','待办手册',[directory]);
  const titles=['录入规则','归档说明','交付流程'];
  const documentTitle='本周交付简报';

  for (const [kind,title] of [...titles.map(title=>['wiki',title]), ['document',documentTitle]]) {
    const upload = await request.post('/api/v2/assets/uploads?name=handbook.md', { data: title });
    expect(upload.ok()).toBe(true);
    const { submissionId } = await upload.json();
    const imported = await request.post('/api/v2/assets/imports', {
      headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind, title, submissionId },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const { asset } = await imported.json();
    const bound = await request.post('/api/v2/assets/' + asset.id + '/bindings', {
      data: { ownerType:'project', ownerId:'todo-wiki', versionPolicy:'latest' },
    });
    expect(bound.ok(), await bound.text()).toBe(true);
  }
  await page.goto('/library?project=todo-wiki');
  const document=page.getByRole('link',{name:documentTitle,exact:true});
  await expect(document).toBeVisible();
  await page.getByRole('tab',{name:'知识库',exact:true}).click();
  await expect(document).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'资料类型',exact:true})).toHaveCount(0);
  const list=page.locator('.library-resource-row');
  await expect(list).toHaveCount(3);
  const order=await list.locator('a strong').allTextContents();
  const [first,second,last]=order;
  const feature=async (name:string,action:string)=>{
    await list.filter({has:page.getByRole('link',{name,exact:true})}).getByRole('button',{name:'更多操作 · '+name}).click();
    await page.getByRole('menuitem',{name:action,exact:true}).click();
  };
  await feature(last,'置顶');await expect(list.first()).toContainText(last);
  await feature(second,'置顶');await expect(list.locator('a strong')).toHaveText([second,last,first]);
  await page.reload();await expect(list.locator('a strong')).toHaveText([second,last,first]);
  await feature(second,'取消置顶');await expect(list.first()).toContainText(last);
  await feature(last,'取消置顶');await expect(list.locator('a strong')).toHaveText(order);
});
