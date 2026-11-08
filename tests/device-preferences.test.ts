import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createDevicePreferences} from '../src/devicePreferences';
import {readDesktopPreferences,writeDesktopPreference} from '../desktop/preferences';
import {devicePreferenceKeys} from '../shared/device-preferences';
const homes:string[]=[];afterEach(()=>homes.splice(0).forEach(home=>rmSync(home,{recursive:true,force:true})));
const browser=(initial:Record<string,string>={})=>{const values={...initial};return {getItem:(key:string)=>values[key]??null,setItem:(key:string,value:string)=>{values[key]=value;},removeItem:(key:string)=>{delete values[key];}};};
test('preserves the retired sidebar preference when saving existing settings',()=>{
 const home=mkdtempSync(join(tmpdir(),'device-prefs-'));homes.push(home);
 writeFileSync(join(home,'desktop-preferences.json'),JSON.stringify({version:1,values:{'mana-sidebar-more':'false','mana-language':'en'}}));
 expect(readDesktopPreferences(home)['mana-language']).toBe('en');
 writeDesktopPreference(home,'mana-language','zh-CN');
 expect(JSON.parse(readFileSync(join(home,'desktop-preferences.json'),'utf8')).values).toEqual({'mana-sidebar-more':'false','mana-language':'zh-CN'});
});
test('every allowed UI preference survives a new origin and a new adapter',()=>{
 const home=mkdtempSync(join(tmpdir(),'device-prefs-'));homes.push(home);
 const native={read:()=>readDesktopPreferences(home),write:(key:string,value:string|null)=>writeDesktopPreference(home,key,value)};
 const first=createDevicePreferences(browser(),native);
 for(const key of devicePreferenceKeys)first.setItem(key,key==='mandala-schedule-command-checkpoints'?'{"version":1,"identities":{}}':'synthetic-'+key);
 const next=createDevicePreferences(browser({'mana-language':'wrong-origin'}),native);
 for(const key of devicePreferenceKeys)expect(next.getItem(key)).toBe(key==='mandala-schedule-command-checkpoints'?'{"version":1,"identities":{}}':'synthetic-'+key);
 const saved=readFileSync(join(home,'desktop-preferences.json'),'utf8');
 for(const key of ['local-access.key','mandala-host-key:private','__proto__'])expect(()=>writeDesktopPreference(home,key,'secret')).toThrow();
 expect(()=>writeDesktopPreference(home,'mana-language','x'.repeat(256*1024))).toThrow();
 expect(readFileSync(join(home,'desktop-preferences.json'),'utf8')).toBe(saved);
 if(process.platform!=='win32')expect(statSync(join(home,'desktop-preferences.json')).mode&0o777).toBe(0o600);
});
test('migrates only missing legacy values and does not overwrite native choices',()=>{
 const values:Record<string,string>={'mana-language':'zh-CN'};const writes:string[]=[];
 const storage=createDevicePreferences(browser({'mana-language':'en','mana-progress-view':'list'}),{read:()=>({...values}),write:(key,value)=>{writes.push(key);if(value!==null)values[key]=value;}});
 expect(storage.getItem('mana-language')).toBe('zh-CN');expect(storage.getItem('mana-progress-view')).toBe('list');expect(writes).toEqual(['mana-progress-view']);
});
test('blocked cache does not hide native values; migration failures keep readable legacy values',()=>{
 const blocked={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');},removeItem:()=>{throw Error('blocked');}};
 const native=createDevicePreferences(blocked,{read:()=>({'mana-language':'zh-CN'}),write:()=>{}});expect(native.getItem('mana-language')).toBe('zh-CN');expect(()=>native.setItem('mana-language','en')).not.toThrow();
 let writes=0;const fallback=createDevicePreferences(browser({'mana-language':'zh-CN'}),{read:()=>{throw Error('unreadable');},write:()=>{writes++;}});
 expect(fallback.getItem('mana-language')).toBe('zh-CN');expect(writes).toBe(0);
 const failed=createDevicePreferences(browser({'mana-language':'zh-CN'}),{read:()=>({}),write:()=>{throw Error('full');}});expect(failed.getItem('mana-language')).toBe('zh-CN');expect(()=>failed.setItem('mana-language','en')).toThrow();expect(failed.getItem('mana-language')).toBe('en');
});
test('does not overwrite a corrupt preference document',()=>{
 const home=mkdtempSync(join(tmpdir(),'device-prefs-'));homes.push(home);writeFileSync(join(home,'desktop-preferences.json'),'{broken');expect(()=>writeDesktopPreference(home,'mana-language','en')).toThrow();expect(readFileSync(join(home,'desktop-preferences.json'),'utf8')).toBe('{broken');
});


test('first native read migrates every missing allowlisted preference, including unopened pages',()=>{
 const values:Record<string,string>={};const native={read:()=>({...values}),write:(key:string,value:string)=>{values[key]=value;}};
 const first=createDevicePreferences(browser({'mana-language':'zh-CN','mana-progress-view':'list','mana-team-view-v2':'agents','mana-command-history':'["tasks"]'}),native);
 expect(first.getItem('mana-language')).toBe('zh-CN');
 const next=createDevicePreferences(browser(),native);
 expect(next.getItem('mana-progress-view')).toBe('list');expect(next.getItem('mana-team-view-v2')).toBe('agents');expect(next.getItem('mana-command-history')).toBe('["tasks"]');
});
test('optional mounted preferences keep working during native failure and retry pending choices',()=>{
 let unavailable=true;const values:Record<string,string>={},status:boolean[]=[];
 const preferences=createDevicePreferences(browser({'mana-language':'zh-CN'}),{read:()=>{if(unavailable)throw Error('unreadable');return {...values};},write:(key,value)=>{if(unavailable)throw Error('unwritable');values[key]=value;}},failed=>status.push(failed));
 expect(preferences.getItem('mana-language')).toBe('zh-CN');expect(()=>preferences.setItem('mana-language','en')).not.toThrow();expect(preferences.getItem('mana-language')).toBe('en');expect(status.at(-1)).toBe(true);
 unavailable=false;preferences.retry();expect(values['mana-language']).toBe('en');expect(status.at(-1)).toBe(false);
});

test('native manual checkpoints reject bodies, malformed identities and unbounded commands',()=>{
 const home=mkdtempSync(join(tmpdir(),'device-prefs-'));homes.push(home);const key='mandala-schedule-command-checkpoints';
 for(const value of ['broken',JSON.stringify({version:1,identities:{owner:{'/automations/a/run':{key:'safe',instructions:'private'}}}}),JSON.stringify({version:1,identities:{},body:'private'}),JSON.stringify({version:1,identities:{['x'.repeat(513)]:{}}}),JSON.stringify({version:1,identities:{owner:Object.fromEntries(Array.from({length:257},(_,i)=>['/automations/rule-'+i+'/run','key-'+i]))}})])expect(()=>writeDesktopPreference(home,key,value)).toThrow();
 writeDesktopPreference(home,key,JSON.stringify({version:1,identities:{owner:{'/automations/a/run':'same-key'}}}));expect(readDesktopPreferences(home)[key]).toContain('same-key');
});
