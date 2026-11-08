import { expect, test } from '@playwright/test';

test.beforeEach(async ({page})=>{await page.addInitScript(()=>localStorage.setItem('mana-chat-preferences',JSON.stringify({projectId:'',agentId:'',cli:'codex',model:'',effort:'',onboardingCompleted:true})));});

for (const english of [false, true]) {
  test(`sidebar collapse and resize retain draft and survive reload ${english ? 'en' : 'zh'}`, async ({ page }) => {
    if (english) await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
    await page.goto('/?project=');
    const draft = page.getByRole('textbox', { name: english ? 'Message' : '消息', exact: true });
    await draft.fill('Unsent sidebar draft');
    const url = page.url(), sidebar = page.locator('aside.area-sidebar');
    await expect(page.getByRole('button',{name:english?'Expand sidebar':'展开侧栏',exact:true})).toHaveCount(0);
    await page.getByRole('button', { name: english ? 'Collapse sidebar' : '收起侧栏', exact: true }).click();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    await expect(sidebar).not.toBeVisible();
    expect((await page.locator('main').boundingBox())!.x).toBe(0);
    await expect(page.getByRole('button',{name:english?'Expand sidebar':'展开侧栏',exact:true})).toBeFocused();
    await expect(draft).toHaveValue('Unsent sidebar draft');
    expect(page.url()).toBe(url);
    await page.reload();
    await expect(draft).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    await page.getByRole('button', { name: english ? 'Expand sidebar' : '展开侧栏', exact: true }).click();
    const divider = page.getByRole('separator', { name: english ? 'Resize sidebar' : '调整侧栏宽度', exact: true });
    await divider.focus();
    await page.keyboard.press('End');
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(400);
    await page.reload();
    await expect(draft).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(400);
    await expect(divider).toBeVisible();
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x - 70, box.y + 80);
    await page.mouse.up();
    await expect(divider).toHaveAttribute('aria-valuenow', /32\d|33\d/);
    await page.getByRole('button', { name: english ? 'Collapse sidebar' : '收起侧栏', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: english ? 'Chat list' : '会话列表', exact: true }).click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('navigation', { name: english ? 'Main navigation' : '主导航', exact: true })).toBeVisible();
    await expect(divider).not.toBeVisible();
    await expect(sidebar.locator('.sidebar-collapse')).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
