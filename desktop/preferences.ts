import {parseScheduleCheckpoints,scheduleCheckpointPreference} from '../shared/schedule-command-checkpoints';
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDevicePreferenceKey, type DevicePreferenceValues } from '../shared/device-preferences';
const maximumBytes=256*1024;
const legacyTaskView='mana-progress-view-v2';
export function readDesktopPreferences(home:string):DevicePreferenceValues {
 try {
  const path=join(home,'desktop-preferences.json');
  if(statSync(path).size>maximumBytes)throw Error('Invalid desktop preferences');
  const data=JSON.parse(readFileSync(path,'utf8'));
  if(data?.version!==1||!data.values||typeof data.values!=='object'||Array.isArray(data.values)||Object.entries(data.values).some(([key,value])=>(!isDevicePreferenceKey(key)&&key!==legacyTaskView)||typeof value!=='string'))throw Error('Invalid desktop preferences');
  if(data.values[scheduleCheckpointPreference]!==undefined)parseScheduleCheckpoints(data.values[scheduleCheckpointPreference]);
  // v2 was written only on user selection; the earlier key could contain an automatic default.
  // Keep the legacy key read-only. The next successful save writes the canonical view.
  const {[legacyTaskView]:oldView,...values}=data.values;
  if(oldView==='list'||oldView==='board')values['mana-progress-view']=oldView;
  return values;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
}
export function writeDesktopPreference(home:string,key:unknown,value:unknown):void {
 if(!isDevicePreferenceKey(key)||typeof value!=='string')throw Error('Invalid desktop preference');
 if(key===scheduleCheckpointPreference)parseScheduleCheckpoints(value);
 if(Buffer.byteLength(value)>maximumBytes)throw Error('Desktop preferences too large');
 const values=readDesktopPreferences(home);values[key]=value;
 const raw=JSON.stringify({version:1,values});if(Buffer.byteLength(raw)>maximumBytes)throw Error('Desktop preferences too large');
 const path=join(home,'desktop-preferences.json'),temporary=path+'.tmp';
 writeFileSync(temporary,raw,{mode:0o600});renameSync(temporary,path);
}
