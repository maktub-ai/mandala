import {test,expect} from '@playwright/test';
import {openAccountConnection} from './helpers/navigation';
test('account Escape returns focus to a visible desktop or mobile trigger',async({page})=>{

 await page.route('**/auth/session',route=>route.fulfill({json:{mode:'local',user:{id:'fixture-owner',username:'Synthetic owner'},provisioned:true,csrfToken:'synthetic'}}));
 for(const width of [1440,390])for(const closeWith of ['Escape','button']){await page.setViewportSize({width,height:900});await page.goto('/');await openAccountConnection(page);const dialog=page.getByRole('dialog',{name:'账号与连接',exact:true});await expect(dialog.getByRole('button',{name:'关闭',exact:true})).toBeFocused();if(closeWith==='Escape')await page.keyboard.press('Escape');else await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).toHaveCount(0);const trigger=width===390?page.locator('main .mobile-menu'):page.locator('.sidebar-account');await expect(trigger).toBeVisible();await expect(trigger).toBeFocused();}
});
