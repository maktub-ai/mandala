import {expect,test} from '@playwright/test';
let fixture:{mainId:string;goalId:string;chatId:string;eventId:number;agentId:string;projectId:string};
test.beforeAll(async({request})=>{fixture=await(await request.post('/__test__/mandala-panels')).json();});
for(const mode of ['light','dark'])for(const width of [1440,1024,768,390])test(`panels ${mode} ${width}: actual goals, identity, references and focus`,async({page,request},info)=>{
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:900});await page.goto('/mandala');
 await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
 if(width<=1100)await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 const panel=page.locator('.mandala-panels');await expect(panel.getByText('接通跨项目登录流程，并验证很长的中英文标题 Long operational goal',{exact:true}).last()).toBeVisible();
 await page.evaluate(()=>document.documentElement.style.setProperty('--accent','#7c3aed'));
 const textColor=await page.locator('body').evaluate(element=>getComputedStyle(element).color),mutedColor=await panel.locator('.task-work-meta').first().evaluate(element=>getComputedStyle(element).color);
 await expect(panel.locator('.task-work-heading > a').first()).toHaveCSS('color',textColor);await expect(panel.locator('a.task-work-project').first()).toHaveCSS('color',mutedColor);await expect(panel.locator('.mandala-all-tasks')).toHaveCSS('color',textColor);
 await panel.locator('.task-work-related > summary').last().click();await expect(panel.getByRole('link',{name:'打开执行对话：登录接口实现 · 共享测试 Agent',exact:true}).last()).toContainText('执行中');
 await page.screenshot({path:info.outputPath(`tasks-${mode}-${width}.png`),animations:'disabled'});
 await panel.getByRole('tab',{name:'智能体',exact:true}).click();
 await expect(panel.getByText('临时测试 Agent',{exact:true})).toHaveCount(0);
 await expect(panel.locator('.mandala-team-agent-name',{hasText:'共享测试 Agent'}).last()).toBeVisible();
 await expect(panel.getByRole('button',{name:'引用 共享测试 Agent',exact:true}).last()).toBeEnabled();
 await page.screenshot({path:info.outputPath(`teams-${mode}-${width}.png`),animations:'disabled'});
 await panel.getByRole('button',{name:'引用 共享测试 Agent',exact:true}).last().click();
 const composer=page.getByRole('textbox',{name:'消息',exact:true});await expect(composer).toBeFocused();
 await expect(page.locator('.composer-references .composer-reference-tag')).toHaveCount(1);
 if(width<=1100)await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 await panel.getByRole('button',{name:'引用 共享测试 Agent',exact:true}).last().click();await expect(page.locator('.composer-references .composer-reference-tag')).toHaveCount(1);
 await composer.fill('保留中文输入');await composer.dispatchEvent('compositionstart');await composer.dispatchEvent('keydown',{key:'Enter',isComposing:true});await expect(composer).toHaveValue('保留中文输入');await composer.dispatchEvent('compositionend');
 if(width<=1100)await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 await panel.getByRole('tab',{name:'智能体',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(panel.getByRole('tab',{name:'定时',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(panel.getByText('每日任务简报',{exact:true})).toBeVisible();await expect(panel.getByText('每天 18:00 · Asia/Singapore')).toBeVisible();await expect(panel.getByRole('link',{name:'查看上次执行',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath(`scheduled-${mode}-${width}.png`),animations:'disabled'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.keyboard.press('Escape');await expect(panel).not.toBeVisible();
 expect((await(await request.get('/api/mandala/goals')).json()).some((goal:{taskId:string})=>goal.taskId===fixture.goalId)).toBe(true);
});

test('selected public slice returns to Mandala without replacing its saved draft',async({page,request})=>{
 await page.goto('/mandala');const composer=page.getByRole('textbox',{name:'消息',exact:true});await composer.fill('保留主聊天草稿');
 await expect.poll(async()=>{const drafts=await(await request.get('/api/drafts')).json();return JSON.stringify(drafts);}).toContain('保留主聊天草稿');
 await page.goto('/?conversation='+fixture.chatId);
 const message=page.locator('.message.text .markdown-text').filter({hasText:'Public opening.'});await expect(message).toBeVisible();
 await message.evaluate(element=>{const node=element.querySelector('p')!.firstChild!;const text=node.textContent!,start=text.indexOf('精确');const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+'精确选择这一句。'.length);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));});
 await page.locator('.selection-quote').getByRole('button',{name:'引用到 Mandala',exact:true}).click();
 await expect(page).toHaveURL(/\/mandala\?/);await expect(composer).toHaveValue('保留主聊天草稿');
 await expect(page.locator('.composer-message-excerpt')).toHaveText('精确选择这一句。');
 await expect(page.locator('.composer-references')).not.toContainText('Public opening.');
 await expect.poll(async()=>{const drafts=await(await request.get('/api/drafts')).json();return JSON.stringify(drafts);}).toContain('保留主聊天草稿');await page.reload();await expect(composer).toHaveValue('保留主聊天草稿');await expect(page.locator('.composer-message-excerpt')).toHaveText('精确选择这一句。');
});

test('dragging Project, Agent and Task adds distinct stable references without duplicate or work',async({page,request})=>{
 await page.setViewportSize({width:1440,height:900});await page.goto('/mandala');
 const panel=page.locator('.mandala-panels'),composer=page.getByRole('textbox',{name:'消息',exact:true});
 await expect(panel.locator('.task-work-card')).toHaveCount(1);
 for(const button of await page.locator('.composer-references button').all())await button.click();
 await panel.getByRole('tab',{name:'智能体',exact:true}).click();
 await expect(panel.getByRole('button',{name:'引用 共享测试 Agent',exact:true}).first()).toBeEnabled();
 await panel.locator('.mandala-team').first().dragTo(composer,{sourcePosition:{x:40,y:20}});
 await panel.locator('.mandala-team-agent').first().dragTo(composer);
 await panel.locator('.mandala-team-agent').nth(1).dragTo(composer);
 await expect(page.locator('.composer-reference-tag')).toHaveCount(2);
 await expect(page.locator('.composer-reference-tag').filter({hasText:'Agent'})).toHaveCount(1);
 await panel.getByRole('tab',{name:'任务',exact:true}).click();await panel.locator('.task-work-card').dragTo(composer);
 await expect(page.locator('.composer-reference-tag')).toHaveCount(3);
 expect((await(await request.get('/api/mandala/goals')).json())).toHaveLength(1);
});

test('panel loading, empty, error and revoked permission clear data and offer retry',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/mandala/goals',async route=>{await gate;await route.fulfill({json:[]});});
 await page.goto('/mandala');const panel=page.locator('.mandala-panels');await expect(panel.getByText('正在读取…',{exact:true})).toBeVisible();release();
 await expect(panel.getByText('本对话还没有任务。在聊天中交代想完成的事情。')).toBeVisible();
 await page.unroute('**/api/mandala/goals');await page.route('**/api/mandala/goals',route=>route.fulfill({status:403,json:{error:'Synthetic permission revoked'}}));
 await expect(panel.getByRole('alert')).toContainText('Synthetic permission revoked');await expect(panel.locator('.task-work-card')).toHaveCount(0);
 await page.unroute('**/api/mandala/goals');await panel.getByRole('button',{name:'重试',exact:true}).click();await expect(panel.locator('.task-work-card')).toHaveCount(1);
});

test('Teams keeps missing and null lifecycle unknown while known idle stays non-running',async({page})=>{
 let status:'missing'|'null'|'idle'='null';
 await page.route('**/api/conversation-progress',async route=>{
  const response=await route.fetch(),rows=await response.json();
  await route.fulfill({json:rows.map((row:{id:string;executionStatus?:string|null})=>{
   if(row.id!==fixture.chatId)return row;
   if(status==='missing'){const {executionStatus,...legacy}=row;return legacy;}
   return {...row,executionStatus:status==='null'?null:'idle'};
  })});
 });
 for(const current of ['null','missing','idle'] as const){
  status=current;await page.goto('/mandala');const panel=page.locator('.mandala-panels');
  await panel.getByRole('tab',{name:'智能体',exact:true}).click();
  const shared=panel.locator('.mandala-team-agent').filter({hasText:'共享测试 Agent'}).first();
  if(current==='idle'){await expect(shared).toContainText('空闲');await expect(shared).not.toContainText('执行状态未知');}
  else{await expect(shared).toContainText('1 个对话执行状态未知');await expect(shared).not.toContainText('空闲');await expect(panel.locator('.mandala-panel-summary')).toContainText('1 个对话执行状态未知');}
  await expect(panel.locator('.mandala-team-agent').filter({hasText:'独立测试 Agent'})).toContainText('空闲');
 }
});
