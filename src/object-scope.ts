import type {Task} from '../shared/tasks';
import type {MemoryCollection, MemoryRevision} from '../shared/memory';

export const taskMatchesAgent=(task:Task,agentId:string)=>task.assigneeAgentId===agentId||task.participantAgentIds.includes(agentId);
export const memoryMatchesAgent=(record:MemoryRevision,collections:MemoryCollection[],agentId:string)=>!!record.sourceAgentIds?.includes(agentId)||collections.find(collection=>collection.id===record.collectionId)?.agentId===agentId;
export const memoryGroup=(record:MemoryRevision):'facts'|'context'|'sessions'|'scenes'=>record.layer==='L1'?'facts':record.layer==='L3'?'context':record.semanticKey==='session.context'||record.verification==='stage_summary'||!record.semanticKey?.startsWith('scene.')&&record.pipelines?.includes('session')?'sessions':'scenes';
