import type {APIRequestContext} from '@playwright/test';
import type {Config} from '../../../shared/types';

// Current main protects the primary identity even in isolated UI fixtures.
export async function putRuntimeConfig(request:APIRequestContext,config:Config){
 const current=await (await request.get('/api/config')).json();
 return request.put('/api/config',{data:{revision:current.revision,config:{...config,
  ...(current.config.mandala?{mandala:current.config.mandala}:{}),
  agents:[...config.agents,...current.config.agents.filter((agent:Config['agents'][number])=>agent.systemRole==='mandala'&&!config.agents.some(a=>a.id===agent.id))],
 }}});
}
