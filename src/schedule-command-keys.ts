import {parseScheduleCommands,parseScheduleCheckpoints,scheduleCheckpointPreference,type ScheduleCommandMap} from '../shared/schedule-command-checkpoints';
import type {NativePreferences} from './devicePreferences';
// The native HOME store survives runtime port changes. Browser-only checkpoints
// remain scoped to the current origin and authenticated identity.
const storageKey=(identity:string)=>'mandala-schedule-commands:'+encodeURIComponent(identity);
const nativeStore=()=>typeof window==='undefined'?undefined:(window as Window&{mandalaDesktop?:{preferences?:NativePreferences}}).mandalaDesktop?.preferences;
function browserRead(identity:string){const raw=localStorage.getItem(storageKey(identity));return raw===null?{}:parseScheduleCommands(JSON.parse(raw));}
function read(identity:string):ScheduleCommandMap{
 if(!identity||identity.length>512)throw Error('Invalid manual request checkpoint identity.');
 const native=nativeStore();if(!native)return browserRead(identity);
 // Never silently fall back when the stable store cannot be read or migrated.
 const document=parseScheduleCheckpoints(native.read()[scheduleCheckpointPreference]);
 if(Object.hasOwn(document.identities,identity))return document.identities[identity];
 const legacy=browserRead(identity);
 const raw=JSON.stringify({...document,identities:{...document.identities,[identity]:legacy}});parseScheduleCheckpoints(raw);native.write(scheduleCheckpointPreference,raw);
 return legacy;
}
function write(identity:string,commands:ScheduleCommandMap){
 const native=nativeStore();
 if(native){
  const document=parseScheduleCheckpoints(native.read()[scheduleCheckpointPreference]);
  const raw=JSON.stringify({...document,identities:{...document.identities,[identity]:commands}});
  parseScheduleCheckpoints(raw);native.write(scheduleCheckpointPreference,raw);
  try{localStorage.setItem(storageKey(identity),JSON.stringify(commands));}catch{/* Stable native write already succeeded. */}
 }else localStorage.setItem(storageKey(identity),JSON.stringify(commands));
}
export function scheduleCommandKey(identity:string,path:string){
 const values=read(identity);if(values[path])return values[path];
 if(Object.keys(values).length>=256)throw Error('Review unresolved manual requests before starting another run.');
 const key=crypto.randomUUID();write(identity,parseScheduleCommands({...values,[path]:key}));return key;
}
export const pendingScheduleCommands=read;
export function confirmScheduleCommand(identity:string,path:string,key:string){
 const values=read(identity);if(values[path]!==key)return;const next={...values};delete next[path];write(identity,next);
}
