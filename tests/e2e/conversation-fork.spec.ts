import { test, expect } from './helpers/execution-fixture';

for (const language of ['zh-CN', 'en']) test('forks the entire conversation from its header: '+language, async ({page,request,executionDirectory}) => {
  const suffix=crypto.randomUUID(),projectId='fork-'+suffix,agentId='agent-'+suffix;
  const {config,revision}=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{revision,config:{...config,
    projects:[...config.projects,{id:projectId,name:'Fork sample',cwd:executionDirectory,agentIds:[agentId],resources:[],mcp:[],skills:[]}],
    agents:[...config.agents,{id:agentId,name:'Fork agent',instructions:'Synthetic fixture',defaultCli:'codex',models:{},mcp:[],skills:[]}],
  }}})).ok()).toBe(true);
  const en=language==='en';
  await page.addInitScript(value=>localStorage.setItem('mana-language',value),language);
  if(en)await page.setViewportSize({width:390,height:850});
  await page.goto('/?project='+projectId+'&agent='+agentId);
  for(const text of ['Keep the first context','Keep the second context']) {
    await page.getByRole('textbox',{name:en?'Message':'消息',exact:true}).fill(text);
    await page.getByRole('button',{name:en?'Send message':'发送消息',exact:true}).click();
    await expect(page.getByText('Fixture reply: '+text,{exact:true})).toBeVisible();
    await expect(page.getByTestId('chat-status')).toHaveText(en?'Ready':'就绪');
  }
  const source=new URL(page.url()).searchParams.get('conversation')!;
  const before=await(await request.get('/api/conversations/'+source)).json();
  await page.getByRole('button',{name:en?'Fork conversation':'Fork 对话',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('conversation')).not.toBe(source);
  await expect(page.getByTestId('chat-status')).toHaveText(en?'Ready':'就绪');
  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.getByText('Fixture reply: Keep the second context',{exact:true})).toBeVisible();
  expect(await(await request.get('/api/conversations/'+source)).json()).toEqual(before);
  await page.reload();await expect(page.locator('.message.user')).toHaveCount(2);
  await page.getByRole('textbox',{name:en?'Message':'消息',exact:true}).fill('Continue only the fork');
  await page.getByRole('button',{name:en?'Send message':'发送消息',exact:true}).click();
  await expect(page.getByText('Fixture reply: Continue only the fork',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:en?'View original chat':'查看原对话',exact:true}).click();
  await expect(page.locator('.message.user')).toHaveCount(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
