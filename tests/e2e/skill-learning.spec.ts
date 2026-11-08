import { setAppearanceMode } from './helpers/navigation';
import { expect, test } from '@playwright/test';
import { waitForAutosave } from './helpers/settings';

test('Skill versions, source and suggestion decisions work over the real service in both themes and narrow layout',async({page,request},testInfo)=>{
 const seeded=await (await request.post('/__test__/skills/seed')).json();
 await page.goto('/mana/skills');
 await expect(page.getByText('草稿经验，待实际验证',{exact:false})).toBeVisible();
 await expect(page.getByText('待维护者确认',{exact:false})).toBeVisible();
 await page.getByText('查看建议正文',{exact:true}).click();
 await expect(page.getByText('Check related states.',{exact:false})).toBeVisible();
 await page.getByText('版本记录',{exact:true}).click();
 await expect(page.getByText('当前版本',{exact:false})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('skills-light.png'),fullPage:true});
 await page.getByRole('button',{name:'采纳并发布',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'SKILL.md 内容',exact:true})).toContainText('Check related states.');
 const detail=await (await request.get('/api/skills/'+seeded.skill.id)).json();expect(detail.versions).toHaveLength(2);expect(detail.suggestions[0].status).toBe('accepted');
 await setAppearanceMode(page,'dark');
 await page.screenshot({path:testInfo.outputPath('skills-dark.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('skills-narrow.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('checkbox',{name:'自动提炼新对话经验',exact:true}).uncheck();await waitForAutosave(page);
 expect((await (await request.get('/api/config')).json()).config.system.skillLearning).toBe(false);
});

test('an ordinary completed dialogue can explicitly queue automatic Skill learning without a Task',async({request})=>{
 await request.post('/__test__/skills/seed');
 const chat=await (await request.post('/api/conversations',{data:{projectId:'',agentId:'skill-owner',workspaceId:null}})).json();
 const sent=await request.post('/api/conversations/'+chat.id+'/messages',{data:{text:'skill-learning-fixture 请整理为技能'}});expect(sent.ok()).toBe(true);
 await expect.poll(async()=>{const config=(await (await request.get('/api/config')).json()).config;return config.skillLibrary?.find((skill:any)=>skill.name==='dialogue-inspect')?.source?.method;}).toBe('dialogue');
 const config=(await (await request.get('/api/config')).json()).config,skill=config.skillLibrary.find((item:any)=>item.name==='dialogue-inspect');expect(skill.creatorAgentId).toBe('skill-owner');expect(config.agents[0].skillIds).toContain(skill.id);expect(skill.source.verification).toBe('draft');
});
