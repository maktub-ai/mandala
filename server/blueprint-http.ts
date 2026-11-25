import type {IncomingMessage,ServerResponse} from 'node:http';
import {DomainError} from '../shared/workspace-contracts';
import {createBlueprintService} from './blueprint';
import {migrateLegacyBlueprint} from './blueprint-migration';

export function createBlueprintHttp(home:string,service=createBlueprintService(home)) {
 return async(req:IncomingMessage,res:ServerResponse,url:URL,body:()=>Promise<unknown>)=>{
  const match=/^\/api\/projects\/([^/]+)\/blueprint(\/modules)?$/.exec(url.pathname);
  if(!match)return false;
  const id=decodeURIComponent(match[1]),invalid=()=>new DomainError('invalid_blueprint',422,'Invalid blueprint request');
  let result:unknown;
  if(req.method==='GET'){
   if(match[2]){
    const lane=url.searchParams.get('lane');if(!lane)throw invalid();
    result=await service.queryModule(id,lane);
   }else result=await service.state(id);
  }else if(req.method==='POST'&&!match[2]){
   const input=await body();
   if(!input||typeof input!=='object'||Array.isArray(input))throw invalid();
   const data=input as Record<string,unknown>;
   const allowed=data.action==='bind'?['action','planId']:data.action==='confirm'?['action','draftId','modules']:['action'];
   if(Object.keys(data).some(key=>!allowed.includes(key)))throw invalid();
   switch(data.action){
    case 'enable':result=await service.enable(id);break;
    case 'disable':result=await service.disable(id);break;
    case 'draft':result=await service.draft(id);break;
    case 'bind':if(typeof data.planId!=='string')throw invalid();result=await service.bind(id,data.planId);break;
    case 'confirm':if(typeof data.draftId!=='string'||!Array.isArray(data.modules))throw invalid();result=await service.confirm(id,data.draftId,data.modules);break;
    default:throw invalid();
   }
   if(data.action==='bind'||data.action==='confirm'||data.action==='enable')await migrateLegacyBlueprint(home);
  }else throw new DomainError('method_not_allowed',405,'Unsupported blueprint operation');
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return true;
 };
}
