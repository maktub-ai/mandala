// Only unresolved manual command identities. Never store request bodies here.
export type ScheduleCommandMap=Record<string,string>;
export type ScheduleCommandCheckpoints={version:1;identities:Record<string,ScheduleCommandMap>};
export const scheduleCheckpointPreference='mandala-schedule-command-checkpoints';
export function parseScheduleCommands(value:unknown):ScheduleCommandMap{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>256||Object.entries(value).some(([path,key])=>!/^\/automations\/[a-zA-Z0-9_-]+\/run$/.test(path)||typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(key)))throw Error('Manual request checkpoint is unreadable. Review run history before clearing browser data.');
 return value as ScheduleCommandMap;
}
export function parseScheduleCheckpoints(raw:string|undefined):ScheduleCommandCheckpoints{
 if(raw===undefined)return {version:1,identities:{}};
 if(raw.length>128*1024)throw Error('Manual request checkpoints exceed the storage limit.');
 const value=JSON.parse(raw);
 if(value?.version!==1||!value.identities||typeof value.identities!=='object'||Array.isArray(value.identities)||Object.keys(value.identities).length>64||Object.keys(value).some(key=>key!=='version'&&key!=='identities'))throw Error('Manual request checkpoints are unreadable.');
 let count=0;
 for(const [identity,commands] of Object.entries(value.identities)){
  if(!identity||identity.length>512)throw Error('Invalid manual request checkpoint identity.');
  count+=Object.keys(parseScheduleCommands(commands)).length;
 }
 if(count>256)throw Error('Review unresolved manual requests before starting another run.');
 return value;
}
