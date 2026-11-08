import type {Page} from '@playwright/test';

/** The synthetic server shares a home across files. Restrict list data to this
 * scenario's genuine persisted IDs; preserve every state/relationship field and
 * leave all commands and detail readbacks on the real server. */
export async function isolateProgressLists(page:Page,fixture:Record<string,string>){
 const chats=new Set(Object.entries(fixture).filter(([key])=>!['task','longTitle'].includes(key)).map(([,id])=>id));
 await page.route(url=>url.pathname==='/api/v2/tasks',async route=>{
  if(route.request().method()!=='GET'||new URL(route.request().url()).pathname!=='/api/v2/tasks'){await route.continue();return;}
  const response=await route.fetch(),rows=await response.json();await route.fulfill({response,json:rows.filter((row:{id:string})=>row.id===fixture.task)});
 });
 await page.route('**/api/conversation-progress?*',async route=>{const response=await route.fetch(),rows=await response.json();await route.fulfill({response,json:rows.filter((row:{id:string})=>chats.has(row.id))});});
}

import {expect,type APIRequestContext} from '@playwright/test';
export async function acceptanceMessagePair(request:APIRequestContext,{busyTarget=false,policy='resume'}:{busyTarget?:boolean;policy?:'resume'|'notify'}={}){
 await request.post('/__test__/progress-fixture');
 const source=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-planner',workspaceId:null}})).json();
 const target=await(await request.post('/api/conversations',{data:{projectId:'progress-demo',agentId:'progress-reviewer',workspaceId:null}})).json();
 await request.post('/api/conversations/'+source.id+'/messages',{data:{text:'Prepare collaboration'}});
 await expect.poll(async()=>(await(await request.get('/api/conversations/'+source.id)).json()).conversation.status).toBe('idle');
 if(busyTarget)await request.post('/api/conversations/'+target.id+'/messages',{data:{text:'hold'}});
 const response=await request.post('/api/agent-messages',{data:{sourceConversationId:source.id,targetAgentId:'progress-reviewer',targetConversationId:target.id,text:'message-hold: controlled acceptance inquiry',policy,commandKey:crypto.randomUUID()}});expect(response.ok(),await response.text()).toBe(true);const message=await response.json();
 await expect.poll(async()=>(await(await request.get('/api/agent-messages/'+message.id)).json()).state).toBe(busyTarget?'queued':'running');
 return {source,target,message};
}
