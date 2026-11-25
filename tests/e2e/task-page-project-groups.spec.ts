import { expect } from '@playwright/test';
import { test } from './helpers/isolated-authority';
import { chooseOption } from './helpers/select';

test('Tasks navigation groups the same filtered tasks by project and restores the view after opening a task', async ({ page, isolatedAuthority }) => {
  const { request, baseURL } = isolatedAuthority;
  const projects = [
    { id: 'grouping-editor', name: '离线编辑器' },
    { id: 'grouping-sync', name: '同步引擎' },
  ];
  const { config, revision } = await (await request.get('/api/config')).json();
  const agent = { id: 'editor-reviewer', name: '编辑审阅员', defaultCli: 'codex', models: {}, instructions: '', skills: [], mcp: [] };
  config.agents.push(agent);
  for (const project of projects) {
    const directory = await request.post('/__test__/execution-directory');
    expect(directory.ok()).toBe(true);
    config.projects.push({ ...project, cwd: (await directory.json()).directory, agentIds: [agent.id], resources: [], skills: [], mcp: [] });
  }
  expect((await request.put('/api/config', { data: { config, revision } })).ok()).toBe(true);
  const cases = [
    { goal: '验证跨项目的合并流程', assigneeAgentId: agent.id, projectIds: projects.map(p => p.id) },
    { goal: '核对离线草稿', projectIds: [projects[0].id] },
    { goal: '编写安装说明', projectId: projects[1].id, projectIds: [] },
  ];
  const taskIds: string[] = [];
  for (const data of cases) {
    const response = await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    const task = await response.json();
    taskIds.push(task.id);
    if (data.goal === cases[1].goal) {
      const moved = await request.post('/api/v2/tasks/' + task.id + '/move', {
        headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { expectedRevision: task.revision, state: 'running' },
      });
      expect(moved.ok(), await moved.text()).toBe(true);
    }
  }

  await page.addInitScript(() => localStorage.setItem('mana-language', 'zh-CN'));
  await page.goto(baseURL);
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '任务', exact: true }).click();
  await expect(page).toHaveURL(baseURL + '/tasks');
  const main = page.getByRole('main');
  const taskLink = (index: number) => main.getByRole('link', { name: cases[index].goal, exact: true });
  const todo = main.getByRole('region', { name: '待办', exact: true });
  for (const i of [0, 2]) await expect(todo.getByRole('link', { name: cases[i].goal, exact: true })).toBeVisible();
  await expect(main.getByRole('region', { name: '进行中', exact: true }).getByRole('link', { name: cases[1].goal })).toBeVisible();

  const grouping = main.getByRole('radiogroup', { name: '任务分组', exact: true });
  const byProject = grouping.getByRole('radio', { name: '按项目', exact: true });
  const byStatus = grouping.getByRole('radio', { name: '按状态', exact: true });
  await expect(byProject).toBeVisible();
  await expect(byStatus).toBeChecked();
  await grouping.getByRole('radio', { name: '按 Agent', exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('group') === 'agent');
  await expect(main.getByRole('region', { name: agent.name, exact: true }).getByRole('link', { name: cases[0].goal })).toBeVisible();
  await expect(taskLink(0)).toHaveCount(1);
  await byProject.click();
  await expect(byProject).toBeChecked();
  await expect(page).toHaveURL(url => url.searchParams.get('group') === 'project');
  const [editor, sync, unassigned] = [...projects.map(p => p.name), '无项目'].map(name => main.getByRole('region', { name, exact: true }));
  for (const group of [editor, sync]) await expect(group.getByRole('link', { name: cases[0].goal, exact: true })).toBeVisible();
  await expect(editor.getByRole('link', { name: cases[1].goal, exact: true })).toBeVisible();
  await expect(unassigned.getByRole('link', { name: cases[2].goal, exact: true })).toBeVisible();
  for (const [index, count] of [2, 1, 1].entries()) await expect(taskLink(index)).toHaveCount(count);

  for (const view of ['看板', '列表']) {
    const toggle = main.getByRole('button', { name: view, exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(byProject).toBeChecked();
    await expect(unassigned.getByRole('link', { name: cases[2].goal, exact: true })).toBeVisible();
    await expect(taskLink(0)).toHaveCount(2);
  }
  const openProject = sync.getByRole('link', { name: '打开项目', exact: true });
  await openProject.click();
  await expect(page).toHaveURL(url => url.pathname === '/projects/' + projects[1].id + '/overview');
  await page.goBack();
  await expect(byProject).toBeChecked();
  await main.getByRole('button', { name: '筛选', exact: true }).click();
  await chooseOption(page, '任务状态', 'waiting');
  await expect(main.getByRole('heading', { name: '当前筛选下没有任务' })).toBeVisible();
  await chooseOption(page, '任务状态', 'active');
  await expect(taskLink(0)).toHaveCount(2);
  const search = main.getByRole('searchbox', { name: '搜索任务' });
  await search.fill('合并流程');
  await expect(taskLink(0)).toHaveCount(2);
  await expect(taskLink(1)).toHaveCount(0);
  await expect(taskLink(2)).toHaveCount(0);
  await sync.getByRole('link', { name: cases[0].goal, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/tasks/' + taskIds[0]);
  await expect(page.getByRole('dialog', { name: '任务详情' }).getByRole('heading', { name: cases[0].goal, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(url => url.pathname === '/tasks' && url.searchParams.get('q') === '合并流程');
  await expect(byProject).toBeChecked();
  await expect(search).toHaveValue('合并流程');
  await expect(taskLink(0)).toHaveCount(2);
  await byStatus.click();
  await expect(page).toHaveURL(url => !url.searchParams.has('group'));
  await expect(todo.getByRole('link', { name: cases[0].goal, exact: true })).toBeVisible();
  await expect(taskLink(0)).toHaveCount(1);
  await search.fill('');
  for (const i of [0, 2]) await expect(todo.getByRole('link', { name: cases[i].goal, exact: true })).toBeVisible();
  await expect(main.getByRole('region', { name: '进行中', exact: true }).getByRole('link', { name: cases[1].goal })).toBeVisible();
});
