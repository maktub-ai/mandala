import {requestJson} from './api';

/** Telegram connection changes use the authenticated local owner's CSRF token. */
export async function telegramRequest<T>(path='',method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
 const headers:Record<string,string>={};
 if(method!=='GET'){
  const session=await requestJson<{csrfToken?:string}>('/auth/session',{signal},15000);
  headers['X-CSRF-Token']=session.csrfToken??'';
 }
 if(body!==undefined)headers['Content-Type']='application/json';
 return requestJson<T>('/api/mandala/telegram'+path,{method,headers,signal,...body===undefined?{}:{body:JSON.stringify(body)}},20000);
}
