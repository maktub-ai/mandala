import { expect, type Page } from "@playwright/test";

export async function openSidebar(page: Page) {
  await expect(page.locator("aside.sidebar")).toBeAttached();
  if (!await page.locator("aside.sidebar").isVisible()) await page.getByRole("button", { name: /^(会话列表|Chat list|打开侧栏|Open sidebar|展开侧栏|Expand sidebar)$/, exact: true }).click();
}

export async function openNavigation(page: Page) {
  await openSidebar(page);
  const navigation = page.getByRole("navigation", { name: /^(主导航|Main navigation)$/, exact: true });
  await expect(navigation).toBeVisible();
  return navigation;
}

export async function openArea(page: Page, name: string | RegExp) {
  const aliases = {
    chat: ["对话", "Chat", "Chats", "最近对话", "Recent chats"],
    tasks: ["进度", "Progress", "任务", "Tasks", "任务总览", "Task overview"],
    projects: ["项目", "Project", "Projects", "管理项目", "Manage projects"],
    agents: ["团队", "Team", "智能体", "Agent", "Agents", "Agent 与能力", "Agents and capabilities"],
    assets: ["文件", "Files", "最近文件", "Recent files", "资料", "Materials", "资产库", "Assets", "全部资料", "All assets", "资料库", "Library"],
    mana: ["MANA 工作区", "MANA workspace"],
    settings: ["设置", "Settings", "设置与连接", "Settings and connections"],
  };
  const area = Object.entries(aliases).find(([, values]) => values.some(value => typeof name === "string" ? value === name : name.test(value)))?.[0];
  if (!area) throw new Error("Unknown navigation area: " + name);
  const navigation = await openNavigation(page);
  if (area === "chat") {
    const library = page.locator("#navigation-chat");
    await library.getByRole("searchbox").fill("");
    const draft = library.locator(".library-draft");
    if (await draft.count()) await draft.click();
    else {
      const selected = await page.evaluate(() => localStorage.getItem("mana-chat"));
      if (selected) await library.locator(`.library-open[aria-describedby^="library-context-${selected} "]`).click();
      else await page.locator("aside.sidebar .sidebar-start .new-chat").click();
    }
  } else {
    const destination = area === "mana" ? "memory" : area === "assets" ? "library" : area;
    const pinned = navigation.locator(`.sidebar-primary-navigation [data-area="${destination}"]`);
    if (await pinned.isVisible()) await pinned.click();
    else {
      const menu = area === "settings" ? await openUserMenu(page) : await openModuleMenu(page);
      await menu.locator(`[data-area="${destination}"]`).click();
    }
  }
  await expect(page.locator("nav[data-active-area]")).toHaveAttribute("data-active-area", area);
  if (area === 'agents' || area === 'projects') {
    await expect(page).toHaveURL(url => url.pathname === '/' + area && !url.searchParams.has('agent'));
    await expect(page.locator('.workspace-directory')).toBeVisible();
  }
}

export async function conversationMenu(page: Page, title: string) {
  const row = page.locator(".library-item").filter({ has: page.getByRole("button", { name: title, exact: true }) });
  await row.hover();
  await row.getByRole("button", { name: `更多操作 · ${title}`, exact: true }).click();
  return page.getByRole("menu", { name: `对话操作 · ${title}`, exact: true });
}

export async function openConfigSection(page: Page, section: "projects" | "agents" | "mcp" | "skills" | "general") {
 if(section === 'projects' || section === 'agents') {
  await openArea(page, section === 'projects' ? '项目' : '智能体');
  const first=page.locator('.workspace-directory-row').first();
  if(await first.count()) {
   if(section === 'agents') await pickDirectoryAgent(page);
   else await pickDirectoryProject(page);
  }
  return;
 }
 if(section === 'skills') {
  // Skills is an existing settings deep link, independent of either directory.
  await page.evaluate(()=>{history.pushState(null,'','/mana/skills');dispatchEvent(new PopStateEvent('popstate'));});
  await expect(page).toHaveURL(/\/mana\/skills$/);return;
 }
 await openArea(page, '设置');
 if(section === 'mcp') await page.getByRole('link',{name:/^(MCP 连接|MCP connections)$/,exact:true}).click();
}
export async function openProject(page: Page,id: string) {
 await openArea(page,'项目');
 await page.locator('.workspace-directory-row[href="/projects/'+encodeURIComponent(id)+'/overview"]').click();
 await expect(page).toHaveURL(new RegExp('/projects/'+id+'/overview$'));
}

export async function openProjectBackground(page:Page) {
 const field=page.getByRole('textbox',{name:/^(项目名称|Project name)$/,exact:true});
 if(await field.isVisible()) return;
 await page.getByRole('tab',{name:/^(背景|Background|Context)$/,exact:true}).click();
 await expect(field).toBeVisible();
}

export async function openTeamDirectory(page: Page) {
 if(!await page.locator('.workspace-directory').isVisible() || new URL(page.url()).pathname!=='/projects')await openArea(page,'项目');
 await expect(page.locator('.workspace-directory')).toBeVisible();
}
export async function editAgentProfile(page:Page) {
 const field=page.getByRole('textbox',{name:/^(智能体 名称|Agent name)$/,exact:true});
 if(await field.isVisible())return;
 const overview=page.getByRole('tab',{name:/^(概览|Overview)$/,exact:true});
 if(await overview.isVisible())await overview.click();
 await page.locator('.agent-overview').getByRole('button',{name:/^(编辑|Edit)$/,exact:true}).click();
 await expect(field).toBeVisible();
}
export async function pickDirectoryAgent(page:Page,id?:string,tab?:string) {
 if(!await page.locator('.workspace-directory').isVisible() || new URL(page.url()).pathname!=='/agents')await openArea(page,'智能体');
 const target=id?page.locator('.workspace-directory-row[href="/agents/'+encodeURIComponent(id)+'"]'):page.locator('.workspace-directory-row').first();
 await target.click();await expect(page.locator('.agent-overview')).toBeVisible();
 if(tab)await page.getByRole('tab',{name:tab==='执行'?/^(执行|Execution)$/:tab,exact:true}).click();
 else await editAgentProfile(page);
}
export async function pickDirectoryProject(page:Page,id?:string,tab='背景') {
 await openTeamDirectory(page);
 const target=id?page.locator('.workspace-directory-row[href="/projects/'+encodeURIComponent(id)+'/overview"]'):page.locator('.workspace-directory-row').first();
 await target.click();
 await page.getByRole('button',{name:/^(项目设置|Project settings)$/,exact:true}).click();
 await page.getByRole('tab',{name:['概览','背景','Background','Context'].includes(tab)?/^(背景|Background|Context)$/:tab==='参与者'?/^(参与者|Participants)$/:tab==='资源'?/^(资源|Resources)$/:tab,exact:true}).click();
}
export async function openProjectOverview(page:Page) {
 const url=new URL(page.url()),id=url.pathname.match(/^\/projects\/([^/]+)\//)?.[1]??url.searchParams.get('project');
 if(!id)throw new Error('Select a project before opening its summary');
 await page.evaluate(path=>{history.pushState(null,'',path);dispatchEvent(new PopStateEvent('popstate'));},'/projects/'+id+'/overview');
 await expect(page.locator('.project-workbench')).toBeVisible();
}

export async function openUserMenu(page: Page) {
  await openSidebar(page);
  const menu = page.getByRole('menu', { name: /^(用户菜单|User menu)$/, exact: true });
  if (!await menu.isVisible()) await page.getByRole('button', { name: /^(用户菜单|User menu)$/, exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}
export async function openModuleMenu(page: Page) {
  return openUserMenu(page);
}
export async function openAccountConnection(page: Page) {
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitem', { name: /^(账号|Account)( · .*)?$/ }).click();
}

export async function setAppearanceMode(page: Page, mode: 'light' | 'dark') {
  // Use the real settings and cross-tab synchronization without losing the current page state.
  const settings = await page.context().newPage();
  try {
    await settings.goto(new URL('/settings/general', page.url()).href);
    await settings.getByRole('button', { name: mode === 'dark' ? /^(深色|Dark)$/ : /^(浅色|Light)$/, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await expect(page.locator('body')).toHaveCSS('background-color', mode === 'dark' ? 'rgb(25, 25, 28)' : 'rgb(252, 252, 252)');
  } finally { await settings.close(); }
}

// A chat's context (workspace, tasks, sources, capabilities) lives in the popover at the chat bar's top-right.
export async function openChatContext(page: Page) {
  const popover = page.getByRole('dialog', { name: /^(对话上下文|Chat context)$/ });
  if (!await popover.isVisible()) await page.getByRole('button', { name: /^(对话上下文|Chat context)$/ }).click();
  await expect(popover).toBeVisible();
  return popover;
}
