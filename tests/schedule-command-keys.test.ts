import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readDesktopPreferences,writeDesktopPreference} from '../desktop/preferences';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {confirmScheduleCommand,pendingScheduleCommands,scheduleCommandKey} from '../src/schedule-command-keys';
let records:Map<string,string>;
beforeEach(()=>{records=new Map();vi.stubGlobal('localStorage',{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>records.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());
it('retains pending keys across reload reads and isolates authenticated identities',()=>{
 const path='/automations/rule-a/run',key=scheduleCommandKey('owner/device-a',path);
 expect(pendingScheduleCommands('owner/device-a')[path]).toBe(key);
 expect(scheduleCommandKey('owner/device-a',path)).toBe(key);
 expect(scheduleCommandKey('owner/device-b',path)).not.toBe(key);
});
it('a late confirmation cannot delete a newer request checkpoint',()=>{
 const path='/automations/rule-a/run',first=scheduleCommandKey('owner',path);
 confirmScheduleCommand('owner',path,first);const second=scheduleCommandKey('owner',path);
 confirmScheduleCommand('owner',path,first);
 expect(pendingScheduleCommands('owner')[path]).toBe(second);
 confirmScheduleCommand('owner',path,second);expect(pendingScheduleCommands('owner')[path]).toBeUndefined();
});
it('does not generate a replacement key when the checkpoint is malformed or cannot be saved',()=>{
 records.set('mandala-schedule-commands:owner','corrupt');expect(()=>scheduleCommandKey('owner','/automations/rule/run')).toThrow();
 records.clear();vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw Error('Storage unavailable');}});
 expect(()=>scheduleCommandKey('owner','/automations/rule/run')).toThrow('Storage unavailable');
});
it('native checkpoints retain exact keys across new browser origins and migrate legacy keys once',()=>{
 const values:Record<string,string>={};const native={read:()=>({...values}),write:(key:string,value:string)=>{values[key]=value;}};
 vi.stubGlobal('window',{mandalaDesktop:{preferences:native}});
 const path='/automations/restart-rule/run';records.set('mandala-schedule-commands:owner','{"/automations/restart-rule/run":"legacy-request"}');
 expect(scheduleCommandKey('owner',path)).toBe('legacy-request');
 records=new Map();expect(scheduleCommandKey('owner',path)).toBe('legacy-request');expect(scheduleCommandKey('other-owner',path)).not.toBe('legacy-request');
 confirmScheduleCommand('owner',path,'legacy-request');records.set('mandala-schedule-commands:owner','{"/automations/restart-rule/run":"legacy-request"}');expect(pendingScheduleCommands('owner')).toEqual({});
});
it('native read/write failures never fall back to a new origin-local key',()=>{
 vi.stubGlobal('window',{mandalaDesktop:{preferences:{read:()=>{throw Error('Native unavailable');},write:()=>{}}}});expect(()=>scheduleCommandKey('owner','/automations/restart-rule/run')).toThrow('Native unavailable');
 vi.stubGlobal('window',{mandalaDesktop:{preferences:{read:()=>({}),write:()=>{throw Error('Native full');}}}});expect(()=>scheduleCommandKey('owner','/automations/restart-rule/run')).toThrow('Native full');expect(records.size).toBe(0);
});

it('native HOME file retains only identity/path/key across new adapters',()=>{
 const home=mkdtempSync(join(tmpdir(),'schedule-checkpoint-'));
 try{
  const bridge=()=>({read:()=>readDesktopPreferences(home),write:(key:string,value:string)=>writeDesktopPreference(home,key,value)});
  vi.stubGlobal('window',{mandalaDesktop:{preferences:bridge()}});const path='/automations/restart-rule/run',key=scheduleCommandKey('authenticated-owner',path);
  records=new Map();vi.stubGlobal('window',{mandalaDesktop:{preferences:bridge()}});expect(scheduleCommandKey('authenticated-owner',path)).toBe(key);const raw=readFileSync(join(home,'desktop-preferences.json'),'utf8');expect(raw).toContain(key);expect(raw).not.toContain('instructions');expect(raw).not.toContain('attachments');
 }finally{rmSync(home,{recursive:true,force:true});}
});
