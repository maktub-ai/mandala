import { test, expect } from './helpers/execution-fixture';

const providerAvatar = '/__test__/provider-avatar.svg';
const customAvatar = '/__test__/custom-avatar.svg';

for (const scenario of ['provider', 'custom', 'missing', 'broken'] as const) {
  test(`chat user avatar follows the account: ${scenario}`, async ({ page, request, executionDirectory }, testInfo) => {
    await page.route('**/auth/session', route => route.fulfill({ json: {
      mode: 'desktop', user: { id: 'avatar-user', username: 'Alice', avatarUrl: scenario === 'missing' ? undefined : providerAvatar },
      csrfToken: 'synthetic-csrf', connection: null,
    } }));
    await page.route('**/auth/avatar', route => route.fulfill({ json: { avatar: scenario === 'custom' ? customAvatar : null } }));
    await page.route('**/__test__/*-avatar.svg', route => scenario === 'broken'
      ? route.fulfill({ status: 404 })
      : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#4f5ae6"/><circle cx="32" cy="24" r="12" fill="white"/><path d="M12 60a20 20 0 0 1 40 0" fill="white"/></svg>' }));
    const response = await request.post('/api/conversations', { data: { cwd: executionDirectory } });
    expect(response.ok()).toBe(true);
    const chat = await response.json();
    expect((await request.post(`/__test__/personal-history/${chat.id}`)).ok()).toBe(true);
    await page.goto(`/?conversation=${chat.id}`);
    const avatar = page.locator('.message.user .message-avatar').last();
    await expect(avatar).toBeVisible();
    if (scenario === 'missing' || scenario === 'broken') {
      await expect(avatar).toHaveText('A');
      await expect(avatar.locator('img')).toHaveCount(0);
    } else {
      const source = scenario === 'custom' ? customAvatar : providerAvatar;
      await expect(page.locator('.sidebar-account img')).toHaveAttribute('src', source);
      await expect(avatar.locator('img')).toHaveAttribute('src', source);
      await expect.poll(() => avatar.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
      for (const [theme, width] of [['light', 1280], ['dark', 390]] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 850 });
        await avatar.scrollIntoViewIfNeeded();
        const imageBox = await avatar.locator('img').boundingBox(), avatarBox = await avatar.boundingBox();
        expect(imageBox!.width).toBe(avatarBox!.width);
        expect(imageBox!.height).toBe(avatarBox!.height);
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`) });
      }
    }
  });
}
