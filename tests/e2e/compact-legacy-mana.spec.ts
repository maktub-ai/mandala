import {test,expect} from '@playwright/test';
test('legacy Skill drafts retain real edit, adoption, delete and guarded navigation in a compact detail',async({page,request})=>{
 const created=await(await request.post('/api/knowledge',{data:{kind:'skill',title:'长期协作 Skill draft · '+ 'Long bilingual title '.repeat(3),content:'# Exact draft\n\n原始中文正文。',scope:'global',status:'candidate',access:{mode:'owner'}}})).json();
 await page.goto('/mana?tab=skill');await page.getByRole('button',{name:created.title,exact:true}).click();
 await expect(page.getByRole('heading',{name:created.title,exact:true})).toBeVisible();
 await page.locator('.mana-detail summary').filter({hasText:'查看内容'}).click();await expect(page.getByText('原始中文正文。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'编辑资料',exact:true}).click();await page.getByRole('textbox',{name:'资料内容',exact:true}).fill('# Revised\n\n保留原始归属和权限。');
 await expect(page.locator('.sidebar-start .new-chat')).toBeDisabled();await page.getByRole('button',{name:'保存资料',exact:true}).click();
 await expect(page.getByRole('button',{name:'编辑资料',exact:true})).toBeEnabled();
 let saved=(await(await request.get('/api/knowledge')).json()).find((item:{id:string})=>item.id===created.id);expect(saved.content).toContain('保留原始归属和权限。');expect(saved.scope).toBe('global');expect(saved.access.mode).toBe('owner');
 await page.getByRole('button',{name:'确认采用',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/knowledge')).json()).find((item:{id:string})=>item.id===created.id)?.status).toBe('active');
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.mana-list-detail > .workspace-list')).toBeHidden();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'返回草稿',exact:true}).click();await expect(page.getByRole('button',{name:created.title,exact:true})).toBeVisible();await page.getByRole('button',{name:created.title,exact:true}).click();
 await page.getByRole('button',{name:'删除资料',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/knowledge')).json()).some((item:{id:string})=>item.id===created.id)).toBe(false);
});
test('legacy memory and document URLs retain their actual destinations',async({page})=>{
 await page.goto('/mana?tab=memory');await expect(page.getByRole('heading',{name:'记忆',exact:true,level:1})).toBeVisible();
 await page.goto('/mana?tab=document');await expect(page.getByRole('heading',{name:'资料库',exact:true,level:1})).toBeVisible();
 await page.goto('/mana/skills');await expect(page.locator('nav[data-active-area]')).toHaveAttribute('data-active-area','settings');
});
