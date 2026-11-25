import { storedUiState } from './helpers/preferences';
import { openProject } from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { openSidebar, openArea } from './helpers/navigation';
import { chooseOption } from './helpers/select';

async function openProjects(page:import('@playwright/test').Page){await openSidebar(page);await page.locator('.sidebar-primary-navigation [data-area=projects]').click();await expect(page).toHaveURL(url=>url.pathname==='/projects');}

async function editBackground(page:import('@playwright/test').Page) {
 await page.getByRole('region',{name:'项目背景',exact:true}).getByRole('button',{name:'编辑',exact:true}).click();
 return page.getByRole('textbox',{name:'项目背景',exact:true});
}

async function resumeProjectForm(page:import('@playwright/test').Page) {
 await openProjects(page);
 await page.getByRole('button',{name:'添加项目',exact:true}).click();
}

async function fixture(request: APIRequestContext) {
  const suffix = crypto.randomUUID();
  const ids = { a: 'nav-a-' + suffix, b: 'nav-b-' + suffix, agent: 'nav-agent-' + suffix, other: 'nav-other-' + suffix };
  const { config:current, revision } = await (await request.get('/api/config')).json();
  const config = { ...current, version: 2, projects: [ids.a, ids.b].map((id, index) => ({ id, name: index ? 'Second project' : 'First project', cwd: '', agentIds: [ids.agent], resources: [], mcp: [], skills: [] })), agents: [...current.agents.filter((agent:any)=>agent.systemRole),...[ids.agent, ids.other].map((id, index) => ({ id, name: index ? 'Second Agent' : 'First Agent', defaultCli: 'codex', models: {}, instructions: '', mcp: [], skills: [] }))] };
  expect((await request.put('/api/config', { data: { revision, config } })).ok()).toBe(true);
  // Each chat requests a new managed directory; no shared runtime claims.
  const chats = [];
  for (const [projectId, title] of [[ids.a, 'First synthetic chat'], [ids.b, 'Second synthetic chat']]) {
    const response = await request.post('/api/conversations', { data: { projectId, agentId: ids.agent, workspaceId: null, cli: 'codex' } });
    expect(response.ok()).toBe(true);
    const chat = await response.json();
    expect((await request.patch('/api/conversations/' + chat.id, { data: { title } })).ok()).toBe(true);
    chats.push(chat);
  }
  return { ...ids, chats };
}

for (const locale of ['zh-CN', 'en-US']) for (const width of [1280, 390]) {
  test.describe(`${locale} ${width}px`, () => {
    test.use({ locale, storageState: storedUiState(locale.startsWith("zh") ? "zh-CN" : "en"), viewport: { width, height: 844 } });
    test('permanent library keeps current chat draft and state without category disclosures', async ({ page, request }) => {
      const f = await fixture(request), zh = locale === 'zh-CN';
      const url = '/?project=' + f.a + '&conversation=' + f.chats[0].id;
      await page.goto(url);
      const message = page.getByRole('textbox', { name: zh ? '消息' : 'Message', exact: true });
      await message.fill('Keep this unsent draft');
      const before = await (await request.get('/api/conversations')).json();
      await openSidebar(page);
      await expect(page.locator('aside.sidebar').getByRole('button', { name: zh ? '最近对话' : 'Recent chats', exact: true })).toHaveCount(0);
      await expect(page.locator('aside.sidebar .workspace-navigation').getByRole('button', { name: zh ? '用户菜单' : 'User menu', exact: true })).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('aside.sidebar .workspace-navigation .sidebar-destination')).toHaveCount(4);
      await expect(message).toHaveValue('Keep this unsent draft');
      const library = page.locator('#navigation-chat .conversation-library');
      await chooseOption(page, library.getByRole('combobox', { name: zh ? '会话视图' : 'Chat view', exact: true }), 'projects');
      await library.getByRole('searchbox').fill('First synthetic chat');
      await expect(library.getByRole('region', { name: 'First project', exact: true })).toBeVisible();
      await library.getByRole('region', { name: 'First project', exact: true }).getByRole('button', { name: 'First synthetic chat', exact: true }).click();
      await expect(message).toHaveValue('Keep this unsent draft');
      if (width === 390) await expect(page.locator('aside.sidebar')).not.toBeVisible();
      expect(await (await request.get('/api/conversations')).json()).toEqual(before);
      await expect(page.getByRole('combobox', { name: zh ? '当前项目' : 'Current project', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test('project links have stable order, retain drafts and restore exact settings object through history', async ({ page, request }) => {
 const f=await fixture(request);
 await page.goto('/projects');
 await expect(page.locator('.workspace-directory-row strong')).toHaveText(['First project','Second project']);
 await openProject(page,f.b);
 await (await editBackground(page)).fill('Keep project draft');
 await openProject(page,f.a);
 await expect(page.getByRole('heading',{name:'First project',exact:true})).toBeVisible();
 await openProject(page,f.b);
 await expect(page.getByText('Keep project draft',{exact:true})).toBeVisible();
 const nav=page.getByRole('navigation',{name:'项目导航',exact:true});
 await nav.getByRole('link',{name:'设置',exact:true}).click();
 const name=page.getByRole('textbox',{name:'项目名称',exact:true});
 await expect(name).toHaveValue('Second project');
 await page.goBack();await expect(page).toHaveURL('/projects/'+f.b+'/overview');
 await page.goForward();await expect(name).toHaveValue('Second project');
 await page.reload();await expect(name).toHaveValue('Second project');
 await nav.getByRole('link',{name:'概览',exact:true}).click();
 await expect(page.getByText('Keep project draft',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:/关联任务/}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/tasks'&&url.searchParams.get('project')===f.b);
 await page.goBack();await nav.getByRole('link',{name:'资料库',exact:true}).click();
 await expect(page).toHaveURL('/projects/'+f.b+'/library');
 await page.goto('/mana?tab=memory&project='+f.b);await page.reload();
 await expect(page.locator('main')).toContainText('Second project');
});

test('Agent links restore identity and content owns its local leaves without duplicate current pages', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/agents?agent=' + f.other);
  await expect(page.getByRole('heading',{name:'Second Agent',exact:true})).toBeVisible();
  await page.locator('main .object-location').getByRole('link',{name:'智能体',exact:true}).click();await expect(page).toHaveURL(/\/agents$/);
  await page.locator('.workspace-directory-row[href="/agents/'+f.agent+'"]').click();
  await expect(page).toHaveURL(new RegExp('/agents/' + f.agent + '$'));
  await page.goBack();await expect(page).toHaveURL(/\/agents$/);await expect(page.locator('.workspace-directory')).toBeVisible();
  await page.goBack();await expect(page).toHaveURL(new RegExp('/agents\\?agent=' + f.other + '$'));
  await expect(page.getByRole('heading',{name:'Second Agent',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Second Agent',exact:true})).toBeVisible();
  await expect(page.locator('aside.sidebar [aria-current=page]')).toHaveCount(1);
  await expect(page.getByText('更多资源', { exact: true })).toHaveCount(0);
  await page.goto('/settings/mcp');
  await expect(page.locator('main .content-navigation').getByRole('link', { name: 'MCP 连接', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('aside.sidebar [aria-current=page]')).toHaveCount(1);
  await page.goto('/mana?tab=memory');
  await expect(page.getByRole('button',{name:'用户菜单',exact:true})).toHaveAttribute('aria-current','page');
  const seeded=await request.post('/api/knowledge',{data:{kind:'memory',title:'Synthetic correction navigation',content:'Synthetic note',scope:'global',status:'active',level:'L1'}});expect(seeded.ok()).toBe(true);
  await page.reload();await page.getByRole('article',{name:'Synthetic correction navigation',exact:true}).getByRole('button',{name:'纠正',exact:true}).click();
  await page.getByRole('textbox',{name:'纠正内容',exact:true}).fill('Locked correction draft');
  await expect(page.locator('aside.sidebar .workspace-navigation').getByRole('link', { name: '任务', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.locator('aside.sidebar .workspace-navigation').getByRole('link', { name: '任务', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/mana\?tab=memory$/);
  await expect(page.getByRole('textbox',{name:'纠正内容',exact:true})).toHaveValue('Locked correction draft');
});

test('unsent preparation draft is a real return destination from another area', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/?project=' + f.b + '&agent=' + f.agent);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('Keep preparation draft');
  await chooseOption(page, page.getByRole('combobox', { name: '会话视图', exact: true }), 'projects');
  await openArea(page, '资产库');
  await page.locator('#navigation-chat .library-draft').click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('Keep preparation draft');
  await expect(page).toHaveURL(new RegExp('/\\?project=' + f.b + '&agent=' + f.agent + '$'));
  await expect(page.locator('.topbar').getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('.chat-setup').getByRole('combobox', { name: '当前项目', exact: true })).toBeVisible();
});

test('Skill draft destination keeps its existing draft editor distinct from available capabilities', async ({ page }) => {
  await page.goto('/mana?tab=skill');
  await expect(page.getByText('这里保存 Skill 草稿，不等于原生 CLI 已加载。', { exact: true })).toBeVisible();
  await expect(page.locator('main .content-navigation').getByRole('link', { name: 'Skill 草稿', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '新增 Skill 草稿', exact: true }).click();
  await page.getByRole('textbox', { name: '资料标题', exact: true }).fill('Unsent Skill draft');
  await expect(page.locator('aside.sidebar .new-chat')).toBeDisabled();
});

test('new project preparation survives category switches and explicit creation persists across objects',async({page,request})=>{
 const f=await fixture(request);await page.goto('/projects');await page.getByRole('button',{name:'添加项目',exact:true}).click();const name=page.getByRole('textbox',{name:'项目名称',exact:true});await name.fill('Prepared new project');await openArea(page,'设置');await resumeProjectForm(page);await expect(name).toHaveValue('Prepared new project');await page.getByRole('button',{name:'取消新增项目',exact:true}).click();expect((await(await request.get('/api/config')).json()).config.projects).toHaveLength(2);
 await page.getByRole('button',{name:'添加项目',exact:true}).click();await expect(name).toHaveValue('');await name.fill('Prepared new project');await page.getByRole('button',{name:'创建项目',exact:true}).click();await waitForAutosave(page);const config=(await(await request.get('/api/config')).json()).config,created=config.projects.find((p:{name:string})=>p.name==='Prepared new project');expect(config.projects).toHaveLength(3);expect(created.id).not.toBe(f.a);expect(created.id).not.toBe(f.b);await openProject(page,f.b);await openProject(page,created.id);const createdTitle=page.getByRole('heading',{name:'Prepared new project',exact:true});await expect(createdTitle).toBeVisible();await page.reload();await expect(createdTitle).toBeVisible();await openProjects(page);await page.getByRole('button',{name:'添加项目',exact:true}).click();await expect(name).toHaveValue('');await page.getByRole('button',{name:'取消新增项目',exact:true}).click();await openProject(page,created.id);await page.getByRole('button',{name:'对象操作',exact:true}).click();await page.getByRole('menuitem',{name:'删除项目',exact:true}).click();await page.getByRole('dialog',{name:'确认删除',exact:true}).getByRole('button',{name:'删除项目',exact:true}).click();await waitForAutosave(page);expect((await(await request.get('/api/config')).json()).config.projects.map((p:{id:string})=>p.id)).toEqual([f.a,f.b]);
});

test('scoped Skill draft links highlight the Settings destination and legacy document routes mark the asset leaf', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/mana?tab=skill&project=' + f.a);
  await expect(page.getByRole('heading',{name:'Skill 草稿',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'用户菜单',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('main .content-navigation').getByRole('link', { name: 'Skill 草稿', exact: true })).toHaveCount(0);
  await expect(page.locator('aside.sidebar .workspace-navigation').getByRole('link', { name: '智能体', exact: true })).toBeVisible();
  await page.goto('/mana?tab=document');
  await expect(page.locator('main .content-navigation')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'资料库',exact:true})).toBeVisible();
});

test('cancelling an unsaved Agent restores the selected remaining object URL', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/agents');
  await expect(page.locator('.workspace-directory')).toBeVisible();
  await page.getByRole('button', { name: '添加智能体', exact: true }).click();
  await page.getByRole('textbox', { name: '智能体 名称', exact: true }).fill('Accidental Agent');
  await page.getByRole('button', { name: '取消新增 智能体', exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);await page.reload();await expect(page.locator('.workspace-directory-row[href="/agents/'+f.agent+'"]')).toContainText('First Agent');expect((await(await request.get('/api/config')).json()).config.agents.filter((agent:any)=>!agent.systemRole).map((agent:any)=>agent.id)).toEqual([f.agent,f.other]);
});

test('generic directory entries expose explicit selection and retain shared edits', async ({page,request})=>{
 const f=await fixture(request);
 await page.goto('/projects/'+f.b+'/overview');
 await (await editBackground(page)).fill('Shared unsaved background');
 await openArea(page,'设置');await openArea(page,'Agent');
 await expect(page.locator('.workspace-directory')).toBeVisible();
 await openProject(page,f.b);
 await expect(page.getByText('Shared unsaved background',{exact:true})).toBeVisible();
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.projects[1].background).toBe('Shared unsaved background');
});

test('legacy automation route restores Schedules and allows abandoning creation',async({page,request})=>{
 await fixture(request);await page.goto('/mana?tab=automation');await expect(page).toHaveURL(/\/schedules$/);await expect(page.getByRole('heading',{name:'自动化',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'用户菜单',exact:true})).toHaveAttribute('aria-current','page');await openArea(page,'任务');await page.goBack();await expect(page).toHaveURL(/\/schedules$/);await page.getByRole('button',{name:'新建计划',exact:true}).click();const name=page.getByRole('textbox',{name:'计划名称',exact:true});await name.fill('Locked automation preparation');await expect(page.locator('aside.sidebar .workspace-navigation [data-area=tasks]')).toHaveAttribute('aria-disabled','true');await page.locator('aside.sidebar .workspace-navigation [data-area=tasks]').press('Enter');await expect(page).toHaveURL(/\/schedules$/);await expect(name).toHaveValue('Locked automation preparation');await page.getByRole('button',{name:'取消',exact:true}).click();await openArea(page,'任务');await expect(page).toHaveURL(/\/tasks$/);
});

test('unscoped directory history restores the list and preserves project preparation',async({page,request})=>{
 const f=await fixture(request);
 await page.goto('/agents');await page.locator('.workspace-directory-row[href="/agents/'+f.other+'"]').click();
 await page.goBack();await expect(page.locator('.workspace-directory')).toBeVisible();
 await page.reload();await expect(page.locator('.workspace-directory-row')).toHaveCount(2);await expect(page.locator('.workspace-directory-row[href="/agents/'+f.other+'"]')).toContainText('Second Agent');
 await openProject(page,f.b);await resumeProjectForm(page);
 const preparation=page.getByRole('region',{name:'新建项目',exact:true}).getByRole('textbox',{name:'项目名称',exact:true});
 await preparation.fill('History preparation');
 await openArea(page,'设置');await page.goBack();await expect(preparation).toHaveValue('History preparation');
 await page.goForward();await expect(page).toHaveURL(/\/settings\/general$/);
 await resumeProjectForm(page);await expect(preparation).toHaveValue('History preparation');
 expect((await(await request.get('/api/config')).json()).config.projects).toHaveLength(2);
});

test('default legacy Memory history restores content and local navigation through Back Forward and reload', async ({ page }) => {
  await page.goto('/mana');
  const memory = page.getByRole('button',{name:'用户菜单',exact:true});
  await expect(page.locator('main').getByRole('heading', { name: '记忆', exact: true })).toBeVisible();
  await expect(memory).toHaveAttribute('aria-current', 'page');
  await openArea(page,'设置');
  await expect(page.locator('main').getByRole('link', { name: '通用设置', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(/\/mana$/);
  await expect(page.locator('main').getByRole('heading', { name: '记忆', exact: true })).toBeVisible();
  await expect(memory).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('aside.sidebar .workspace-navigation [aria-current=page]')).toHaveCount(1);
  await expect(page.locator('main .content-navigation')).toHaveCount(0);
  await page.goForward();
  await page.reload();
  await expect(page.locator('main').getByRole('link', { name: '通用设置', exact: true })).toHaveAttribute('aria-current', 'page');
  await openArea(page, '设置');
  await page.goto('/mana?tab=skill');
  await page.getByRole('button', { name: '新增 Skill 草稿', exact: true }).click();
  await page.getByRole('textbox', { name: '资料标题', exact: true }).fill('Keep Skill editor state');
  const tasks = page.locator('aside.sidebar .workspace-navigation').getByRole('link', { name: '任务', exact: true });
  await expect(tasks).toHaveAttribute('aria-disabled', 'true');
  await tasks.press('Enter');
  await expect(page).toHaveURL(/\/mana\?tab=skill$/);
  await expect(page.getByRole('textbox', { name: '资料标题', exact: true })).toHaveValue('Keep Skill editor state');
});

for (const viaGeneral of [false, true]) test(`explicit same-ID project selection exits preparation and retains its name viaGeneral=${viaGeneral}`, async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/projects/'+f.a+'/overview');
  await (await editBackground(page)).fill('Keep original object edits');
  await openProjects(page);await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('Resume this project preparation');
  if (viaGeneral) { await openArea(page, '设置'); await resumeProjectForm(page); }
  await expect(page.getByRole('region',{name:'新建项目',exact:true})).toBeVisible();await page.getByRole('link',{name:'返回项目',exact:true}).click();
  await openProject(page,f.a);
  await expect(page.getByRole('heading',{name:'First project',exact:true})).toBeVisible();
  await expect(page.getByText('Keep original object edits',{exact:true})).toBeVisible();
  await openProjects(page);await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('Resume this project preparation');
  await openArea(page, '设置');
  await resumeProjectForm(page);
  await expect(page.getByRole('region',{name:'新建项目',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('Resume this project preparation');
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  const config = (await (await request.get('/api/config')).json()).config;
  expect(config.projects).toHaveLength(2);
  await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.projects[0].background).toBe('Keep original object edits');
});
