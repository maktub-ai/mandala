import {executionAgent} from './helpers/task-executions';
import { expect, test } from '@playwright/test';
test('global palette opens from chat and settings and restores draft focus',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex'}})).json();
 await page.goto('/?conversation='+chat.id+'&project=&agent=');const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('Palette keeps this draft');await input.focus();
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('combobox',{name:'搜索命令或对象',exact:true})).toBeFocused();await page.keyboard.press('Escape');
 await expect(input).toBeFocused();await expect(input).toHaveValue('Palette keeps this draft');
 await page.goto('/settings/general');await expect(page.locator('main h1').first()).toBeVisible();await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');await expect(page.getByRole('dialog')).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Escape backs out of confirmation and selection before closing the palette', async ({ page, request }) => {
 const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex' } })).json();
 await request.patch('/api/conversations/' + chat.id, { data: { title: 'Palette escape destination' } });
 const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': 'palette-escape-task' }, data: { goal: 'Palette escape objective', criteria: [], acceptance: 'human', projectId: null, assigneeAgentId: null } })).json();
 await page.goto('/?conversation=' + chat.id + '&project=');
 const composer = page.getByRole('textbox', { name: '消息', exact: true });
 await composer.fill('Preserved through nested Escape');
 await composer.focus();
 await page.keyboard.press(await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)) ? 'Meta+Shift+P' : 'Control+Shift+P');
 const dialog = page.getByRole('dialog', { name: '命令面板', exact: true });
 const input = dialog.getByRole('combobox', { name: '搜索命令或对象', exact: true });
 await input.fill('> 设为执行对话');
 await input.press('Enter');
 await input.fill('Palette escape objective');
 await dialog.getByRole('option').filter({ hasText: 'Palette escape objective' }).click();
 await input.fill('Palette escape destination');
 await dialog.getByRole('option').filter({ hasText: 'Palette escape destination' }).click();
 await expect(dialog.getByRole('button', { name: '设为执行对话', exact: true })).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(dialog).toBeVisible();
 await expect(dialog.locator('.palette-heading strong')).toHaveText('选择执行对话');
 await expect(input).toBeFocused();
 await input.press('Escape');
 await expect(dialog.locator('.palette-heading strong')).toHaveText('命令面板');
 await expect(dialog.getByRole('button', { name: '返回命令', exact: true })).toHaveCount(0);
 await input.press('Escape');
 await expect(dialog).toHaveCount(0);
 await expect(composer).toBeFocused();
 await expect(composer).toHaveValue('Preserved through nested Escape');
 const detail = await (await request.get('/api/v2/tasks/' + task.id)).json();
 expect(detail.task.conversationIds).not.toContain(chat.id);
 expect(detail.task.state).toBe('todo');
});

test('IME confirmation and failed search never execute, and task editing protects navigation',async({page,request})=>{
 const created=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'palette-protected-edit'},data:{goal:'Protected existing task',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}});expect(created.ok()).toBe(true);const task=await created.json(),editUrl='/tasks/'+task.id+'?action=edit';
 await page.goto(editUrl);const editor=page.getByRole('form',{name:'编辑任务',exact:true});await editor.getByRole('textbox',{name:'任务标题',exact:true}).fill('Protected task draft');
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');
 const dialog=page.getByRole('dialog',{name:'命令面板',exact:true}),input=dialog.getByRole('combobox',{name:'搜索命令或对象',exact:true});
 await input.fill('> 查看用量');await expect(dialog.getByRole('option')).toHaveCount(1);await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});await expect(page).toHaveURL(new URL(editUrl,page.url()).href);
 await expect(dialog.getByRole('option')).toHaveAttribute('aria-disabled','true');await input.press('Enter');await expect(page).toHaveURL(new URL(editUrl,page.url()).href);
 await input.press('Escape');await expect(editor.getByRole('textbox',{name:'任务标题',exact:true})).toHaveValue('Protected task draft');await page.getByRole('button',{name:'取消编辑',exact:true}).click();
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');await input.fill('> 查看用量');await input.press('Enter');await expect(page).toHaveURL(/\/usage$/);await expect(dialog).toHaveCount(0);
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');
 await page.route('**/api/workspace-search?*',route=>route.fulfill({status:403,json:{error:'Synthetic source permission rejected'}}));
 await input.fill('source');await expect(dialog.getByRole('alert')).toContainText('Synthetic source permission rejected');await input.press('Escape');await expect(editor).toHaveCount(0);
});

test('object navigation and explicit execution attachment use the business interfaces',async({page,request})=>{
 const agentId=await executionAgent(request);const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId,cli:'codex'}})).json();
 await request.patch('/api/conversations/'+chat.id,{data:{title:'Palette link target'}});
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'palette-link-flow'},data:{goal:'Palette link objective',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null}})).json();
 await page.goto('/');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');const dialog=page.getByRole('dialog',{name:'命令面板',exact:true}),input=dialog.getByRole('combobox',{name:'搜索命令或对象',exact:true});
 await input.fill('Palette link target');await dialog.getByRole('option').filter({hasText:'Palette link target'}).click();await expect(page).toHaveURL(new RegExp('conversation='+chat.id));
 await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');await input.fill('> 设为执行对话');await expect(dialog.locator('.palette-results em')).toHaveCount(0);await input.press('Enter');
 await input.fill('Palette link objective');await dialog.getByRole('option').filter({hasText:'Palette link objective'}).click();await input.fill('Palette link target');const currentTarget=dialog.getByRole('option').filter({hasText:'Palette link target'});await expect(currentTarget.locator('em')).toHaveText('当前');await currentTarget.click();
 await dialog.getByRole('button',{name:'设为执行对话',exact:true}).click();await expect(dialog).toHaveCount(0);
 const detail=await(await request.get('/api/v2/tasks/'+task.id)).json();expect(detail.task.conversationIds).toContain(chat.id);expect(detail.task.state).toBe('todo');
});

test('palette Tab boundaries skip arrow-selected results and keep focus inside the dialog',async({page})=>{
 await page.goto('/?project=&agent=');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');
 const dialog=page.getByRole('dialog',{name:'命令面板',exact:true}),input=dialog.getByRole('combobox',{name:'搜索命令或对象',exact:true}),help=dialog.getByRole('button',{name:'帮助',exact:false}),close=dialog.getByRole('button',{name:'关闭命令面板',exact:true});
 await expect(input).toBeFocused();await expect(dialog.getByRole('option')).not.toHaveCount(0);
 await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab');await expect(help).toBeFocused();
 await page.keyboard.press('Tab');await expect(close).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(help).toBeFocused();
 await input.focus();await input.fill('> 编辑任务');await input.press('Enter');await expect(dialog.getByRole('button',{name:'返回命令',exact:true})).toBeVisible();
 await page.keyboard.press('Tab');await expect(close).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(input).toBeFocused();
});

test('stop picker keeps an old running current conversation after more than 60 new idle chats',async({page,request})=>{
 const {directory}=await(await request.post('/__test__/execution-directory')).json();
 const target=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null,cwd:directory}})).json();
 await request.patch('/api/conversations/'+target.id,{data:{title:'Old active palette execution'}});
 expect((await request.post('/api/conversations/'+target.id+'/messages',{data:{text:'hold'}})).ok()).toBe(true);
 try {
  await expect.poll(async()=>(await(await request.get('/api/conversations/'+target.id)).json()).conversation.status).toBe('running');
  for(let i=0;i<65;i++)expect((await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex'}})).ok()).toBe(true);
  const bounded=await(await request.get('/api/workspace-search?query=&kind=conversation')).json();expect(bounded).toHaveLength(60);expect(bounded.some((hit:any)=>hit.id===target.id)).toBe(false);
  await page.goto('/?conversation='+target.id+'&project=');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform))?'Meta+Shift+P':'Control+Shift+P');
  const dialog=page.getByRole('dialog',{name:'命令面板',exact:true}),input=dialog.getByRole('combobox',{name:'搜索命令或对象',exact:true});
  await input.fill('> 停止指定对话执行');await input.press('Enter');const row=dialog.getByRole('option').filter({hasText:'Old active palette execution'});
  await expect(row).toBeVisible();await expect(row).toHaveAttribute('aria-selected','true');
  await input.fill('ｏｌｄ ACTIVE');await expect(row).toBeVisible();await input.fill('missing execution');await expect(dialog.getByRole('option')).toHaveCount(0);
 } finally {await request.post('/api/conversations/'+target.id+'/stop',{data:{}});}
});
