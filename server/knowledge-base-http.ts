import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../shared/workspace-contracts';
import { DomainError } from '../shared/workspace-contracts';
import type { KnowledgeBase } from './knowledge-base';
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
export function createKnowledgeBaseHttp(service:KnowledgeBase,principal:Principal){
 return async(req:IncomingMessage,res:ServerResponse,url:URL,body:(req:IncomingMessage)=>Promise<any>)=>{
  if(!url.pathname.startsWith('/api/v2/knowledge-bases'))return false;
  try{
   if([...url.searchParams.keys()].some(key=>!['query','version'].includes(key)))throw new DomainError('invalid_wiki_input',422,'Invalid query');
   const parts=url.pathname.slice('/api/v2/knowledge-bases'.length).split('/').filter(Boolean).map(decodeURIComponent),[id,action,pageId]=parts;
   if(!id&&req.method==='GET')json(res,200,service.list(principal));
   else if(!id&&req.method==='POST')json(res,201,await service.create(principal,await body(req)));
   else if(parts.length===1&&req.method==='GET')json(res,200,service.get(principal,id));
   else if(parts.length===1&&req.method==='PUT')json(res,200,await service.configure(principal,id,await body(req)));
   else if(parts.length===2&&action==='sources'&&req.method==='POST')json(res,201,await service.addSource(principal,id,await body(req)));
   else if(parts.length===3&&action==='sources'&&req.method==='DELETE')json(res,200,await service.removeSource(principal,id,pageId));
   else if(parts.length===2&&action==='refresh'&&req.method==='POST')json(res,202,await service.refresh(principal,id));
   else if(parts.length===2&&action==='search'&&req.method==='GET')json(res,200,service.search(principal,id,url.searchParams.get('query')??''));
   else if(parts.length===2&&action==='versions'&&req.method==='GET')json(res,200,service.versions(principal,id));
   else if(parts.length===2&&action==='restore'&&req.method==='POST'){
    const data=await body(req);if(!data||Object.keys(data).some(key=>!['versionId','expectedHeadVersionId'].includes(key))||typeof data.versionId!=='string'||typeof data.expectedHeadVersionId!=='string')throw new DomainError('invalid_wiki_input',422,'Invalid restoration');json(res,200,await service.restore(principal,id,data.versionId,data.expectedHeadVersionId));
   }
   else if(parts.length===3&&action==='pages'&&req.method==='GET')json(res,200,service.readPage(principal,id,pageId,url.searchParams.get('version')??undefined));
   else if(parts.length===3&&action==='pages'&&req.method==='PUT')json(res,200,await service.editPage(principal,id,{...await body(req),pageId}));
   else json(res,404,{code:'not_found',error:'Wiki endpoint not found'});
  }catch(error){const domain=error instanceof DomainError?error:null;json(res,domain?.status??400,{code:domain?.code??'invalid_wiki_input',error:domain?.message??'Invalid Wiki request'});}return true;
 };
}
