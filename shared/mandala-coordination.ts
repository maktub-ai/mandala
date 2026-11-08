import type {Task} from './tasks';
export type MandalaOwnership = {taskId:string;agentId:string;relation:'created'|'taken-over';conversationId:string;sourceEventId:number|null;invocationId:string;createdAt:string;blockedReason:string|null};
export type ManagedChange = {kind:'agent'|'project';action:'create'|'update'|'archive'|'promote';id?:string;values?:Record<string,unknown>};
export type ManagementProposal = {id:string;version:string;conversationId:string;change:ManagedChange;configRevision:string;status:'pending'|'applied'|'rejected'|'failed';createdAt:string;objectName?:string;unchanged?:boolean;summary?:{before:Record<string,string>;after:Record<string,string>};failure?:{code:string}};

// Display-only projection: connection credentials and native runtime values never enter a summary.
export function managedValueText(key:string,value:unknown):string{
 if(value===undefined||value===null)return '—';
 if(['mcp','skills','workspaces','resources'].includes(key))return Array.isArray(value)?value.map(item=>item&&typeof item==='object'?String(item.name??item.label??''):String(item)).filter(Boolean).join(' · '):'—';
 if(key==='runtime')return value&&typeof value==='object'?Object.entries(value).map(([runtime,settings])=>{
  const options=settings as Record<string,unknown>;
  return runtime+': '+JSON.stringify({...(options.approvalMode!==undefined?{approvalMode:options.approvalMode}:{}),...(options.fullAccess!==undefined?{fullAccess:options.fullAccess}:{}),...(options.gateway!==undefined?{gateway:options.gateway}:{}),...(Array.isArray(options.args)?{argumentCount:options.args.length}:{}),...(options.env&&typeof options.env==='object'?{environmentNames:Object.keys(options.env)}:{})});
 }).join('\n'):'—';
 if(key==='models')return value&&typeof value==='object'?Object.entries(value).map(([runtime,model])=>runtime+': '+String(model)).join(' · '):'—';
 if(Array.isArray(value))return String(value.length);
 return ['string','boolean','number'].includes(typeof value)?String(value):'—';
}
export type MandalaGoal = MandalaOwnership & {task:Task};

// Shared by validation and the coordinator's read-only management discovery.
export const managedChangeFields:Record<ManagedChange['kind'],string[]> = {
 agent:['id','name','instructions','maxParallel','defaultCli','models','mcp','skills','runtime','connectionIds','skillIds','disabledConnectionIds','disabledSkillIds','knowledgeIds','color','avatarSeed','icon','emoji','responseStyle'],
 project:['id','name','icon','emoji','cwd','workspaces','background','agentIds','resources','mcp','skills','connectionIds','skillIds','disabledConnectionIds','disabledSkillIds','knowledgeIds','color','avatarSeed'],
};
