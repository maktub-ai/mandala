import { test, expect } from '@playwright/test';

for (const language of ['zh-CN', 'en']) test(`sidebar module controls share a horizontal center (${language})`, async ({ page }) => {
  await page.addInitScript(lang => localStorage.setItem('mana-language', lang), language);
  await page.goto('/settings/general');
  const rows = page.locator('.module-visibility-row');
  await expect(rows).toHaveCount(7);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const alignment = await rows.evaluateAll(elements => elements.map(row => {
      const centers = [...row.querySelectorAll('label > svg, label > span, input, button')].map(element => {
        const rect = element.getBoundingClientRect();
        return rect.y + rect.height / 2;
      });
      return { name: row.textContent, spread: Math.max(...centers) - Math.min(...centers) };
    }));
    for (const row of alignment) expect(row.spread, `${width}px ${row.name}`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
