import { workspacePrincipal } from './workspace-identity';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError } from '../shared/workspace-contracts';
import type { MemoryStatus, MemorySourceSummary } from '../shared/memory';
import type { MemoryRuntime } from './memory-runtime';
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const invalid=()=>new DomainError('invalid_request',422,'Invalid memory request');
const fields=(value:any,allowed:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw invalid();};
const id=(value:unknown)=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw invalid();return value;};
const statuses=['proposed','active','superseded','retracted','expired','stale'];
export function createMemoryHttp(runtime?:MemoryRuntime){
 return async(req:IncomingMessage,res:ServerResponse,url:URL,body:(req:IncomingMessage)=>Promise<any>):Promise<boolean>=>{
  if(!url.pathname.startsWith('/api/v2/memory/'))return false;
  try {
   if(!runtime)throw new DomainError('memory_unavailable',503,'Memory unavailable');
   const {memory,recall,jobs}=runtime,p=workspacePrincipal(memory.store),parts=url.pathname.slice('/api/v2/memory/'.length).split('/'),method=req.method;
   const query=Object.fromEntries(url.searchParams);
   if([...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1))throw invalid();
   fields(query,parts[0]==='records'&&parts.length===1?['projectId','taskId','conversationId','status']:[]);
   for(const key of ['projectId','taskId','conversationId'])if(query[key]!==undefined&&query[key]!=='')id(query[key]);
   if(query.status&&!statuses.includes(query.status))throw invalid();
   if(parts[0]==='records'&&parts.length===1&&method==='GET') {
    const filter={...(query.taskId?{taskId:query.taskId}:{}),...(query.conversationId?{conversationId:query.conversationId}:{}),...(query.status?{status:query.status as MemoryStatus}:{})};
    const index=memory.withAuthorityQuery(()=>{
     const records=query.projectId===undefined?memory.listAll(p,filter):memory.list(p,{...filter,projectId:query.projectId||null});
     const sources:MemorySourceSummary[]=[...new Set(records.flatMap(r=>r.evidence.map(e=>e.sourceId)))].flatMap(sourceId=>{
      try {
       const source=memory.source(p,sourceId),chat=source.conversationId?memory.store.getConversation(source.conversationId):null;
       const task=source.taskId&&!source.taskResetAuthority?.taskIds.includes(source.taskId)?memory.options.tasks.getTask(p,source.taskId):null;
       return [{id:source.id,kind:source.kind,conversationId:source.conversationId,taskId:source.taskId,observedAt:source.observedAt,capturedAt:source.capturedAt,
        title:chat?.title||task?.goal||source.taskSnapshot?.goal||'',excerpt:(source.events.find(e=>e.kind==='user'&&!e.contextOnly)?.text??source.taskSnapshot?.goal??'').replace(/\s+/g,' ').trim().slice(0,120)}];
      }catch(error){if(error instanceof DomainError)return [];throw error;}
     });
     return {records,sources,collections:memory.collections(p)};
    });
    json(res,200,index);return true;
   }
   if(parts[0]==='search'&&parts.length===1&&method==='POST') {
    const data=await body(req);fields(data,['projectId','query']);if(typeof data.query!=='string'||data.query.length>2000||data.projectId!==undefined&&data.projectId!==null&&typeof data.projectId!=='string')throw invalid();
    if(data.projectId!==undefined){if(data.projectId!==null)id(data.projectId);json(res,200,await recall.hybridSearch(p,{projectId:data.projectId,query:data.query}));return true;}
    const items:ReturnType<typeof recall.search>['items']=[],seen=new Set<string>();let size=0,indexLag=0,degraded=false;
    for(const projectId of new Set(memory.collections(p).map(c=>c.projectId))){const result=await recall.hybridSearch(p,{projectId,query:data.query});indexLag+=result.indexLag;degraded ||= result.degraded;for(const item of result.items){const length=Array.from(item.text).length;if(seen.has(item.recordId)||items.length===8||size+length>6000)continue;seen.add(item.recordId);items.push(item);size+=length;}}
    const valid=items.filter(item=>{try{const current=memory.read(p,item.recordId);return current.status==='active'&&current.revision===item.revision;}catch(error){if(!(error instanceof DomainError))throw error;return false;}});
    json(res,200,{items:valid,indexLag,degraded});return true;
   }
   if(parts[0]==='organize'&&parts.length===1&&method==='POST'){throw new DomainError('conversation_summary_retired',410,'Conversation summaries are no longer generated');}
   if(parts[0]==='jobs'&&parts.length===1&&method==='GET'){json(res,200,jobs.list(p));return true;}
   if(parts[0]==='jobs'&&parts.length===3&&parts[2]==='result'&&method==='GET'){json(res,200,runtime.result(p,id(parts[1])));return true;}
   if(parts[0]==='sources'&&parts.length===2&&method==='GET'){json(res,200,memory.source(p,id(parts[1])));return true;}
   if(parts[0]==='records'&&parts.length===2&&method==='GET'){json(res,200,memory.read(p,id(parts[1])));return true;}
   if(parts[0]==='records'&&parts.length===3&&method==='POST'&&['confirm','correct','retract'].includes(parts[2])){
    const data=await body(req);fields(data,parts[2]==='correct'?['expectedRevision','text']:['expectedRevision']);if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<1)throw invalid();
    const input={recordId:id(parts[1]),expectedRevision:data.expectedRevision};
    if(parts[2]==='confirm')json(res,200,memory.confirm(p,input));
    else if(parts[2]==='correct'){if(typeof data.text!=='string')throw invalid();json(res,200,memory.correct(p,{...input,text:data.text}));}
    else {memory.retract(p,input);json(res,200,{retracted:true});}return true;
   }
   json(res,404,{error:'Not found'});return true;
  }catch(error){if(error instanceof DomainError){json(res,error.status,{error:error.code});return true;}throw error;}
 };
}
