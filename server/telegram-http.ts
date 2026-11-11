import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError } from '../shared/workspace-contracts';
import type { createTelegramService } from './telegram';

export const telegramPath='/api/mandala/telegram';
const invalid=()=>new DomainError('telegram_invalid',422,'Telegram 请求参数无效。');
export async function handleTelegramRequest(service:ReturnType<typeof createTelegramService>,req:IncomingMessage,res:ServerResponse,url:URL,body:()=>Promise<unknown>,
  json:(res:ServerResponse,status:number,data:unknown)=>void) {
  const path=url.pathname.slice(telegramPath.length),method=req.method;
  const field=async(name:string)=>{
    const value=await body();
    if(!value||typeof value!=='object'||Object.keys(value).length!==1||!Object.hasOwn(value,name)) throw invalid();
    return (value as Record<string,unknown>)[name];
  };
  try {
    if(url.search) throw invalid();
    if(path===''&&method==='GET') return json(res,200,service.status());
    if(path===''&&method==='DELETE') return json(res,200,service.unlink());
    if(path==='/configure'&&method==='POST') return json(res,200,await service.configure(await field('token')));
    if(path==='/pair'&&method==='POST') return json(res,200,service.pair());
    if(path==='/confirm'&&method==='POST') return json(res,200,service.confirm(await field('userId')));
    if(path==='/test'&&method==='POST') return json(res,200,await service.test());
    if(path==='/notifications'&&method==='PATCH') return json(res,200,service.notifications(await field('attention')));
    return json(res,404,{error:'Telegram 操作不存在。'});
  } catch(error) {
    if(error instanceof DomainError&&error.code.startsWith('telegram_')) return json(res,error.status,{error:error.message});
    if(error instanceof Error&&/^(invalid content type|invalid request size|invalid JSON)$/.test(error.message))
      return json(res,422,{error:'Telegram 请求参数无效。'});
    return json(res,500,{error:'暂时无法更新 Telegram 设置。'});
  }
}
