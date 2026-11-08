import { expect, test } from '@playwright/test';
import { openUserMenu } from './helpers/navigation';
test('one user menu holds unpinned modules and Settings without More',async({page})=>{
 await page.goto('/');const menu=await openUserMenu(page);
 await expect(page.getByRole('button',{name:'更多',exact:true})).toHaveCount(0);
 await expect(menu.locator('.sidebar-destination')).toHaveText(['市场','资料库','记忆','自动化','用量','设置']);
 const more=page.getByRole('menu',{name:'用户菜单',exact:true});await expect(more.getByRole('menuitem')).toHaveText(['市场','资料库','记忆','自动化','用量','设置']);
 await more.getByRole('menuitem',{name:'市场',exact:true}).click();await expect(page).toHaveURL('/market?tab=browse');
 await openUserMenu(page);await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'用户菜单',exact:true})).toBeFocused();
});
test('Settings can be pinned to upper navigation and order changes survive reload without changing workspace config',async({page,request})=>{
 const before=await (await request.get('/api/config')).json();await page.goto('/settings/general');
 const preferences=page.getByRole('region',{name:'侧边栏模块',exact:true});
 await preferences.getByRole('switch',{name:'显示设置',exact:true}).check();
 const nav=page.locator('.sidebar-primary-navigation');await expect(nav.getByRole('link',{name:'设置',exact:true})).toBeVisible();
 await preferences.getByRole('button',{name:'调整设置顺序',exact:true}).press('ArrowUp');
 await preferences.getByRole('button',{name:'调整设置顺序',exact:true}).press('ArrowUp');
 await expect(nav.getByRole('link')).toHaveText(['Mandala','任务','项目','智能体','设置']);
 await page.reload();await expect(nav.getByRole('link')).toHaveText(['Mandala','任务','项目','智能体','设置']);
 const menu=await openUserMenu(page);await expect(menu.locator('.sidebar-destination').last()).toHaveText('设置');
 await menu.locator('[data-area=settings]').click();
 await preferences.getByRole('switch',{name:'显示设置',exact:true}).uncheck();await expect(nav.getByRole('link',{name:'设置',exact:true})).toHaveCount(0);
 expect(await (await request.get('/api/config')).json()).toEqual(before);
});
test('hidden primary entries remain reachable in the user menu and Settings remains in the account menu',async({page})=>{
 await page.goto('/settings/general');const preferences=page.getByRole('region',{name:'侧边栏模块',exact:true});
 await preferences.getByRole('switch',{name:'显示任务',exact:true}).uncheck();await preferences.getByRole('button',{name:'调整记忆顺序',exact:true}).press('ArrowUp');
 await page.getByRole('button',{name:'用户菜单',exact:true}).click();const more=page.getByRole('menu',{name:'用户菜单',exact:true});await expect(more.getByRole('menuitem')).toHaveText(['任务','市场','记忆','资料库','自动化','用量','设置']);
 await more.getByRole('menuitem',{name:'任务',exact:true}).click();await expect(page).toHaveURL('/tasks');const account=await openUserMenu(page);await expect(account.locator('.sidebar-destination').last()).toHaveText('设置');
});
test('pinned modules only appear in upper navigation and unpinned modules return to the user menu',async({page})=>{
 await page.goto('/settings/general');const preferences=page.getByRole('region',{name:'侧边栏模块',exact:true}),nav=page.locator('.sidebar-primary-navigation');
 for(const name of ['资料库','记忆'])await preferences.getByRole('switch',{name:'显示'+name,exact:true}).check();
 for(const name of ['资料库','记忆'])await expect(nav.getByRole('link',{name,exact:true})).toBeVisible();await page.getByRole('button',{name:'用户菜单',exact:true}).click();const more=page.getByRole('menu',{name:'用户菜单',exact:true});for(const name of ['资料库','记忆']){await expect(more.getByRole('menuitem',{name,exact:true})).toHaveCount(0);}await page.keyboard.press('Escape');
 for(const name of ['资料库','记忆'])await preferences.getByRole('switch',{name:'显示'+name,exact:true}).uncheck();await page.reload();await page.getByRole('button',{name:'用户菜单',exact:true}).click();await expect(more.getByRole('menuitem')).toHaveText(['市场','资料库','记忆','自动化','用量','设置']);await page.keyboard.press('Escape');
 for(const name of ['记忆','市场'])await preferences.getByRole('switch',{name:'显示'+name,exact:true}).check();await page.getByRole('button',{name:'用户菜单',exact:true}).click();await expect(more.getByRole('menuitem')).toHaveText(['资料库','自动化','用量','设置']);await more.getByRole('menuitem',{name:'资料库',exact:true}).click();await expect(page).toHaveURL('/library');
});
test('user menu only navigates and pinning remains in Settings',async({page})=>{
 await page.goto('/settings/general');await page.getByRole('switch',{name:'显示任务',exact:true}).uncheck();
 const menu=await openUserMenu(page);
 await expect(menu.getByRole('button',{name:/(固定|置顶|pin)/i})).toHaveCount(0);
 await expect(menu.locator('.sidebar-destination').last()).toHaveText('设置');
 await menu.locator('[data-area=settings]').focus();
 await page.keyboard.press('Tab');
 await expect(menu).toBeVisible();await expect(menu.locator('[data-area=settings]')).toBeFocused();await page.keyboard.press('Home');await expect(menu.getByRole('menuitem').first()).toBeFocused();await page.keyboard.press('End');await expect(menu.getByRole('menuitem').last()).toBeFocused();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'用户菜单',exact:true})).toBeFocused();
 await page.getByRole('switch',{name:'显示任务',exact:true}).check();
 await expect(page.locator('.sidebar-primary-navigation').getByRole('link',{name:'任务',exact:true})).toBeVisible();
 await openUserMenu(page);await expect(menu.getByRole('link',{name:'任务',exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'用户菜单',exact:true})).toBeFocused();
});
