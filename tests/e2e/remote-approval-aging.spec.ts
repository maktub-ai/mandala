import { test, expect } from '@playwright/test';
import { remoteKeyFingerprint } from '../../shared/remote-crypto';

test('an older remote request remains explicitly approvable without a fresh-request banner', async ({ page }) => {
  const csrfToken = 'synthetic-csrf', clientId = 'older-client-001', publicKey = Buffer.alloc(32, 7).toString('base64');
  const requestedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const grants = { older: { clientId, publicKey, requestedAt, status: 'pending' }, history: { clientId: 'other-client-001', requestedAt, status: 'approved' } };
  const approvals: Array<{ body: unknown; csrf: string | null }> = [];
  await page.route('**/auth/session', route => route.fulfill({ json: {
    mode: 'local', user: { id: 'synthetic-owner', username: 'synthetic_owner' }, provisioned: true, csrfToken,
    connection: { device: { id: 'synthetic-computer', name: 'Synthetic computer' }, controlUrl: 'https://example.invalid', status: { state: 'connected' } },
  } }));
  await page.route('**/auth/access', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { grants: Object.values(grants) } });
    expect(request.method()).toBe('POST');
    approvals.push({ body: request.postDataJSON(), csrf: await request.headerValue('x-csrf-token') });
    grants.older.status = 'approved';
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '账号 · synthetic_owner' }).click();
  const dialog = page.getByRole('dialog', { name: '账号与连接' });
  await expect(dialog.getByText('没有最近五分钟内的待批准请求。')).toBeVisible();
  const pending = dialog.locator('details').filter({ has: page.getByText('较早的待处理请求', { exact: true }) });
  await expect(pending).not.toHaveAttribute('open', '');
  await expect(pending.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
  await expect(page.getByText('有新的远程连接申请')).toHaveCount(0);
  await pending.getByText('较早的待处理请求', { exact: true }).click();
  await expect(pending.getByText(remoteKeyFingerprint(publicKey), { exact: true })).toBeVisible();
  await expect(pending.getByRole('button', { name: '拒绝', exact: true })).toBeVisible();
  expect(approvals).toEqual([]);
  await pending.getByRole('button', { name: '批准', exact: true }).click();
  await expect(pending).toHaveCount(0);
  expect(approvals).toEqual([{ body: { clientId, publicKey, state: 'approved' }, csrf: csrfToken }]);
  const history = dialog.locator('details').filter({ has: page.getByText('授权历史', { exact: true }) });
  await history.getByText('授权历史', { exact: true }).click();
  const approved = history.locator('.personal-device').filter({ hasText: clientId.slice(0, 12) });
  await expect(approved.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('有新的远程连接申请')).toHaveCount(0);
});
