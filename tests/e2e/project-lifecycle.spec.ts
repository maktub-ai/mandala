import {pickDirectoryProject, openTeamDirectory} from './helpers/navigation';
import {waitForAutosave} from './helpers/settings';
import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`project creation requires a name and project actions work from every section at ${width}px`, async ({ page, request }) => {
    const { revision } = await (await request.get("/api/config")).json();
    const agent = { id: "lifecycle-agent", name: "Shared editor", instructions: "", defaultCli: "codex", models: {}, mcp: [], skills: [] };
    const original = { id: "lifecycle-project", name: "Existing project", cwd: "/tmp", agentIds: [agent.id], resources: [], mcp: [], skills: [] };
    expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects: [original], agents: [agent] } } })).ok()).toBe(true);
    const baseline = (await (await request.get("/api/config")).json()).config;
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/projects/manage");
    await pickDirectoryProject(page, "lifecycle-project", "背景");
    await page.getByRole("tab", { name: "资源", exact: true }).click();
    await page.getByRole("link",{name:"返回项目",exact:true}).click();
    await expect(page.locator('.workspace-directory')).toBeVisible();
    await openTeamDirectory(page);
    await page.locator(".workspace-directory").getByRole("searchbox").fill("no match");
    await page.locator(".workspace-directory").getByRole("button", { name: "添加项目", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "项目名称", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "项目名称", exact: true })).toBeFocused();
    await expect(page.locator("aside.sidebar").getByRole("button", { name: "未命名项目", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("   ");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("项目名称不能为空");
    await page.getByRole("button", { name: "取消新增项目", exact: true }).click();
    expect((await (await request.get("/api/config")).json()).config.projects).toEqual(baseline.projects);
    await openTeamDirectory(page);
    await page.getByRole("button", { name: "添加项目", exact: true }).click();
    await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("Named project");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(page.getByRole("tab", { name: "背景", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("textbox", { name: "项目名称", exact: true })).toHaveValue("Named project");
    await waitForAutosave(page);
    await expect.poll(async () => (await (await request.get("/api/config")).json()).config.projects.length).toBe(2);
    const created = (await (await request.get("/api/config")).json()).config.projects.find((p: { name: string }) => p.name === "Named project");
    const chat = await (await request.post("/api/conversations", { data: { projectId: created.id, cli: "codex" } })).json();
    await page.getByRole("tab", { name: "资源", exact: true }).click();
    await page.getByRole("button", { name: "项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "重命名项目", exact: true });
    await rename.getByRole("textbox", { name: "新项目名称", exact: true }).fill("Renamed project");
    await rename.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(rename).toHaveCount(0);
    await waitForAutosave(page);
    await expect.poll(async () => (await (await request.get("/api/config")).json()).config.projects.find((p: { id: string }) => p.id === created.id)?.name).toBe("Renamed project");
    for (const confirm of [false, true]) {
      await page.getByRole("button", { name: "项目操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "删除项目", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "确认删除项目", exact: true });
      await expect(dialog).toContainText("Renamed project");
      await expect(dialog).toContainText("历史对话");
      await dialog.getByRole("button", { name: confirm ? "删除项目" : "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      if (!confirm) await expect(page.getByRole("button", { name: "项目操作", exact: true })).toBeVisible();
    }
    await waitForAutosave(page);
    await expect.poll(async () => (await (await request.get("/api/config")).json()).config.projects.length).toBe(1);
    const config = (await (await request.get("/api/config")).json()).config;
    expect(config.projects).toEqual(baseline.projects);
    expect(config.agents).toEqual(baseline.agents);
    expect((await request.get(`/api/conversations/${chat.id}`)).ok()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("project actions support keyboard, English and deleting the last project", async ({ page, request }) => {
  const { revision } = await (await request.get("/api/config")).json();
  expect((await request.put("/api/config", { data: { revision, config: { version: 2, projects: [{ id: "last-project", name: "Last project", cwd: "/tmp", agentIds: [], resources: [], mcp: [], skills: [] }], agents: [] } } })).ok()).toBe(true);
  await page.addInitScript(() => localStorage.setItem("mana-language", "en"));
  await page.goto("/projects/manage?project=last-project");
  const trigger = page.getByRole("button", { name: "Project actions", exact: true });
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Rename project", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Delete project", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Rename project", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename project", exact: true });
  await expect(rename.getByRole("textbox", { name: "New project name", exact: true })).toBeFocused();
  await rename.getByRole("textbox", { name: "New project name", exact: true }).fill("   ");
  await rename.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(rename.getByRole("alert")).toContainText("Project name is required");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Delete project", exact: true }).click();
  await page.getByRole("dialog", { name: "Confirm project deletion", exact: true }).getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(page.locator("main").getByRole("link",{name:"Last project",exact:true})).toHaveCount(0);
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get("/api/config")).json()).config.projects).toEqual([]);
  await expect(page.getByRole("button", { name: "Add project", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Project name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel new project", exact: true }).click();
  expect((await (await request.get("/api/config")).json()).config.projects).toEqual([]);
});

for (const width of [1280, 390]) test(`a delayed return-to-team refresh cannot dismiss a newer project creation draft at ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 844 });
  const { revision } = await (await request.get('/api/config')).json();
  const config = { version: 2, agents: [], projects: [{ id: 'creation-race', name: 'Existing project', cwd: '', agentIds: [], resources: [], mcp: [], skills: [] }] };
  expect((await request.put('/api/config', { data: { revision, config } })).ok()).toBe(true);
  const baseline = (await (await request.get('/api/config')).json()).config.projects;
  await page.goto('/projects/manage?project=creation-race');
  await expect(page.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('Existing project');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'GET') { entered(); await gate; }
    await route.continue();
  });
  try {
    await page.getByRole('link', { name: '返回项目', exact: true }).click();
    await started;
    await page.evaluate(()=>{history.pushState(null,'','/projects');dispatchEvent(new PopStateEvent('popstate'));});
    await expect(page.locator('.workspace-directory')).toBeVisible();
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    const draft = page.getByRole('region', { name: '新建项目', exact: true });
    await draft.getByRole('textbox', { name: '项目名称', exact: true }).fill('Keep new project preparation');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'GET');
    release();await (await refreshed).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(draft.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('Keep new project preparation');
    await expect(page).toHaveURL(/\/projects$/);
    expect((await (await request.get('/api/config')).json()).config.projects).toEqual(baseline);
  } finally { release(); }
});
