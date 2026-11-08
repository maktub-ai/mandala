import {test, expect} from '@playwright/test';
const scenes = [{width:1440,language:'en',theme:'dark',username:'root'},{width:390,language:'en',theme:'light',username:'A very long account display name for a narrow sidebar'},{width:1440,language:'zh-CN',theme:'light',username:'用户名称与连接状态检查'},{width:390,language:'zh-CN',theme:'dark',username:'root'}];

for (const scene of scenes) test(`user menu layout ${scene.width} ${scene.language}`,async({page},info)=>{
 const en=scene.language==='en';
 await page.setViewportSize({width:scene.width,height:850});
 await page.addInitScript(scene=>{localStorage.setItem('mana-language',scene.language);localStorage.setItem('mana-theme',scene.theme);},scene);
 await page.route('**/auth/session',r=>r.fulfill({json:{mode:'local',user:{id:'menu-layout',username:scene.username},connection:null}}));
 await page.goto('/tasks');
 if(scene.width<600)await page.getByRole('button',{name:en?'Open sidebar':'打开侧栏',exact:true}).click();
 const trigger=page.getByRole('button',{name:en?'User menu':'用户菜单',exact:true});
 for(const fontSize of [13,18]){await page.evaluate(size=>document.documentElement.style.setProperty('--theme-font-size',size+'px'),fontSize);
 const bounds=await trigger.evaluate(node=>{const b=node.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,children:[...node.querySelectorAll('.sidebar-account-avatar,strong,small')].map(c=>c.getBoundingClientRect().toJSON())};});
 for(const rect of bounds.children){expect(rect.top).toBeGreaterThanOrEqual(bounds.top);
  expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(rect.right).toBeLessThanOrEqual(bounds.right);
 }
 }
 await expect(trigger.locator('strong')).toHaveAttribute('title',scene.username);
 await trigger.click();
 const menu=page.getByRole('menu',{name:en?'User menu':'用户菜单',exact:true});
 await expect(menu.getByRole('menuitem',{name:en?'Account':'账号',exact:true})).toBeVisible();
 await expect(menu.getByRole('menuitem',{name:en?'Command palette':'命令面板',exact:true})).toHaveCount(0);
 await page.screenshot({path:info.outputPath('menu.png'),animations:'disabled'});
 await page.keyboard.press('Escape');
 await expect(trigger).toBeFocused();
 await trigger.click();
 await menu.locator('[data-area=settings]').click();
 await page.getByRole('button',{name:en?'Open command palette':'打开命令面板',exact:false}).click();
 await expect(page.getByRole('dialog',{name:en?'Command palette':'命令面板',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');
 await expect(page.getByRole('dialog',{name:en?'Command palette':'命令面板',exact:true})).toBeVisible();
});
