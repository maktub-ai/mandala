import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteKey } from '../shared/remote-crypto';
import { createRemoteStorage, type RemoteDraft } from './remote-storage';
import { migrateRemoteComposerDrafts } from './composer-drafts';
import { remoteComposerCodec } from './remote-composer-cache';

export function useRemoteOffline(account:string,device:string,host:string,identity:RemoteKey,denied:boolean) {
  const scope=useMemo(()=>[location.origin,account,device,host],[account,device,host]);
  const scopeId=JSON.stringify([...scope,identity.publicKey]);
  const storage=useMemo(()=>{try{return createRemoteStorage(localStorage,scope,identity);}catch{return undefined;}},[scope,identity]);
  const [editor,setEditor]=useState<'acquiring'|'owned'|'other'|'unsupported'>('acquiring');
  const owned=useRef(false),revoked=useRef(denied);revoked.current=denied;
  const ownsEditor=useCallback(()=>owned.current&&!revoked.current,[]);
  const codec=useMemo(()=>remoteComposerCodec(identity,scopeId,ownsEditor),[scopeId,identity,ownsEditor]);
  const [errors,setErrors]=useState<Record<string,string>>({});
  const report=useCallback((id:string,problem?:unknown)=>setErrors(old=>{
    if(problem===undefined){if(!Object.hasOwn(old,id))return old;const rest={...old};delete rest[id];return rest;}
    const message=problem instanceof Error?problem.message:String(problem);
    return old[id]===message?old:{...old,[id]:message};
  }),[]);
  const [enabled,setEnabled]=useState(false),[revision,setRevision]=useState(0);
  const [task,setTask]=useState<RemoteDraft>({text:''}),[taskReadable,setTaskReadable]=useState(false);
  const taskRef=useRef(task);taskRef.current=task;
  const stored=useRef(new Map<string,{json:string;at:number}>());
  useEffect(()=>{
    if(denied)return;
    let active=true,release:(()=>void)|undefined;
    function settings(){
      try{setEnabled(storage?.cacheEnabled()??false);report('cache');}
      catch(reason){setEnabled(false);report('cache',reason);}
      setRevision(v=>v+1);
    }
    const onStorage=(event:StorageEvent)=>{if(!event.key||event.key.includes(':cache-enabled:'))settings();};
    const expire=()=>{if(document.hidden)return;try{storage?.pruneCache();}catch(reason){report('cache',reason);}setRevision(v=>v+1);};
    settings();expire();document.addEventListener('visibilitychange',expire);window.addEventListener('storage',onStorage);
    const timer=setInterval(expire,3_600_000);
    if(navigator.locks&&storage){
      void navigator.locks.request('mandala-draft-editor:'+JSON.stringify([account,device,host,identity.publicKey]),{ifAvailable:true},async lock=>{
        if(!active)return;
        if(!lock){
          try{setTask(storage.readDraft('$task')??{text:''});report('task');}catch(reason){report('task',reason);}
          setEditor('other');return;
        }
        owned.current=true;
        try {
          await migrateRemoteComposerDrafts(scopeId,codec);
          if(!active)return;
          try{setTask(storage.readDraft('$task')??{text:''});setTaskReadable(true);report('task');}
          catch(reason){setTaskReadable(false);report('task',reason);}
          setEditor('owned');
          await new Promise<void>(resolve=>{release=resolve;});
        } finally {owned.current=false;}
      }).catch(reason=>{if(active){setEditor('unsupported');report('editor',reason);}});
    }else setEditor('unsupported');
    return ()=>{active=false;owned.current=false;release?.();clearInterval(timer);document.removeEventListener('visibilitychange',expire);window.removeEventListener('storage',onStorage);};
  },[account,device,host,scopeId,identity,storage,codec,denied,report]);
  const saveTask=(value:RemoteDraft,strict=false)=>{
    if(!ownsEditor()||!storage||!taskReadable)throw Error('Local draft editor unavailable');
    try{storage.saveDraft('$task',value);report('task');}
    catch(reason){report('task',reason);if(strict)throw reason;}
    taskRef.current=value;setTask(value);
  };
  const changeCache=(next:boolean)=>{
    if(!ownsEditor()||!storage)return;
    try{storage.setCacheEnabled(next);stored.current.clear();setEnabled(next);setRevision(v=>v+1);report('cache');}
    catch(reason){report('cache',reason);}
  };
  const cache=useCallback((id:string,value:unknown)=>{
    if(!ownsEditor()||!enabled||!storage)return;
    try{
      const json=JSON.stringify(value),prev=stored.current.get(id);
      if(prev?.json===json&&Date.now()-prev.at<3_600_000)return;
      storage.saveCache(id,value);stored.current.set(id,{json,at:Date.now()});report('cache');
    }catch(reason){report('cache',reason);}
  },[enabled,ownsEditor,storage,report]);
  const read=useCallback(<T,>(id:string)=>{
    if(denied||!enabled)return;
    try{return storage?.readCache<T>(id);}
    catch{return undefined;}
  },[denied,enabled,storage,revision]);
  const forget=useCallback((id:string)=>{
    stored.current.delete(id);
    try{storage?.removeCache(id);}catch(reason){report('cache',reason);}
    setRevision(v=>v+1);
  },[storage,report]);
  const revoke=()=>{
    revoked.current=true;stored.current.clear();setTask({text:''});setTaskReadable(false);setEditor('acquiring');
    try{storage?.setCacheEnabled(false);}catch(reason){report('cache',reason);}
    setEnabled(false);setRevision(v=>v+1);
  };
  const refreshRead=useCallback(()=>setRevision(v=>v+1),[]);
  return {refreshRead,scopeId,editor,ownsEditor,codec,editable:editor==='owned'&&!denied,errors,enabled,task,taskRef,taskReadable,saveTask,changeCache,cache,read,forget,revoke};
}
