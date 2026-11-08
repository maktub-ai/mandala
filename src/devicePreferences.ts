import { devicePreferenceKeys, isDevicePreferenceKey, type DevicePreferenceValues } from '../shared/device-preferences';
type BrowserStorage=Pick<Storage,'getItem'|'setItem'>;
export type NativePreferences={read:()=>DevicePreferenceValues;write:(key:string,value:string)=>void};
export function createDevicePreferences(storage:BrowserStorage,native?:NativePreferences,onFailure?:(failed:boolean)=>void) {
 let snapshot:DevicePreferenceValues|undefined;
 const pending=new Map<string,string>();
 const check=(key:string)=>{if(!isDevicePreferenceKey(key))throw Error('Unknown device preference');return key;};
 const legacy=(key:string)=>{try{return storage.getItem(key);}catch{return null;}};
 const persist=(key:string,value:string)=>{
  try{
   if(native)native.write(key,value);else storage.setItem(key,value);
   pending.delete(key);if(snapshot)snapshot[check(key)]=value;
   if(native)try{storage.setItem(key,value);}catch{/* The native save already succeeded. */}
   onFailure?.(pending.size>0);
  }catch(error){
   pending.set(key,value);
   if(native)try{storage.setItem(key,value);}catch{/* Keep the in-memory choice for retry. */}
   if(onFailure)onFailure(true);else throw error;
  }
 };
 return {
  getItem(name:string){
   const key=check(name);if(pending.has(key))return pending.get(key)!;
   if(!native)return legacy(key);
   try {
    if(!snapshot){
     snapshot=native.read();
     // Migrate lazy-page choices before the old origin disappears, not only keys read by this page.
     for(const candidate of devicePreferenceKeys)if(snapshot[candidate]===undefined){
      const value=legacy(candidate);if(value!==null)try{persist(candidate,value);}catch{/* Return readable legacy choices when migration fails. */}
     }
    }
   }catch{return legacy(key);}
   return pending.get(key)??snapshot[key]??legacy(key);
  },
  setItem(name:string,value:string){
   const key=check(name);
   persist(key,value);
  },
  retry(){for(const [key,value] of [...pending])persist(key,value);},
 };
}
let failed=false;
const listeners=new Set<()=>void>();
let notificationQueued=false;
const report=(value:boolean)=>{
 if(failed===value)return;failed=value;
 if(!notificationQueued){notificationQueued=true;queueMicrotask(()=>{notificationQueued=false;for(const listener of listeners)listener();});}
};
export const subscribePreferenceStatus=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const preferenceSaveFailed=()=>failed;
let current:ReturnType<typeof createDevicePreferences>|undefined;
const instance=()=>current??=createDevicePreferences({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},typeof window==='undefined'?undefined:(window as Window&{mandalaDesktop?:{preferences?:NativePreferences}}).mandalaDesktop?.preferences,report);
export const devicePreferences:BrowserStorage={getItem:key=>instance().getItem(key),setItem:(key,value)=>instance().setItem(key,value)};
export const retryDevicePreferences=()=>instance().retry();
