import { test, expect } from '@playwright/test';

test('internal memory collections stay outside the material library while documents remain accessible', async ({ page, request }) => {
  const memory = await (await request.post('/api/knowledge', { data: { kind: 'memory', title: 'Synthetic invisible memory', content: 'Synthetic explicit statement', scope: 'global', status: 'active', level: 'L1' } })).json();
  const document = await (await request.post('/api/knowledge', { data: { kind: 'document', title: 'Synthetic visible material', content: 'Synthetic project reference', scope: 'global', status: 'active' } })).json();
  const records = (await (await request.get('/api/v2/memory/records')).json()).records;
  const record = records.find((r: any) => r.legacyId === memory.id);
  expect(record).toBeTruthy();
  const assets = await (await request.get('/api/v2/assets')).json();
  expect(assets.find((a: any) => a.id === record.collectionId).kind).toBe('memory_collection');
  await page.goto('/assets');
  await expect(page.locator('.asset-list a[href="/assets/' + document.id + '"]')).toBeVisible();
  await expect(page.locator('.asset-list a[href="/assets/' + record.collectionId + '"]')).toHaveCount(0);
  await page.goto('/mana?tab=memory');
  await expect(page.getByRole('article', { name: 'Synthetic invisible memory', exact: true })).toBeVisible();
});
