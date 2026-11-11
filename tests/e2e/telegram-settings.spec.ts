import {test,expect,type Page} from '@playwright/test';

async function openSettings(page:Page){
 await page.goto('/mandala');
 await page.getByRole('button',{name:'Mandala 设置',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Mandala 设置'});
 await dialog.getByText('手机连接 · Telegram',{exact:true}).click();
 return dialog;
}

test('connects a dedicated bot, pairs the named person, updates notifications and unlinks',async({page})=>{
 let state:any={configured:false,state:'unconfigured',attention:true};
 const calls:{path:string;body:any}[]=[];
 await page.route('**/api/mandala/telegram**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(request.method()!=='GET'){
   const body=request.postDataJSON();calls.push({path,body});
   if(path.endsWith('/configure'))state={...state,configured:true,state:'connected',bot:{id:100,username:'mandala_fixture_bot',name:'Fixture Bot'}};
   if(path.endsWith('/pair'))state={...state,pairing:{url:'https://t.me/mandala_fixture_bot?start=fixture',expiresAt:new Date(Date.now()+600000).toISOString()},candidate:{userId:42,chatId:42,name:'测试用户',username:'fixture_user'}};
   if(path.endsWith('/confirm')){state={...state,binding:state.candidate};delete state.candidate;delete state.pairing;}
   if(path.endsWith('/notifications'))state={...state,attention:body.attention};
   if(request.method()==='DELETE')state={configured:false,state:'unconfigured',attention:true};
  }
  await route.fulfill({json:state});
 });
 const dialog=await openSettings(page);
 await dialog.getByLabel('Bot Token',{exact:true}).fill('100:synthetic-token');
 await dialog.getByRole('button',{name:'连接 Bot',exact:true}).click();
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toHaveCount(0);
 await dialog.getByRole('button',{name:'生成绑定二维码',exact:true}).click();
 await expect(dialog.getByRole('img',{name:'Telegram 绑定二维码'})).toBeVisible();
 await expect(dialog.getByRole('link',{name:'在 Telegram 打开'})).toHaveAttribute('href',/https:\/\/t.me\/mandala_fixture_bot/);
 await expect(dialog.getByText('测试用户',{exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'确认绑定此账号',exact:true}).click();
 await expect.poll(()=>calls.find(call=>call.path.endsWith('/confirm'))?.body).toEqual({userId:42});
 await dialog.getByLabel('需要我处理时通知手机',{exact:true}).click();
 await expect(dialog.getByLabel('需要我处理时通知手机',{exact:true})).not.toBeChecked();
 await dialog.getByRole('button',{name:'发送测试消息',exact:true}).click();
 await expect(dialog.getByRole('region',{name:'Telegram 连接'}).getByRole('status').filter({hasText:'测试消息已发送'})).toContainText('测试消息已发送');
 await dialog.getByRole('button',{name:'解除绑定',exact:true}).click();
 await expect(dialog.getByText('解除后旧按钮立即失效，Telegram 历史消息仍会保留。')).toBeVisible();
 await dialog.getByRole('button',{name:'确认解除绑定',exact:true}).click();
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toBeVisible();
});

test('explains connection failure and preserves the token draft for retry',async({page})=>{
 await page.route('**/api/mandala/telegram**',async route=>{
  if(route.request().method()==='POST')return route.fulfill({status:400,json:{error:'Bot 已被其他程序使用，请使用专用 Bot。'}});
  return route.fulfill({json:{configured:false,state:'unconfigured',attention:true}});
 });
 const dialog=await openSettings(page);
 await dialog.getByLabel('Bot Token',{exact:true}).fill('100:synthetic-token');
 await dialog.getByRole('button',{name:'连接 Bot',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Bot 已被其他程序使用');
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toHaveValue('100:synthetic-token');
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toHaveAttribute('type','password');
});

test('a captured pairing candidate can be confirmed after the one-time link is consumed',async({page})=>{
 let confirmed=false;
 const candidate={userId:42,chatId:42,name:'测试用户'};
 await page.route('**/api/mandala/telegram**',route=>{
  if(route.request().url().endsWith('/confirm'))confirmed=true;
  return route.fulfill({json:{configured:true,state:'connected',attention:true,...confirmed?{binding:candidate}:{candidate}}});
 });
 const dialog=await openSettings(page);
 await dialog.getByRole('button',{name:'确认绑定此账号',exact:true}).click();
 await expect.poll(()=>confirmed).toBe(true);
});

test('an unsuccessful configure status retains the credential draft',async({page})=>{
 let failed=false;
 await page.route('**/api/mandala/telegram**',route=>{failed ||= route.request().method()==='POST';return route.fulfill({json:{configured:false,state:failed?'error':'unconfigured',attention:true,...failed?{error:'无法连接 Telegram'}:{}}});});
 const dialog=await openSettings(page);
 await dialog.getByLabel('Bot Token',{exact:true}).fill('100:synthetic-token');
 await dialog.getByRole('button',{name:'连接 Bot',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('无法连接 Telegram');
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toHaveValue('100:synthetic-token');
});

test('a slow status read still completes after the polling interval',async({page})=>{
 await page.clock.install();
 const pending:(()=>void)[]=[];
 await page.route('**/api/mandala/telegram',async route=>{
  await new Promise<void>(resolve=>pending.push(resolve));
  await route.fulfill({json:{configured:false,state:'unconfigured',attention:true}});
 });
 const dialog=await openSettings(page);
 await expect.poll(()=>pending.length).toBeGreaterThan(0);
 await page.clock.runFor(6000);
 pending[0]();
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toBeVisible();
});

test('expired pairing cannot be confirmed, and the instructions remain readable on a narrow screen',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route('**/api/mandala/telegram**',route=>route.fulfill({json:{configured:true,state:'connected',attention:true,bot:{id:100,username:'mandala_fixture_bot',name:'Fixture Bot'},pairing:{url:'https://t.me/mandala_fixture_bot?start=expired',expiresAt:new Date(Date.now()-1000).toISOString()},candidate:{userId:42,chatId:42,name:'测试用户'}}}));
 const dialog=await openSettings(page);
 await expect(dialog.getByText('绑定链接已过期，请重新生成。')).toBeVisible();
 await expect(dialog.getByRole('button',{name:'确认绑定此账号',exact:true})).toBeDisabled();
 expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
 await expect(dialog.getByText(/发送到 Bot 的内容会经过 Telegram/)).toBeVisible();
});

test('Telegram messages retain their human bubble and source in the main chat',async({page,request})=>{
 const {conversation}=await (await request.get('/api/mandala')).json();
 const event={id:987654,conversationId:conversation.id,kind:'user',createdAt:new Date().toISOString(),data:{text:'请继续核对账单',source:{kind:'telegram',requestId:'synthetic-request'}}};
 await page.route('**/api/conversations/'+conversation.id+'/events?*',route=>route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(event)+'\n\nevent: history-ready\ndata: {}\n\n'}));
 await page.goto('/mandala');
 const message=page.getByRole('article',{name:'你的消息'}).filter({hasText:'请继续核对账单'});
 await expect(message.getByText('Telegram',{exact:true})).toBeVisible();
 await expect(message).not.toContainText('自动后台输入');
});

test('task cards and details do not offer a Telegram completion subscription',async({page,request})=>{
 const {goalId}=await (await request.post('/__test__/task-operation-cards')).json();
 const endpoint='/api/mandala/telegram/tasks/'+goalId;
 expect((await request.get(endpoint)).status()).toBe(404);
 expect((await request.put(endpoint,{data:{enabled:true}})).status()).toBe(404);
 const subscription=page.getByRole('checkbox',{name:'完成后通知手机',exact:true});
 await page.goto('/mandala');
 const row=page.locator('[data-task-id="'+goalId+'"]');
 await expect(row.first()).toContainText('验证关联卡片');
 await expect(subscription).toHaveCount(0);
 await page.goto('/tasks/'+goalId);
 await expect(page.getByText('验证关联卡片',{exact:true}).first()).toBeVisible();
 await expect(subscription).toHaveCount(0);
});

test('reopening a connection while unlink finishes rejects the earlier status snapshot',async({page})=>{
 await page.clock.install();
 let removed=false,reads=0,finishDelete:undefined|(()=>void),finishRead:undefined|(()=>void);
 const bound={configured:true,state:'connected',attention:true,binding:{userId:42,chatId:42,name:'测试用户'}};
 await page.route('**/api/mandala/telegram',async route=>{
  if(route.request().method()==='DELETE'){
   await new Promise<void>(resolve=>{finishDelete=resolve;});removed=true;
   return route.fulfill({json:{configured:false,state:'unconfigured',attention:true}});
  }
  const snapshot=removed?{configured:false,state:'unconfigured',attention:true}:bound;
  if(++reads===2)await new Promise<void>(resolve=>{finishRead=resolve;});
  return route.fulfill({json:snapshot});
 });
 const dialog=await openSettings(page);
 await dialog.getByRole('button',{name:'解除绑定',exact:true}).click();
 await dialog.getByRole('button',{name:'确认解除绑定',exact:true}).click();
 await expect.poll(()=>!!finishDelete).toBe(true);
 await dialog.getByText('手机连接 · Telegram',{exact:true}).click();
 await expect(dialog.getByRole('region',{name:'Telegram 连接'})).toHaveCount(0);
 await dialog.getByText('手机连接 · Telegram',{exact:true}).click();
 await expect.poll(()=>!!finishRead).toBe(true);
 finishDelete!();await expect.poll(()=>removed).toBe(true);
 const staleResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/mandala/telegram'&&response.request().method()==='GET');
 finishRead!();await staleResponse;
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
 expect(await dialog.getByText('测试用户',{exact:true}).count()).toBe(0);
 await expect(dialog.getByLabel('Bot Token',{exact:true})).toBeVisible();
 await expect(dialog.getByText('测试用户',{exact:true})).toHaveCount(0);
});

for(const theme of ['light','dark'])test('pairing remains readable in '+theme,async({page},testInfo)=>{
 await page.addInitScript(value=>localStorage.setItem('mana-theme',value),theme);
 await page.setViewportSize({width:theme==='light'?1280:390,height:900});
 await page.route('**/api/mandala/telegram**',route=>route.fulfill({json:{configured:true,state:'connected',attention:true,bot:{id:100,username:'mandala_fixture_bot',name:'Fixture Bot'},pairing:{url:'https://t.me/mandala_fixture_bot?start=fixture',expiresAt:new Date(Date.now()+600000).toISOString()},candidate:{userId:42,chatId:42,name:'测试用户',username:'fixture_user'}}}));
 const dialog=await openSettings(page);
 await dialog.getByRole('img',{name:'Telegram 绑定二维码'}).scrollIntoViewIfNeeded();
 await dialog.getByRole('button',{name:'确认绑定此账号'}).scrollIntoViewIfNeeded();
 await expect(dialog.getByRole('button',{name:'确认绑定此账号'})).toBeInViewport();
 expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('telegram-'+theme+'.png')});
});
