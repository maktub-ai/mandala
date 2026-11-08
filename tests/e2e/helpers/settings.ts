import {expect,type Page} from '@playwright/test';
export async function waitForAutosave(page:Page) {
 await expect(page.locator('.settings-autosave')).toContainText(/所有修改已保存|All changes saved/);
}
