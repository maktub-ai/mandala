import {defaultPreferences,themeStorageKey} from '../../shared/themes';
import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
const shots='/tmp/mandala-folded-commentary-ui';

test.beforeEach(async({request})=>{
 const {revision,config}=await(await request.get('/api/config')).json();
 const saved=await request.put('/api/config',{data:{revision,config:{...config,projects:[{id:'activity',name:'数据工作区',cwd:'',agentIds:['inspector'],resources:[],mcp:[],skills:[]}],agents:[...config.agents.filter((agent:{systemRole?:string})=>agent.systemRole),{id:'inspector',name:'Mandala',instructions:'Synthetic activity fixture only.',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}});
 expect(saved.ok(),await saved.text()).toBe(true);
});

test.afterEach(async({request})=>{
 const chats=await(await request.get('/api/conversations')).json();
 for(const chat of chats.filter((chat:{agentId:string;status:string})=>chat.agentId==='inspector'&&['running','approval'].includes(chat.status))){
  expect((await request.post('/api/conversations/'+chat.id+'/stop',{data:{}})).ok()).toBe(true);
 }
});

test('streams unphased recent output to chat, card and Task, then confirms the final answer only at normal end',async({page,request})=>{
 const f=await(await request.post('/__test__/live-output-fixture')).json();
 await page.setViewportSize({width:1440,height:960});await page.goto('/?conversation='+f.id);
 await expect(page.locator('.turn-process > .explicit-progress')).not.toContainText('最近输出');await expect(page.locator('.turn-process > .explicit-progress')).toHaveAttribute('aria-label','最近输出');await expect(page.locator('.turn-process > .explicit-progress')).toContainText('正在核对明细');
 await expect(page.locator('.message.text')).toHaveCount(0);mkdirSync(shots,{recursive:true});await page.screenshot({path:shots+'/chat-output-active-light-1440.png',fullPage:true,animations:'disabled'});
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.evaluate(({key,value})=>{localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},{key:themeStorageKey,value:JSON.stringify({...defaultPreferences(),mode:theme})});await page.setViewportSize({width,height:960});await page.reload();
  await expect(page.locator('.turn-process > .explicit-progress')).toContainText('正在核对明细');await expect(page.locator('.turn-process > .explicit-progress')).not.toContainText('最近输出');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${shots}/chat-output-active-${theme}-${width}.png`,fullPage:true,animations:'disabled'});
 }
 await page.evaluate(({key,value})=>{localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},{key:themeStorageKey,value:JSON.stringify({...defaultPreferences(),mode:'light'})});await page.setViewportSize({width:1440,height:960});await page.reload();
 const liveChat=await page.context().newPage();await liveChat.goto('/?conversation='+f.id);
 await liveChat.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 await page.goto('/tasks?type=conversations');
 const card=page.locator('[data-conversation-id="'+f.id+'"]');
 await expect(card.locator('.explicit-progress')).toHaveAttribute('data-progress-source','output');
 await expect(card).toContainText('正在核对明细');
 await request.post('/__test__/live-output-update',{data:{id:f.id,stage:'chunk'}});
 await expect(liveChat.locator('.run-commentary')).toContainText('正在核对明细，并检查汇总差异');
 await expect(liveChat.getByRole('button',{name:'收起本轮过程',exact:true})).toHaveAttribute('aria-expanded','true');
 await liveChat.getByRole('button',{name:'收起本轮过程',exact:true}).click();
 await expect(card).toContainText('正在核对明细，并检查汇总差异',{timeout:6000});
 await page.goto('/tasks/'+f.task);
 const summary=page.getByRole('region',{name:'执行对话',exact:true}).locator('.progress-latest-summary');
 await expect(summary).toContainText('最近输出');await expect(summary).toContainText('正在核对明细，并检查汇总差异');
 await request.post('/__test__/live-output-update',{data:{id:f.id,stage:'answer'}});
 await expect(summary).toContainText('核对完成，真实合计为 885。',{timeout:6000});
 await expect(liveChat.locator('.turn-process > .explicit-progress')).toContainText('核对完成');
 await expect(liveChat.getByRole('button',{name:'展开本轮过程',exact:true})).toHaveAttribute('aria-expanded','false');await liveChat.close();
 await page.goto('/?conversation='+f.id);await expect(page.locator('.message.text')).toHaveCount(0);await expect(page.locator('.turn-process > .explicit-progress').last()).toContainText('核对完成');
 await request.post('/__test__/live-output-update',{data:{id:f.id,stage:'done'}});
 await expect(page.locator('.message.text')).toContainText('核对完成，真实合计为 885。');await expect(page.getByRole('button',{name:'展开本轮过程',exact:true})).toHaveAttribute('aria-expanded','false');await page.screenshot({path:shots+'/chat-output-ended-light-1440.png',fullPage:true,animations:'disabled'});
 await page.goto('/tasks/'+f.task);await expect(summary).toContainText('历史输出');await expect(summary).toContainText('正在核对明细，并检查汇总差异');await expect(summary).not.toContainText('核对完成');
 const task=await(await request.get('/api/v2/tasks/'+f.task)).json();expect(task.task.state).toBe('todo');
});

test('keeps native commentary on cards while an explicitly tagged final answer streams, across compact themes and widths',async({page,request})=>{
 const f=await(await request.post('/__test__/live-output-fixture',{data:{tagged:true}})).json();
 await request.post('/__test__/live-output-update',{data:{id:f.id,stage:'chunk',tagged:true}});
 await request.post('/__test__/live-output-update',{data:{id:f.id,stage:'answer',tagged:true}});
 await page.goto('/?conversation='+f.id);await expect(page.locator('.message.text')).toContainText('核对完成');await expect(page.locator('.turn-process > .explicit-progress')).toHaveAttribute('aria-label','过程说明');
 mkdirSync(shots,{recursive:true});
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.evaluate(({key,value})=>{localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},{key:themeStorageKey,value:JSON.stringify({...defaultPreferences(),mode:theme})});await page.setViewportSize({width,height:960});
  await page.goto('/tasks?type=conversations');const card=page.locator('[data-conversation-id="'+f.id+'"]');
  await expect(card.locator('.explicit-progress')).toHaveAttribute('data-progress-source','commentary');await expect(card.locator('.explicit-progress')).toContainText('正在核对明细');await expect(card).not.toContainText('核对完成');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${shots}/cards-${theme}-${width}.png`,fullPage:true,animations:'disabled'});
  await page.goto('/tasks/'+f.task);await expect(page.getByRole('region',{name:'执行对话',exact:true}).locator('.progress-latest-summary .explicit-progress')).toHaveAttribute('aria-label','过程说明');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${shots}/task-${theme}-${width}.png`,fullPage:true,animations:'disabled'});
  await page.goto('/?conversation='+f.id);await expect(page.locator('.message.text')).toContainText('核对完成');await page.screenshot({path:`${shots}/chat-tagged-${theme}-${width}.png`,fullPage:true,animations:'disabled'});
 }
 await request.post('/__test__/live-output-update',{data:{id:f.id,stage:'done'}});
});
