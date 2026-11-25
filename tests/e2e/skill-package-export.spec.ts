import { expect, test } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fromBuffer, type Entry } from 'yauzl';
import { productEnv } from '../../cli/product-env.mjs';

test('downloads the complete versioned Skill package in light, dark and narrow views', async ({ page, request }, testInfo) => {
  const response = await request.post('/__test__/skills/seed-package');
  expect(response.ok()).toBe(true);
  const { skill } = await response.json();
  await page.goto('/mana/skills');
  await page.getByRole('button', { name: 'export-review', exact: true }).click();
  await page.getByText('版本记录', { exact: true }).click();
  const link = page.getByRole('link', { name: '下载技能包', exact: true });
  await expect(link).toHaveAttribute('href', `/api/skills/${skill.id}/versions/${skill.versionRef.versionId}/export`);
  const downloading = page.waitForEvent('download');
  await link.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('export-review-v1.zip');
  const archive = testInfo.outputPath('export-review-v1.zip');
  await download.saveAs(archive);
  const files = await new Promise<Map<string, { data: Buffer; mode: number }>>((resolve, reject) => {
    void readFile(archive).then(bytes => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const result = new Map<string, { data: Buffer; mode: number }>();
      zip.on('error', reject); zip.on('end', () => resolve(result));
      zip.on('entry', (entry: Entry) => zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        stream!.on('error', reject); stream!.on('data', chunk => chunks.push(chunk));
        stream!.on('end', () => { result.set(entry.fileName, { data: Buffer.concat(chunks), mode: entry.externalFileAttributes >>> 16 }); zip.readEntry(); });
      }));
      zip.readEntry();
    }), reject);
  });
  expect([...files.keys()].sort()).toEqual(['export-review/SKILL.md', 'export-review/assets/sample.bin', 'export-review/references/指南.md', 'export-review/scripts/check.sh']);
  expect(files.get('export-review/SKILL.md')?.data.toString()).toBe(skill.content);
  expect(files.get('export-review/references/指南.md')?.data.toString()).toBe('完整技能参考资料');
  expect(files.get('export-review/assets/sample.bin')?.data).toEqual(Buffer.from([0,255,137,80,78,71,13,10]));
  expect(files.get('export-review/scripts/check.sh')!.mode & 0o111).toBe(0o100);
  for (const mode of ['light', 'dark'] as const) {
    const settings = await page.context().newPage();
    try {
      await settings.goto(new URL('/settings/appearance', page.url()).href);
      await settings.getByRole('button', { name: mode === 'dark' ? '深色' : '浅色', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    } finally { await settings.close(); }
    await expect(link).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`skill-export-${mode}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(link).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('skill-export-narrow.png'), fullPage: true, animations: 'disabled' });
  const sourceMode = productEnv('E2E_SOURCE') === '1';
  const evidencePath = testInfo.outputPath('source-evidence.json');
  await writeFile(evidencePath, JSON.stringify({
    worktree: process.cwd(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    serviceSource: 'tests/e2e/server.ts with temporary fixture HOME', frontendSource: sourceMode ? 'Vite source' : 'dist',
    buildTime: sourceMode ? null : (await stat('dist/index.html')).mtime.toISOString(), capturedAt: new Date().toISOString(),
  }, null, 2));
  await testInfo.attach('source-evidence', { contentType: 'application/json', path: evidencePath });
});
