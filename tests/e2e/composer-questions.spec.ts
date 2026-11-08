import { interruptSend } from './helpers/select';
import {expect,test} from '@playwright/test';
for(const english of [false,true]) {
 test(`answers the pending question directly${english?' in narrow English':''}`,async({page,request})=>{
  const {revision}=await(await request.get('/api/config')).json();
  await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[],runtimes:['codex']}}});
  if(english){await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.setViewportSize({width:390,height:844});}
  const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:''}})).json();
  await page.goto('/?conversation='+chat.id);await page.getByLabel(english?'Message':'消息',{exact:true}).fill('native-question');
  await page.getByRole('button',{name:english?'Send message':'发送消息',exact:true}).click();
  await expect(page.getByRole('group',{name:'Where should the content open?'})).toBeVisible();
  await page.getByRole('radio',{name:'In app Preview inside OpenMana',exact:true}).check();
  await page.getByRole('button',{name:english?'Submit answers':'提交回答',exact:true}).click();
  await expect(page.getByText('Question answered: In app',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:english?'Queued messages':'等待发送'})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
 test(`interrupts and sends the draft while preserving older queued input${english?' in narrow English':''}`,async({page,request})=>{
  const {revision}=await(await request.get('/api/config')).json();
  await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[],runtimes:['codex']}}});
  const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:''}})).json();
  await request.post(`/api/conversations/${chat.id}/messages`,{data:{text:'hold'}});
  await request.post(`/api/conversations/${chat.id}/queue`,{data:{text:'older request',commandKey:crypto.randomUUID()}});
  if(english){await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.setViewportSize({width:390,height:844});}
  await page.goto(`/?conversation=${chat.id}`);
  const composer=page.getByLabel(english?'Message':'消息',{exact:true});await composer.fill('hold');
  await interruptSend(page);
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('region',{name:english?'Queued messages':'等待发送'})).toContainText('older request');
  const inputs=await(await request.get(`/api/conversations/${chat.id}/queue`)).json();expect(inputs[0].state).toBe('queued');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await request.post(`/api/conversations/${chat.id}/stop`,{data:{}});
 });
}
