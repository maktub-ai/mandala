import {test,expect} from '@playwright/test';
import {defaultPreferences} from '../../src/themes';

// spec: audit/2026-10-26-title-visibility/official-plan.md
// seed: tests/e2e/seed.spec.ts

test.describe('Chat title visibility and safe rename',()=>{
 test('TITLE-01 long chat titles preserve their visible prefix and safe rename at narrow widths',async({page,request})=>{
  const scenes=[
   {width:390,theme:'dark' as const,language:'zh-CN',title:'统一任务与对话进度展示，修复长中文标题在窄窗口下被挤压截断的问题，并保留筛选、完成和协作回执状态的独立性，同时验证待处理事项',saved:'保存后的完整对话标题：继续核对任务与对话的状态边界、协作回执、排队提问和审批入口，确保窄窗口下能读到标题开头与完整名称'},
   {width:768,theme:'light' as const,language:'en',title:'Release coordination and conversation progress: preserve the complete long title',saved:'Saved release coordination title: inspect queued replies and approval navigation'},
  ];
  const unexpectedPosts:string[]=[];page.on('request',r=>{const path=new URL(r.url()).pathname;if(r.method()==='POST'&&path.startsWith('/api/')&&!/^\/api\/conversation-progress\/[^/]+$/.test(path))unexpectedPosts.push(path);});
  await page.goto('/');
  for(const scene of scenes)await test.step(`${scene.width}px ${scene.theme} ${scene.language}`,async()=>{
   // 1. Open one synthetic idle chat with a long title and capture intentional setup boundaries.
   await page.setViewportSize({width:scene.width,height:850});
   await page.evaluate(({preferences,language})=>{localStorage.setItem('mandala-appearance-v1',JSON.stringify(preferences));localStorage.setItem('mana-language',language);},{preferences:{...defaultPreferences(scene.theme),mode:scene.theme},language:scene.language});
   const created=await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex'}});expect(created.ok()).toBe(true);const chat=await created.json();
   expect((await request.patch(`/api/conversations/${chat.id}`,{data:{title:scene.title}})).ok()).toBe(true);
   const chatsBefore=await(await request.get('/api/conversations?origin=all')).json(),tasksBefore=await(await request.get('/api/v2/tasks')).json(),eventsBefore=await(await request.get(`/api/conversations/${chat.id}/history`)).json();
   await page.goto(`/?project=&conversation=${chat.id}`);await expect(page.locator('html')).toHaveAttribute('data-theme',scene.theme);
   const trigger=page.locator('.chat-title-trigger'),input=page.getByRole('textbox',{name:scene.language==='en'?'Chat title':'对话标题',exact:true});
   const prefixGeometry=()=>trigger.evaluate(button=>{const node=[...button.childNodes].find(n=>n.nodeType===Node.TEXT_NODE)!;const range=document.createRange();range.setStart(node,0);range.setEnd(node,6);const p=range.getBoundingClientRect(),b=button.getBoundingClientRect();range.selectNodeContents(button);return{button:{x:b.x,right:b.right,width:b.width},prefix:{x:p.x,right:p.right,width:p.width},textWidth:range.getBoundingClientRect().width};});
   const assertPrefix=async(label:string)=>{const g=await prefixGeometry();expect.soft(g.textWidth,`${label}: fixture must really overflow`).toBeGreaterThan(g.button.width);expect.soft(g.prefix.width,`${label}: first six characters have geometry`).toBeGreaterThan(0);expect.soft(g.prefix.x,`${label}: visible beginning ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(g.button.x-1);expect.soft(g.prefix.right,`${label}: first six characters inside button ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.button.right+1);};
   await expect(trigger).toHaveText(scene.title);await assertPrefix('original title');
   // 2. Hover exposes the complete title, Enter opens the complete focused value and Escape discards edits.
   await trigger.hover();await expect.soft(trigger).toHaveAttribute('title',scene.title);
   await trigger.focus();await page.keyboard.press('Enter');await expect(input).toBeFocused();await expect(input).toHaveValue(scene.title);
   await input.fill('Cancelled title');await input.press('Escape');await expect(trigger).toHaveText(scene.title);
   expect((await(await request.get(`/api/conversations/${chat.id}`)).json()).conversation.title).toBe(scene.title);
   await page.screenshot({path:`audit/2026-10-26-title-visibility/original-${scene.width}-${scene.theme}.png`,fullPage:false});
   // 3. Enter saves a long title, reload preserves it and rename still exposes the full value.
   await trigger.focus();await page.keyboard.press('Enter');await input.fill(scene.saved);await input.press('Enter');await expect(trigger).toHaveText(scene.saved);
   await page.reload();await expect(trigger).toHaveText(scene.saved);await assertPrefix('saved title');await trigger.hover();await expect.soft(trigger).toHaveAttribute('title',scene.saved);
   await trigger.focus();await page.keyboard.press('Enter');await expect(input).toHaveValue(scene.saved);await input.press('Escape');await expect(trigger).toHaveText(scene.saved);
   expect((await(await request.get(`/api/conversations/${chat.id}`)).json()).conversation).toMatchObject({title:scene.saved,status:'idle',nativeId:null,turnId:null});
   // 4. Merely reading and renaming creates no additional Chat, Task, queued input or execution.
   expect((await(await request.get('/api/conversations?origin=all')).json()).length).toBe(chatsBefore.length);expect(await(await request.get('/api/v2/tasks')).json()).toEqual(tasksBefore);
   expect(await(await request.get(`/api/conversations/${chat.id}/history`)).json()).toEqual(eventsBefore);expect(await(await request.get(`/api/conversations/${chat.id}/queue`)).json()).toEqual([]);expect(unexpectedPosts).toEqual([]);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(scene.width+1);await expect(page.getByRole('button',{name:scene.language==='en'?'Stop execution':'停止执行',exact:true})).toHaveCount(0);
   await page.screenshot({path:`audit/2026-10-26-title-visibility/saved-${scene.width}-${scene.theme}.png`,fullPage:false});
  });
 });
});
