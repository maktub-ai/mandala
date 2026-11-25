import {useEffect,useState} from 'react';
import {requestJson} from './api';

export default function useSummaryResource<T>(path:string,key:string,revision:number) {
 const [state,setState]=useState<{key:string;data:T|null;error:boolean}>({key,data:null,error:false});
 useEffect(()=>{
  const controller=new AbortController();let fetching=false;
  setState({key,data:null,error:false});
  const load=async()=>{if(fetching||document.hidden)return;fetching=true;try {const data=await requestJson<T>(path,{signal:controller.signal});if(!controller.signal.aborted)setState({key,data,error:false});}catch{if(!controller.signal.aborted)setState({key,data:null,error:true});}finally{fetching=false;}};
  void load();const timer=setInterval(()=>void load(),15000);const visible=()=>{if(!document.hidden)void load();};document.addEventListener('visibilitychange',visible);
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[path,key,revision]);
 return state.key===key?state:{key,data:null,error:false};
}
