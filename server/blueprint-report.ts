import type {BlueprintRecord,BlueprintSummary,BlueprintModule} from '../shared/blueprint';
import type {Task} from '../shared/tasks';
import type {Config,Conversation} from '../shared/types';
import {enabledBlueprints} from './blueprint-bindings';
import {isSystemAgent} from './conversation-context';
import {DomainError} from '../shared/workspace-contracts';

export function mayReadBlueprint(config:Config,chat:Pick<Conversation,'projectId'|'agentId'>,projectId:string){
 const project=config.projects.find(p=>p.id===projectId&&!p.archivedAt);
 if(!project||!(project.blueprintEnabled??config.blueprintDefaultEnabled??false))return false;
 const active=config.agents.some(a=>a.id===chat.agentId&&!a.archivedAt);
 return active&&project.agentIds.includes(chat.agentId)||projectId===chat.projectId&&(!chat.agentId||active&&isSystemAgent(config,chat.agentId));
}
export function readableBlueprints(config:Config,chat:Pick<Conversation,'projectId'|'agentId'>){
 return new Map([...enabledBlueprints(config)].filter(([id])=>mayReadBlueprint(config,chat,id)));
}

type Reader={readSummary:(id:string,planId?:string)=>Promise<BlueprintSummary>; queryModule:(id:string,lane:string,planId?:string)=>Promise<BlueprintModule>};
export async function taskBlueprintFacts(task:Pick<Task,'id'|'projectIds'|'moduleRef'>,readable:Map<string,string>,reader:Reader,recordIds:(id:string,plan:string)=>Set<string>){
 const facts=[];
 for(const projectId of task.projectIds){
  const planId=readable.get(projectId);if(!planId)continue;
  const path='/projects/'+encodeURIComponent(projectId)+'/blueprint',lane=task.moduleRef?.projectId===projectId?task.moduleRef.lane:undefined;
  try{
   const summary=await reader.readSummary(projectId,planId);
   const detail=lane&&summary.modules.some(m=>m.lane===lane)?await reader.queryModule(projectId,lane,planId):null;
   const own=recordIds(task.id,planId);
   const evidence=(record:BlueprintRecord)=>({title:record.title,result:record.result.slice(0,2400),decisions:record.decisions.slice(0,6),lanes:record.lanes,at:record.at,source:own.has(record.id)?'accepted-task':'project',href:path+'?'+new URLSearchParams({...(lane?{lane}:{}),record:record.id})});
   const records=[...new Map([...summary.records.filter(r=>own.has(r.id)),...(detail?.records??summary.records)].map(r=>[r.id,r])).values()].slice(0,8).map(evidence);
   facts.push({projectId,title:summary.title,modules:(detail?[detail]:summary.modules).slice(0,50).map(m=>({lane:m.lane,status:m.status,href:path+'?'+new URLSearchParams({lane:m.lane})})),records});
  }catch(error){
   if(error instanceof DomainError&&[403,404,409].includes(error.status))continue;
   facts.push({projectId,status:'unavailable' as const,records:[]});
  }
 }
 return facts;
}
