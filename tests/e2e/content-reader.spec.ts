import { expect, test } from '@playwright/test';

test.beforeEach(async ({page}) => {
 await page.route('**/api/conversations/*/local-files/resolve', route => route.fulfill({json:{hrefs:route.request().postDataJSON().hrefs.filter((href:string)=>href==='/tmp/report.md')}}));
});

test('reads documents in a dedicated content view, returns to search and retains the reader when closed', async ({ page, request }) => {
 let configReads=0;page.on('request',req=>{if(req.url().includes('/api/effective?'))configReads++;});
 const chatResponse=await request.post('/api/conversations',{data:{workspaceId:null}});
 expect(chatResponse.ok()).toBe(true);const chat=await chatResponse.json();
 await page.route('**/api/conversations/'+chat.id+'/workspace',route=>route.fulfill({json:{cwd:'/tmp/reading',git:true,truncated:false,files:[{path:'docs/plan.md',status:''},{path:'src/main.ts',status:' M'}]}}));
 let fileReads=0;
 await page.route('**/api/conversations/'+chat.id+'/workspace-file',async route=>{if(++fileReads>1)await new Promise(resolve=>setTimeout(resolve,200));return route.fulfill({json:{name:'plan.md',path:'docs/plan.md',text:'# Reading plan\n\nA document, with **clear emphasis**.\n\n- First step\n- Second step'+'\n\nContinue reading this document.'.repeat(40),diff:null}});});
 await page.goto('/?conversation='+chat.id+'&project=&agent=');
 const draft=page.getByRole('textbox',{name:'消息',exact:true});await draft.fill('Continue discussing the plan');
 const trigger=page.getByRole('button',{name:'展开右侧栏',exact:true});await trigger.click();
 const panel=page.locator('#chat-environment-panel');
 await expect.poll(() => configReads).toBe(1);
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('tab',{name:'配置',exact:true})).toHaveCount(0);
 await panel.getByRole('searchbox',{name:'筛选文件',exact:true}).fill('plan');
 await panel.getByRole('button',{name:'docs/plan.md',exact:true}).click();
 await expect(panel.getByRole('heading',{name:'Reading plan',exact:true})).toBeVisible();
 await expect(panel.getByRole('searchbox')).toHaveCount(0);
 await expect(panel.locator('.conversation-workspace-preview strong')).toHaveText('clear emphasis');
 await panel.getByRole('button',{name:'返回文件',exact:true}).click();
 await expect(panel.getByRole('searchbox')).toHaveValue('plan');
 await panel.getByRole('button',{name:'docs/plan.md',exact:true}).click();
 await expect(panel.getByRole('heading',{name:'Reading plan',exact:true})).toBeVisible();
 expect(configReads).toBe(1);
 const divider=panel.getByRole('separator',{name:'调整右侧栏宽度',exact:true});
 const before=(await panel.boundingBox())!.width;await divider.focus();await page.keyboard.press('ArrowLeft');
 expect((await panel.boundingBox())!.width).toBeGreaterThan(before);
 await panel.locator('.conversation-workspace-preview').evaluate(el=>{el.scrollTop=200;});
 expect(await panel.locator('.conversation-workspace-preview').evaluate(el=>el.scrollTop)).toBe(200);
 await panel.getByRole('button',{name:'收起右侧栏',exact:true}).click();await trigger.click();
 expect(await panel.locator('.conversation-workspace-preview').evaluate(el=>el.scrollTop)).toBe(200);
 await expect(panel.getByRole('heading',{name:'Reading plan',exact:true})).toBeVisible();
 await expect(draft).toHaveValue('Continue discussing the plan');
});

test('opens chat file links directly in content and preserves the unsent draft', async ({ page }) => {
 await page.route('**/local-file',route=>route.fulfill({json:{name:'report.md',path:'/tmp/report.md',text:'# Inspection report\n\nReadable next to this conversation.'}}));
 await page.goto('/?project=&agent=');
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('[排查记录](/tmp/report.md)');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('My pending question');
 await page.getByRole('link',{name:'排查记录',exact:true}).first().click();
 const panel=page.locator('#chat-environment-panel');
 await expect(panel.getByRole('heading',{name:'Inspection report',exact:true})).toBeVisible();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('My pending question');
});
