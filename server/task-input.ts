import type {Config} from '../shared/types';
import {DomainError} from '../shared/workspace-contracts';
export function validateTaskConfiguration(config:Config,data:Record<string,unknown>) {
 const invalid=():never=>{throw new DomainError('invalid_task_request',422,'Unknown Task Project or Agent');};
 if(data.projectId!==undefined&&data.projectId!==null&&!config.projects.some(p=>p.id===data.projectId))invalid();
 if(data.assigneeAgentId!==undefined&&data.assigneeAgentId!==null&&!config.agents.some(a=>a.id===data.assigneeAgentId))invalid();
 if(data.participantAgentIds!==undefined&&(!Array.isArray(data.participantAgentIds)||data.participantAgentIds.some(id=>!config.agents.some(a=>a.id===id))))invalid();
}
