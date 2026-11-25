import type {Config} from '../shared/types';

export function enabledBlueprints(config:Config){
 return new Map(config.projects.flatMap(project=>!project.archivedAt&&project.planId&&(project.blueprintEnabled??config.blueprintDefaultEnabled??false)?[[project.id,project.planId] as const]:[]));
}
// The synchronous acceptance transaction snapshots the last published config without doing filesystem I/O.
const snapshots=new Map<string,{revision:string;plans:Map<string,string>;members:Map<string,Set<string>>;system:string|undefined}>();
export const blueprintBindings=(home:string)=>snapshots.get(home);
export function publishBlueprintBindings(home:string,revision:string,config:Config){
 if(snapshots.get(home)?.revision===revision)return;
 const plans=enabledBlueprints(config),active=new Set(config.agents.filter(a=>!a.archivedAt).map(a=>a.id));
 const members=new Map(config.projects.filter(p=>plans.has(p.id)).map(p=>[p.id,new Set(p.agentIds.filter(id=>active.has(id)))]));
 const system=config.agents.find(a=>!a.archivedAt&&a.systemRole==='mandala'&&a.id===config.mandala?.agentId)?.id;
 snapshots.set(home,{revision,plans,members,system});
}

export function canPublishBlueprint(home:string,project:string,agent:string,explicit:boolean){
 const scope=snapshots.get(home);
 return !!scope?.plans.has(project)&&(scope.members.get(project)?.has(agent)===true||explicit&&(!agent||agent===scope.system));
}
