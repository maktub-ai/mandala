import { expect, test } from '@playwright/test';
import { chooseOption } from './helpers/select';

for (const populated of [false, true]) {
 test(`project files footer preserves ${populated ? 'populated' : 'empty'} project scope`, async ({ page, request }) => {
  const projectId = 'files-scope-' + (populated ? 'populated' : 'empty');
  const otherId = projectId + '-other';
  const { config, revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { ...config, projects: [...config.projects, ...[projectId, otherId].map(id => ({ id, name: id, cwd: '/tmp', agentIds: [], resources: [], mcp: [], skills: [] }))] } } })).ok()).toBe(true);
  let firstVersion = '';
  for (const id of populated ? [projectId, otherId] : [otherId]) {
   const stage = await (await request.post('/api/v2/assets/uploads?name=scope.md', { data: 'Synthetic scope ' + id })).json();
   const publication = await (await request.post('/api/v2/assets/imports', { headers: { 'Idempotency-Key': id }, data: { kind: 'document', title: 'File ' + id, submissionId: stage.submissionId } })).json();
   if (id === projectId) firstVersion = publication.version.id;
   expect((await request.post('/api/v2/assets/' + publication.asset.id + '/bindings', { data: { ownerType: 'project', ownerId: id, versionPolicy: 'latest' } })).ok()).toBe(true);
  }
  const overview = '/projects/' + projectId + '/library';
  const scoped = '/library?project=' + encodeURIComponent(projectId);
  await page.goto(overview);
  const footer = page.getByRole('link', { name: '打开资料库', exact: true });
  await expect(footer).toHaveAttribute('href', scoped);
  await footer.click();
  await expect(page).toHaveURL(scoped);
  const assertScope = async () => {
   await expect(page.locator('main').getByText('File ' + otherId, { exact: true })).toHaveCount(0);
   if (populated) await expect(page.locator('main').getByText('File ' + projectId, { exact: true })).toBeVisible();
   else {
    await expect(page.locator('.ui-empty-copy')).toContainText('尚无资料。新建文档或导入文件以开始。');
    await expect(page.locator('.asset-list > article')).toHaveCount(0);
   }
  };
  await assertScope();
  await page.reload();
  await expect(page).toHaveURL(scoped);
  await assertScope();
  await page.goBack();
  await expect(page).toHaveURL(overview);
  await page.getByRole('link', { name: '打开资料库', exact: true }).click();
  await expect(page).toHaveURL(scoped);
  await assertScope();
  if (populated) {
   await page.locator('.asset-list').getByRole('link', { name: 'File ' + projectId, exact: true }).click();
   expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);
   const detailPath = new URL(page.url()).pathname;
   await page.reload();
   await expect(page.getByRole('heading', { name: 'File ' + projectId, exact: true })).toBeVisible();
   const breadcrumb = page.locator('.asset-breadcrumb').getByRole('link', { name: '返回资料库', exact: true });
   await expect(breadcrumb).toHaveAttribute('href', scoped);
   await page.getByRole('button', { name: '编辑文件', exact: true }).click();
   await page.getByLabel('文档正文', { exact: true }).fill('Updated synthetic project file');
   await page.getByRole('button', { name: '发布新版本', exact: true }).click();
   await expect(page.getByRole('status')).toHaveText('已发布新版本');
   expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);
   const newestVersion = new URL(page.url()).searchParams.get('version');
   await chooseOption(page, '固定版本', firstVersion);
   expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);
   expect(new URL(page.url()).searchParams.get('version')).toBe(firstVersion);
   expect(firstVersion).not.toBe(newestVersion);
   await page.getByRole('button', { name: '文件设置', exact: true }).click();
   await chooseOption(page, '关联项目', projectId);
   await page.getByRole('button', { name: '关联项目', exact: true }).click();
   await expect(page.getByRole('status')).toHaveText('已关联项目');
   await page.getByText('来源与引用', { exact: true }).click();
   const pinned = page.locator('.asset-binding-version').getByRole('link', { name: '固定版本', exact: true });
   await pinned.click();
   expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);
   expect(new URL(page.url()).searchParams.get('version')).toBe(firstVersion);
   await breadcrumb.click();
   await expect(page).toHaveURL(scoped);
   await assertScope();
   await page.goBack();
   await expect(page).toHaveURL(new RegExp(detailPath));
   expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);
   await page.goto(overview);
   await page.locator('.library-resource-rows').getByRole('link', { name: 'File ' + projectId, exact: true }).click();
   expect(new URL(page.url()).searchParams.get('project')).toBe(projectId);
   await breadcrumb.click();
   await expect(page).toHaveURL(scoped);
  }
 });
}
