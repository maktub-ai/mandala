import {test,expect,type Page} from '@playwright/test';
import {remoteMobileFixture} from './remote-mobile-fixture';
import {openAccountConnection} from './helpers/navigation';
import {ensureMandalaConfig,readConfig} from '../../server/config';
import {ensureMandalaConversation} from '../../server/mandala';

async function pairRemote(page:Page,computer:Page,fixture:Awaited<ReturnType<typeof remoteMobileFixture>>){
 const signIn=async(target:Page,url:string)=>{await target.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));await target.goto(url);await target.getByLabel('账号',{exact:true}).fill('mobile');await target.getByLabel('密码',{exact:true}).fill(fixture.password);await target.getByRole('button',{name:'登录',exact:true}).click();};
 await signIn(computer,fixture.localUrl);await openAccountConnection(computer);await computer.locator('summary').filter({hasText:'高级：自部署连接服务'}).click();await computer.getByLabel('账号服务地址',{exact:true}).fill(fixture.relayUrl);await computer.getByLabel('电脑名称',{exact:true}).fill('Remote Mandala computer');await computer.getByLabel('服务账号',{exact:true}).fill('mobile');await computer.getByLabel('服务密码',{exact:true}).fill(fixture.password);await computer.getByRole('button',{name:'连接账号服务',exact:true}).click();
 const code=await computer.getByLabel('电脑配对码',{exact:true}).textContent();await signIn(page,fixture.relayUrl);await page.getByRole('button',{name:'请求授权',exact:true}).click();await computer.getByRole('button',{name:'批准',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByLabel('电脑配对码',{exact:true}).fill(code!);await page.getByRole('button',{name:'确认配对',exact:true}).click();
}

test('the Mandala tab opens the one primary chat with owned goals and in-chat proposal decisions',async({page,browser})=>{
 test.setTimeout(120000);
 const fixture=await remoteMobileFixture(),context=await browser.newContext(),computer=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  const {config}=await ensureMandalaConfig(fixture.home),primary=ensureMandalaConversation(fixture.store,config),mandalaId=config.mandala!.agentId;
  fixture.store.appendEvent(primary.id,'user',{text:'Prepare the synthetic launch checklist'});fixture.store.appendEvent(primary.id,'text',{text:'I created a goal and proposed one reviewer Agent.'});
  const source={agentId:mandalaId,conversationId:primary.id,invocationId:'synthetic-invocation'};
  const goal=await fixture.manager.coordination.create(source,{goal:'合成发布清单 · Synthetic launch checklist',criteria:[{id:'evidence',text:'Return verifiable evidence',checkRef:null}],projectId:null},'synthetic-goal');
  await fixture.manager.coordination.configure(source,{kind:'agent',action:'create',values:{id:'remote-proposed-agent',name:'Proposed reviewer',instructions:'Synthetic review',defaultCli:'codex',models:{},mcp:[],skills:[]}},'propose','synthetic-proposal',()=>{});
  const background=fixture.store.createConversation({projectId:'',agentId:mandalaId,cli:'codex',model:null,purpose:'mandala-background'});fixture.store.renameConversation(background.id,'Mandala background synthetic run');
  await page.setViewportSize({width:1280,height:850});await pairRemote(page,computer,fixture);
  await expect(page.locator('.remote-tabs [aria-current=page]')).toHaveText('Mandala');
  await expect(page.getByRole('heading',{name:config.agents.find(agent=>agent.id===mandalaId)!.name,exact:true})).toBeVisible();
  await expect(page.getByText('I created a goal and proposed one reviewer Agent.',{exact:true})).toBeVisible();
  const goals=page.getByRole('complementary',{name:'Mandala 负责的目标'});await expect(goals.getByRole('heading',{name:goal.goal,exact:true})).toBeVisible();
  const proposal=page.getByRole('region',{name:/配置变更 · Proposed reviewer/});await expect(proposal).toContainText('待确认');await page.screenshot({path:'/tmp/remote-mandala-1280.png'});
  await proposal.getByRole('button',{name:'确认此变更',exact:true}).click();await expect(proposal).toContainText('已应用');
  expect((await readConfig(fixture.home)).config.agents.some(agent=>agent.id==='remote-proposed-agent')).toBe(true);
  await page.getByLabel('消息',{exact:true}).fill('Remote follow-up for Mandala');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>fixture.store.listEvents(primary.id,0).some(event=>event.kind==='user'&&(event.data as {text?:string}).text==='Remote follow-up for Mandala')).toBe(true);
  await page.getByRole('button',{name:'对话',exact:true}).click();const list=page.locator('.remote-chat-list');
  await expect(list.getByRole('button',{name:/手机端合成对话/})).toBeVisible();await expect(list.getByRole('button',{name:/Mandala background synthetic run/})).toHaveCount(0);
  await list.getByRole('button',{name:/Mandala 后台执行/}).click();await expect(list.getByRole('button',{name:/Mandala background synthetic run/})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'智能体',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'智能体',exact:true}).click();await expect(page.getByRole('option',{name:new RegExp(config.agents.find(agent=>agent.id===mandalaId)!.name)})).toHaveCount(0);await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Mandala',exact:true}).click();
  await expect(page.getByText('I created a goal and proposed one reviewer Agent.',{exact:true})).toBeVisible();await page.screenshot({path:'/tmp/remote-mandala-390-chat.png'});
  await page.getByRole('button',{name:/^目标/}).click();await expect(goals.getByRole('heading',{name:goal.goal,exact:true})).toBeVisible();await page.screenshot({path:'/tmp/remote-mandala-390-goals.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{await context.close();await fixture.close();}
});
