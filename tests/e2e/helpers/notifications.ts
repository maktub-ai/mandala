import {expect,type Page} from '@playwright/test';

export async function openNotifications(page:Page){
 const panel=page.getByRole('dialog',{name:/^(通知|Notifications)$/});
 if(await panel.isVisible()){
  if(await panel.getAttribute('data-state')==='open')return panel;
  await expect(panel).not.toBeVisible();
 }
 const trigger=page.getByRole('button',{name:/^(通知|Notifications)$/,exact:true});
 if(!await trigger.isVisible())await page.locator('.mobile-menu:visible,.sidebar-expand:visible').first().click();
 await trigger.click();await expect(panel).toBeVisible();return panel;
}
