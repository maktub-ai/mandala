import { test, expect } from '@playwright/test';

const original = 'Persisted content\n\nExact editable bytes.\n';

test('cancel discards edits and failed publication drafts without creating versions', async ({ page, request }) => {
  const stage = await (await request.post('/api/v2/assets/uploads?name=cancel-edit.txt', { data: original })).json();
  const { asset, version } = await (await request.post('/api/v2/assets/imports', {
    headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'file', title: 'Cancel edit fixture', submissionId: stage.submissionId },
  })).json();
  const versionsPath = `/api/v2/assets/${asset.id}/versions`;
  const readVersions = async () => (await request.get(versionsPath)).json();
  const before = await readVersions();
  await page.goto(`/assets/${asset.id}`);
  await expect(page.locator('.asset-content')).toContainText('Persisted content');
  const persistedPreview = await page.locator('.asset-content pre').innerText();
  const edit = page.getByRole('button', { name: '编辑文件', exact: true });
  const body = page.getByLabel('文档正文', { exact: true });
  const cancel = page.getByRole('button', { name: '取消编辑', exact: true });
  for (const failed of [false, true]) {
    await edit.click(); await expect(body).toHaveValue(original);
    await body.fill(failed ? 'Failed publication draft' : 'Discard this draft');
    if (failed) {
      await page.route(`**${versionsPath}`, route => route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { error: 'Synthetic publish failure' } }) : route.continue());
      await page.getByRole('button', { name: '发布新版本', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Synthetic publish failure');
      await expect(body).toHaveValue('Failed publication draft');
    }
    let writes = 0;
    const countWrites = (req: { method(): string }) => { if (!['GET', 'HEAD'].includes(req.method())) writes++; };
    page.on('request', countWrites);
    await expect(cancel).toBeVisible(); await cancel.click();
    await expect(body).toHaveCount(0); await expect(edit).toBeVisible();
    expect(await page.locator('.asset-content pre').innerText()).toBe(persistedPreview);
    expect(writes).toBe(0); page.off('request', countWrites);
    expect(await readVersions()).toEqual(before);
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (failed) await page.unroute(`**${versionsPath}`);
  }
  await edit.click(); await expect(body).toHaveValue(original);
  await body.fill('Successfully revised content');
  await page.getByRole('button', { name: '发布新版本', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已发布新版本');
  await expect(page.locator('.asset-content pre')).toHaveText('Successfully revised content');
  expect(await readVersions()).toHaveLength(before.length + 1);
  const oldVersionId = version?.id ?? asset.headVersionId;
  expect(await (await request.get(`${versionsPath}/${oldVersionId}/files/0`)).text()).toBe(original);
});


test('cancel editing is translated in English', async ({ page, request }) => {
  const stage = await (await request.post('/api/v2/assets/uploads?name=english-cancel.txt', { data: original })).json();
  const { asset } = await (await request.post('/api/v2/assets/imports', {
    headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'file', title: 'English cancel fixture', submissionId: stage.submissionId },
  })).json();
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  await page.goto(`/assets/${asset.id}`);
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit file', exact: true })).toBeVisible();
});

test('revoked source access removes protected edit draft after polling', async ({ page, request }) => {
  const protectedText = 'Protected fixture content';
  const stage = await (await request.post('/api/v2/assets/uploads?name=revoked-edit.txt', { data: protectedText })).json();
  const { asset } = await (await request.post('/api/v2/assets/imports', {
    headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'file', title: 'Revoked edit fixture', submissionId: stage.submissionId },
  })).json();
  await page.goto(`/assets/${asset.id}`);
  await page.getByRole('button', { name: '编辑文件', exact: true }).click();
  const body = page.getByLabel('文档正文', { exact: true });
  await expect(body).toHaveValue(protectedText);
  await body.fill('Protected unpublished draft');
  await page.route('**/api/v2/tasks/source?**', route => route.fulfill({ status: 403, json: { error: 'forbidden' } }));
  await expect(page.getByRole('alert')).toContainText('来源不可访问');
  await expect(body).toHaveCount(0);
  await expect(page.locator('.asset-content')).not.toContainText(protectedText);
  await expect(page.locator('.asset-content')).not.toContainText('Protected unpublished draft');
  await expect(page.getByRole('button', { name: '发布新版本', exact: true })).toHaveCount(0);
});

test('retry after lost publication response reuses the same submission and creates one version', async ({ page, request }) => {
  const stage = await (await request.post('/api/v2/assets/uploads?name=retry-edit.txt', { data: original })).json();
  const { asset } = await (await request.post('/api/v2/assets/imports', {
    headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'file', title: 'Retry edit fixture', submissionId: stage.submissionId },
  })).json();
  const path = `/api/v2/assets/${asset.id}/versions`;
  const before = await (await request.get(path)).json();
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic publication response lost' } });
    await route.fulfill({ response });
  });
  await page.goto(`/assets/${asset.id}`);
  await page.getByRole('button', { name: '编辑文件', exact: true }).click();
  await page.getByLabel('文档正文', { exact: true }).fill('Published exactly once');
  const publish = page.getByRole('button', { name: '发布新版本', exact: true });
  await publish.click(); await expect(page.getByRole('alert')).toContainText('Synthetic publication response lost');
  await expect(page.getByLabel('文档正文', { exact: true })).toHaveValue('Published exactly once');
  await publish.click(); await expect(page.getByRole('status')).toHaveText('已发布新版本');
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toBeTruthy(); expect(attempts[1]).toEqual(attempts[0]);
  expect(await (await request.get(path)).json()).toHaveLength(before.length + 1);
});
