import {expect,test} from '@playwright/test';
for(const mode of ['light','dark'] as const)for(const width of [1440,390])test(`confirms concrete configuration proposal ${mode} ${width}`,async({page,request},info)=>{
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:900});
 const proposal=await(await request.post('/__test__/mandala-proposal')).json();await page.goto('/mandala');
 const card=page.locator('.operation-card').filter({hasText:'资料整理助手'}).last();await expect(card).toContainText('资料整理助手');
 await card.locator('.operation-change-disclosure > summary').click();await expect(card).toContainText('整理资料并明确报告可验证结果。');
 await expect(card.getByRole('button',{name:'确认此变更',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`proposal-pending-${mode}-${width}.png`),fullPage:true,animations:'disabled'});
 await card.getByRole('button',{name:'确认此变更',exact:true}).click();await expect(card).toContainText('已应用');
 const config=await(await request.get('/api/config')).json();expect(config.config.agents.find((a:{id:string})=>a.id===proposal.change.values.id)).toMatchObject({name:'资料整理助手'});
 await page.reload();await expect(page.locator('.operation-card').filter({hasText:'资料整理助手'}).last()).toContainText('已应用');
 await page.screenshot({path:info.outputPath(`proposal-applied-${mode}-${width}.png`),fullPage:true,animations:'disabled'});
});
test('stale proposal explains recovery and rejection removes it from changes',async({page,request})=>{
 const proposal=await(await request.post('/__test__/mandala-proposal')).json();const current=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,responseStyle:'concise'}}});
 await page.goto('/mandala');const card=page.locator('.operation-card').filter({has:page.locator(`a[href="/agents?agent=${proposal.change.values.id}"]`)});
 await card.getByRole('button',{name:'确认此变更',exact:true}).click();await expect(card.getByRole('alert')).toContainText('configuration changed');
 await card.getByRole('button',{name:'拒绝',exact:true}).click();await expect(card).toHaveCount(0);
 await page.reload();await expect(card).toHaveCount(0);
});
