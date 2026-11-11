import { createFileMaintenance, type FileMaintenance } from './file-maintenance';
import { workspacePrincipal } from './workspace-identity';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createAttachmentAssets } from './attachment-assets';
import { createAssets } from './assets';
import { createAssetFiles } from './asset-files';
import { readConfig } from './config';
import type { Store } from './store';
// Sandboxed: scripts may run inline, but no network, forms, frames or same-origin access.
export const htmlPreviewPolicy="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
import { DomainError } from '../shared/workspace-contracts';
import type { AssetBinding } from '../shared/assets';
import { fileMediaType, filePreviewKind } from '../shared/file-types';
import { openLocalAsset } from './asset-local-open';
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const invalid=()=>new DomainError('invalid_request',422,'Invalid asset request');
const fields=(data:any,allowed:string[])=>{if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!allowed.includes(key)))throw invalid();};
export function createAssetHttp(home:string,store:Store,authorizeConversation:(id:string)=>void=()=>{},maintenance?:FileMaintenance,onAccessChanged:()=>void=()=>{}){
 const files=createAssetFiles(home),assets=createAssets(store,files),principal=workspacePrincipal(store);
 store.database.exec("CREATE TABLE IF NOT EXISTS file_execution_scopes(invocation_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT,conversation_id TEXT NOT NULL)");
 const upkeep=maintenance??createFileMaintenance({home,store,loadConfig:async()=>(await readConfig(home)).config});
 const attachmentAssets=createAttachmentAssets(home,store,files,assets);
 async function validateTargets(type:string,id:string){
  const {config}=await readConfig(home);
  if(type==='agent'&&config.agents.some(a=>a.id===id)||type==='project'&&config.projects.some(p=>p.id===id))return;
  throw invalid();
 }
 return async (req:IncomingMessage,res:ServerResponse,url:URL,body:(req:IncomingMessage)=>Promise<any>):Promise<boolean>=>{
  if(!url.pathname.startsWith('/api/v2/assets'))return false;
  try {
   // This local user endpoint never accepts an authorization identity from clients.
   if([...url.searchParams.keys()].some(key=>!['name','version','ownerType','ownerId','preview'].includes(key)))throw invalid();
   if(url.searchParams.has('preview')&&url.searchParams.get('preview')!=='1')throw invalid();
   const parts=url.pathname.slice('/api/v2/assets'.length).split('/').filter(Boolean).map(decodeURIComponent),method=req.method;
   if(parts[0]==='attachment-imports'&&parts.length===1&&method==='GET'){await attachmentAssets.reconcileSubmitted(principal,authorizeConversation);json(res,200,attachmentAssets.status(principal,authorizeConversation));return true;}
   if(parts[0]==='uploads'&&parts.length===1&&method==='POST'){
    const name=url.searchParams.get('name');if(!name||name.length>255||name.startsWith('/')||name.split('/').includes('..')||name.includes('\\')||name==='.'||name==='..'||name.includes('\0'))throw invalid();
    // Server-generated input path is distinct from the manifest filename.
    const temporary=await mkdtemp(join(home,'upload-'));
    try {
     const input=await open(join(temporary,'input'),'wx',0o600);let size=0;
     try {for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024)throw new DomainError('upload_too_large',413,'Single file limit is 100 MiB');let offset=0;while(offset<chunk.length){const {bytesWritten}=await input.write(chunk,offset,chunk.length-offset);if(!bytesWritten)throw new Error('Short upload write');offset+=bytesWritten;}}await input.sync();}finally{await input.close();}
     const stage=await files.stageFiles(principal,null,[{allowedRoot:temporary,relativePath:'input',manifestPath:name}]);json(res,201,stage);
    }finally{await rm(temporary,{recursive:true,force:true});}
    return true;
   }
   if(parts[0]==='imports'&&parts.length===1&&method==='POST'){const data=await body(req);fields(data,['kind','title','agentId','submissionId']);if(data.agentId)await validateTargets('agent',data.agentId);const key=req.headers['idempotency-key'];if(typeof key!=='string')throw invalid();json(res,201,assets.importAsset(principal,data,key));return true;}
   if(parts[0]==='bindings'&&parts.length===1){
    const type=url.searchParams.get('ownerType')??'',id=url.searchParams.get('ownerId')??'';await validateTargets(type,id);
    if(method==='GET'){json(res,200,assets.listBindings(principal,type as AssetBinding['ownerType'],id));return true;}
   }
   if(parts.length===0){
    if(method==='GET'){await attachmentAssets.reconcileSubmitted(principal,authorizeConversation);const type=url.searchParams.get('ownerType'),ownerId=url.searchParams.get('ownerId');if(Boolean(type)!==Boolean(ownerId))throw invalid();if(type&&ownerId)await validateTargets(type,ownerId);const selected=type&&ownerId?assets.listBindings(principal,type as AssetBinding['ownerType'],ownerId):null;json(res,200,assets.listAssets(principal).filter(asset=>asset.owner.projectId&&type==='project'?asset.owner.projectId===ownerId:!selected||selected.some(b=>b.assetId===asset.id)||type==='agent'&&asset.owner.agentId===ownerId||type==='project'&&asset.headVersionId&&Boolean(store.database.prepare("SELECT v.id FROM asset_versions v LEFT JOIN file_execution_scopes s ON s.invocation_id=json_extract(v.data,'$.provenance.runId') LEFT JOIN task_runs r ON r.id=json_extract(v.data,'$.provenance.runId') LEFT JOIN task_executions e ON e.id=r.execution_id WHERE v.id=? AND (s.project_id=? OR e.project_id=?)").get(asset.headVersionId,ownerId,ownerId))).map(asset=>{
     let file: {name:string;mediaType:string}|undefined;let versionOrdinal:number|null=null,updatedAt:string|null=null,source='manual',availability=asset.kind==='external_reference'?'host_reference':'unpublished';
     if(asset.headVersionId){try{const version=assets.getAuthorizedVersion(principal,{assetId:asset.id,versionId:asset.headVersionId});versionOrdinal=version.ordinal;updatedAt=version.createdAt;if(version.files[0])file={name:version.files[0].path,mediaType:version.files[0].mediaType};source=store.database.prepare("SELECT asset_id FROM attachment_asset_links WHERE user_id=? AND asset_id=? AND state='imported'").get(principal.userId,asset.id)?'attachment':version.provenance.runId??'manual';availability=asset.kind==='external_reference'?'host_reference':'managed_local';for(let index=0;index<version.files.length;index++)assets.readAssetFile(principal,{assetId:asset.id,versionId:version.id},String(index));}catch(error){if(error instanceof DomainError&&error.status===403)availability='access_denied';else if(error instanceof DomainError&&error.code==='blob_missing')availability='missing';else throw error;}}
     const activity=assets.activity(principal,asset.id),recentAt=[updatedAt,activity.lastViewedAt,activity.lastEditedAt].filter((at):at is string=>!!at).sort().at(-1)??null;return {...asset,...availability==='access_denied'?{}:{file},versionOrdinal,updatedAt,source,availability,...activity,recentAt};
    }).sort((a,b)=>(Date.parse(b.recentAt??'')||0)-(Date.parse(a.recentAt??'')||0)||a.id.localeCompare(b.id)));return true;}
    if(method==='POST'){const data=await body(req);fields(data,['kind','title','agentId']);if(data.agentId)await validateTargets('agent',data.agentId);json(res,201,assets.createAsset(principal,{kind:data.kind,title:data.title,owner:{userId:principal.userId,...(data.agentId?{agentId:data.agentId}:{})}}));return true;}
   }
   const id=parts[0];
   if(parts[1]==='bindings'&&parts.length===2&&method==='GET'){
    const {config}=await readConfig(home),bindings=assets.listAssetBindings(principal,id);
    json(res,200,bindings.filter(binding=>binding.ownerType==='project'?config.projects.some(p=>p.id===binding.ownerId):config.agents.some(a=>a.id===binding.ownerId)));return true;
   }
   if(parts[1]==='maintenance'&&parts.length===2){if(method==='GET'){json(res,200,upkeep.status(principal,id));return true;}if(method==='PUT'){const data=await body(req);fields(data,['enabled','agentId','projectId','conditions','expectedRevision']);json(res,200,await upkeep.configure(principal,id,data));return true;}}
   if(parts[1]==='origin'&&parts.length===2&&method==='GET'){let origin:{kind:string;conversationId:string|null;title:string|null;attachmentId?:unknown}|null=attachmentAssets.origin(principal,id,authorizeConversation);if(!origin){const a=assets.getAuthorizedAsset(principal,id);if(a.headVersionId){const v=assets.getAuthorizedVersion(principal,{assetId:id,versionId:a.headVersionId});const scope=store.database.prepare('SELECT conversation_id FROM file_execution_scopes WHERE invocation_id=? AND user_id=?').get(v.provenance.runId??'',principal.userId);const c=scope?store.getConversation(scope.conversation_id as string):null;if(c){authorizeConversation(c.id);origin={kind:'agent_output',conversationId:c.id,title:c.title};}}}json(res,200,origin);return true;}
   if(parts[1]==='activity'&&parts.length===2&&method==='POST'){const data=await body(req);fields(data,['kind','versionId']);if(data.kind!=='view'||typeof data.versionId!=='string')throw invalid();assets.recordView(principal,{assetId:id,versionId:data.versionId});json(res,200,{ok:true});return true;}
   if(parts.length===1&&method==='GET'){json(res,200,assets.getAuthorizedAsset(principal,id));return true;}
   if(parts[1]==='versions'&&parts.length===2){
    if(method==='GET'){json(res,200,assets.listVersions(principal,id));return true;}
    if(method==='POST'){const data=await body(req);fields(data,['expectedHeadVersionId','submissionId','provenance']);fields(data.provenance,['sourceVersions']);if(data.expectedHeadVersionId!==null&&typeof data.expectedHeadVersionId!=='string')throw invalid();const key=req.headers['idempotency-key'];if(typeof key!=='string'||key.length>200)throw invalid();
     // Read the trusted lease; clients cannot forge manifest paths/hashes.
     // Replay must survive expired staging; use committed version files on an exact retry.
     let staged;
     try{staged=files.readStaging(principal,null,data.submissionId);}catch(error){
      const row=store.database.prepare('SELECT version_id FROM command_dedup WHERE principal=? AND command_key=?').get(JSON.stringify(principal),key);
      if(!row)throw error;
      staged=assets.getAuthorizedVersion(principal,{assetId:id,versionId:row.version_id as string});
     }
     json(res,201,assets.publishAssetVersion(principal,{assetId:id,expectedHeadVersionId:data.expectedHeadVersionId,submissionId:data.submissionId,files:staged.files,provenance:data.provenance},key));return true;}
   }
   if(parts[1]==='versions'&&parts.length===3&&method==='GET'){
    const version=assets.getAuthorizedVersion(principal,{assetId:id,versionId:parts[2]});
    const downloads=version.files.map((file,index)=>{let availability:'managed_local'|'missing'='managed_local';try{assets.readAssetFile(principal,{assetId:id,versionId:version.id},String(index));}catch(error){if(error instanceof DomainError&&error.code==='blob_missing')availability='missing';else throw error;}return {fileId:String(index),name:file.path,size:file.size,mediaType:file.mediaType,availability};});
    json(res,200,{...version,downloads});return true;
   }
   if(parts[1]==='versions'&&parts[3]==='files'&&parts[5]==='open'&&parts.length===6&&method==='POST'){
    const data=await body(req);fields(data,['action']);if(data.action!=='open'&&data.action!=='reveal')throw invalid();
    const file=assets.readAssetFile(principal,{assetId:id,versionId:parts[2]},parts[4]);
    await openLocalAsset(home,file,data.action);json(res,200,{ok:true});return true;
   }
   if(parts[1]==='versions'&&parts[3]==='files'&&parts.length===5&&(method==='GET'||method==='HEAD')){
    const file=assets.readAssetFile(principal,{assetId:id,versionId:parts[2]},parts[4]);
    const preview=url.searchParams.get('preview')==='1',kind=filePreviewKind(file.name,file.mediaType),html=preview&&/\.html?$/i.test(file.name);
    if(preview&&!html&&!['image','pdf','audio','video'].includes(kind??''))throw new DomainError('preview_unavailable',415,'Preview unavailable for this format');
    let handle;try{handle=await open(file.blobPath,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile()||stat.size!==file.size)throw new Error('Missing Blob');}catch{await handle?.close();throw new DomainError('blob_missing',409,'Content missing; restore from backup');}
    let start=0,end=file.size-1,status=200;
    const range=req.headers.range;
    if(range&&(!req.headers['if-range']||req.headers['if-range']===file.etag)){
     const match=/^bytes=(\d*)-(\d*)$/.exec(range);let valid=Boolean(match&&(match[1]||match[2]));
     if(valid&&match){if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,file.size-suffix);valid=suffix>0;}else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}valid=valid&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<file.size;}
     if(!valid){await handle.close();res.writeHead(416,{'Content-Range':`bytes */${file.size}`});res.end();return true;}status=206;
    }
    const headers:Record<string,string>={'Content-Type':html?'text/html; charset=utf-8':fileMediaType(file.name,file.mediaType),'Content-Disposition':`${preview?'inline':'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':html?htmlPreviewPolicy:preview&&kind==='pdf'?"default-src 'none'; object-src 'self'":"default-src 'none'; sandbox",'ETag':file.etag,'Accept-Ranges':'bytes','Cache-Control':'no-store','Content-Length':String(status===206?end-start+1:file.size)};
    if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;
    res.writeHead(status,headers);
    if(method==='HEAD'||file.size===0){await handle.close();res.end();return true;}
    try{await pipeline(handle.createReadStream({start,end,autoClose:true}),res);}catch{res.destroy();}return true;
   }
   if(parts.length===2&&['access','lifecycle'].includes(parts[1])&&method==='PUT'){
    const data=await body(req);fields(data,parts[1]==='access'?['policy','expectedRevision']:['lifecycle','expectedRevision']);
    if(parts[1]==='access'){fields(data.policy,['mode','agentIds','projectIds']);for(const agent of data.policy.agentIds??[])await validateTargets('agent',agent);for(const project of data.policy.projectIds??[])await validateTargets('project',project);json(res,200,assets.setAccess(principal,id,data.policy,data.expectedRevision));}
    else json(res,200,assets.setLifecycle(principal,id,data.lifecycle,data.expectedRevision));
    onAccessChanged();return true;
   }
   if(parts[1]==='bindings'&&parts.length===2&&(method==='POST'||method==='DELETE')){
    const data=await body(req);fields(data,['ownerType','ownerId','versionPolicy','versionId']);await validateTargets(data.ownerType,data.ownerId);
    if(method==='POST')assets.bind(principal,{...data,assetId:id});else assets.removeBinding(principal,data.ownerType,data.ownerId,id);json(res,200,{ok:true});return true;
   }
   json(res,404,{code:'not_found',error:'Asset endpoint not found'});
  }catch(error){if(res.headersSent){res.destroy();return true;}const domain=error instanceof DomainError?error:null;json(res,domain?.status??400,{code:domain?.code??'invalid_request',error:domain?.message??'Invalid asset request'});}
  return true;
 };
}
