import {expect,type APIRequestContext,type APIResponse} from '@playwright/test';
export async function createTaskWithExecutionChats(request:APIRequestContext,options:Parameters<APIRequestContext['post']>[1],conversationIds:string[]):Promise<APIResponse>{
 let response=await request.post('/api/v2/tasks',options);expect(response.ok(),await response.text()).toBe(true);
 let task=await response.json();
 for(const conversationId of conversationIds){response=await request.post('/api/v2/tasks/'+task.id+'/executions',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{conversationId,expectedRevision:task.revision}});expect(response.ok(),await response.text()).toBe(true);task=await response.json();}
 return response;
}
export async function executionAgent(request:APIRequestContext,id='execution-fixture-agent'){
 const {config,revision}=await(await request.get('/api/config')).json();
 if(!config.agents.some((agent:{id:string})=>agent.id===id)){const response=await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,{id,name:'Execution fixture Agent',defaultCli:'codex',models:{},instructions:'Synthetic execution',mcp:[],skills:[]}]}}});expect(response.ok(),await response.text()).toBe(true);}
 return id;
}
