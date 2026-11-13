import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store';
import type { createAssets } from './assets';
import type { createAssetFiles } from './asset-files';
import { loadAttachments, readAttachmentBytes } from './attachments';
import { DomainError, type Principal, type VersionRef } from '../shared/workspace-contracts';

// Trusted acceptance boundary. Uploads alone never create a link or a File.
export function createAttachmentAssets(home:string,store:Store,files:ReturnType<typeof createAssetFiles>,assets:ReturnType<typeof createAssets>){
 const db=store.database;
 db.exec(`CREATE TABLE IF NOT EXISTS attachment_asset_links(user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,attachment_id TEXT NOT NULL,asset_id TEXT,version_id TEXT,submission_id TEXT NOT NULL,state TEXT NOT NULL,agent_id TEXT,project_id TEXT,staging_id TEXT,PRIMARY KEY(user_id,conversation_id,attachment_id))`);
 db.exec('CREATE TABLE IF NOT EXISTS attachment_asset_cursors(user_id TEXT PRIMARY KEY,event_id INTEGER NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS attachment_asset_retry_cursors(user_id TEXT PRIMARY KEY,row_id INTEGER NOT NULL)');
 const row=(p:Principal,conversationId:string,id:string)=>db.prepare('SELECT * FROM attachment_asset_links WHERE user_id=? AND conversation_id=? AND attachment_id=?').get(p.userId,conversationId,id);
 const service={
  accept(p:Principal,conversationId:string,ids:string[],submissionId:string,scope:{agentId?:string;projectId?:string}){
   if(p.agentId||!p.userId||!conversationId||!submissionId||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>! /^[a-f0-9-]{36}$/.test(id)))throw new DomainError('invalid_attachment_acceptance',422,'Invalid accepted attachments');
   const accept=()=>{for(const id of ids){const old=row(p,conversationId,id);if(old&&(old.agent_id??undefined)!==scope.agentId)throw new DomainError('attachment_scope_changed',403,'Accepted attachment belongs to its original Agent');
    db.prepare("INSERT OR IGNORE INTO attachment_asset_links VALUES (?,?,?,NULL,NULL,?,'pending',?,?,NULL)").run(p.userId,conversationId,id,submissionId,scope.agentId??null,scope.projectId??null);
   }};
   if(db.isTransaction)accept();else store.transaction(accept);
  },
  submittedOrigin(conversationId:string,attachmentId:string,authorize:(id:string)=>void){
   authorize(conversationId);let current=store.getConversation(conversationId),origin=conversationId;
   const find=(id:string,through=Infinity)=>store.listContextEvents(id,'user',0).find(event=>event.id<=through&&((event.data as {attachments?:{id:string}[]}).attachments??[]).some(item=>item.id===attachmentId));
   let scope=(find(origin)?.data as {fileScope?:{agentId?:string;projectId?:string}}|undefined)?.fileScope??{};
   const visited=new Set([conversationId]);
   while(current?.branchedFrom){const parent=current.branchedFrom;if(visited.has(parent.conversationId))throw new DomainError('attachment_origin_cycle',403,'Invalid attachment origin');visited.add(parent.conversationId);authorize(parent.conversationId);const event=find(parent.conversationId,parent.eventId);if(!event)break;
    origin=parent.conversationId;scope=(event.data as {fileScope?:{agentId?:string;projectId?:string}}).fileScope??{};current=store.getConversation(origin);
   }
   return {conversationId:origin,scope};
  },
  lineage(p:Principal,conversationId:string,authorize:(id:string)=>void,after=0){
   const refs:VersionRef[]=[];let complete=true;
   for(const event of store.listContextEvents(conversationId,'user',after)){
    for(const item of (event.data as {attachments?:{id:string}[]}).attachments??[]){let link;try{const origin=service.submittedOrigin(conversationId,item.id,authorize);link=row(p,origin.conversationId,item.id);}catch{complete=false;continue;}
     if(!link||link.state!=='imported'){complete=false;continue;}refs.push({assetId:link.asset_id as string,versionId:link.version_id as string});
    }
   }
   return {complete,refs:[...new Map(refs.map(ref=>[ref.versionId,ref])).values()]};
  },
  async reconcileSubmitted(p:Principal,authorize:(id:string)=>void,limit=32){
   const cursor=Number(db.prepare('SELECT event_id FROM attachment_asset_cursors WHERE user_id=?').get(p.userId)?.event_id??0);
   const events=db.prepare("SELECT id,conversationId,data FROM events WHERE kind='user' AND id>? AND json_array_length(json_extract(data,'$.attachments'))>0 ORDER BY id LIMIT ?").all(cursor,limit);
   for(const event of events){
    const conversationId=event.conversationId as string,conversation=store.getConversation(conversationId);
    if(conversation){try{authorize(conversationId);const data=JSON.parse(event.data as string);const ids=(data.attachments??[]).map((item:{id:string})=>item.id);
      // Old events contain no trustworthy execution scope. Keep them human-private.
      for(const id of ids){const origin=service.submittedOrigin(conversationId,id,authorize);service.accept(p,origin.conversationId,[id],`historical:${event.id}`,origin.scope);}
     }catch{/* Inaccessible or invalid origins never contribute metadata. */}}
    db.prepare('INSERT INTO attachment_asset_cursors VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET event_id=excluded.event_id').run(p.userId,event.id as number);
   }
   const lastAttempt=Number(db.prepare('SELECT row_id FROM attachment_asset_retry_cursors WHERE user_id=?').get(p.userId)?.row_id??0);
   const select=db.prepare("SELECT rowid,conversation_id,attachment_id FROM attachment_asset_links WHERE user_id=? AND state='pending' AND rowid>? ORDER BY rowid LIMIT ?");
   let pendingRows=select.all(p.userId,lastAttempt,limit);if(!pendingRows.length)pendingRows=select.all(p.userId,0,limit);
   for(const pending of pendingRows){
    // Advance on failure as well as success; unavailable newer uploads cannot starve recovered ones.
    db.prepare('INSERT INTO attachment_asset_retry_cursors VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET row_id=excluded.row_id').run(p.userId,pending.rowid as number);
    const id=pending.conversation_id as string;if(!store.getConversation(id))continue;
    try{authorize(id);await service.resolve(p,id,[pending.attachment_id as string],()=>authorize(id));}catch{/* Accepted prompt and pending link survive missing bytes; status is exposed below. */}
   }
  },
  status(p:Principal,authorize:(id:string)=>void){return db.prepare('SELECT conversation_id,attachment_id,asset_id,version_id,state FROM attachment_asset_links WHERE user_id=? ORDER BY rowid DESC LIMIT 100').all(p.userId).filter(r=>{try{authorize(r.conversation_id as string);return true;}catch{return false;}}).map(r=>({conversationId:r.conversation_id,attachmentId:r.attachment_id,assetId:r.asset_id,versionId:r.version_id,state:r.state}));},
  origin(p:Principal,assetId:string,authorize:(id:string)=>void){assets.getAuthorizedAsset(p,assetId);const source=db.prepare("SELECT conversation_id,attachment_id FROM attachment_asset_links WHERE user_id=? AND asset_id=? AND state='imported'").get(p.userId,assetId);if(!source)return null;const c=store.getConversation(source.conversation_id as string);if(!c)return {kind:'attachment',conversationId:null,title:null};authorize(c.id);return {kind:'attachment',conversationId:c.id,attachmentId:source.attachment_id,title:c.title};},
  refs(p:Principal,conversationId:string):VersionRef[]{return db.prepare("SELECT asset_id,version_id FROM attachment_asset_links WHERE user_id=? AND conversation_id=? AND state='imported'").all(p.userId,conversationId).map(r=>({assetId:r.asset_id as string,versionId:r.version_id as string}));},
  async resolve(p:Principal,conversationId:string,ids:string[],assertAuthorized:()=>void=()=>{}){
   const refs:VersionRef[]=[];
   for(const id of ids){
    assertAuthorized();const accepted=row(p,conversationId,id);if(!accepted)throw new DomainError('attachment_not_accepted',403,'Attachment was not submitted');
    if(accepted.state==='imported'){const ref={assetId:accepted.asset_id as string,versionId:accepted.version_id as string};assets.getAuthorizedVersion(p,ref);refs.push(ref);continue;}
    const [attachment]=await loadAttachments(home,conversationId,[id]);const bytes=await readAttachmentBytes(home,attachment);assertAuthorized();
    let stagingId=accepted.staging_id as string|null;
    if(stagingId){try{files.readStaging(p,null,stagingId);}catch(error){if(error instanceof DomainError&&error.code==='forbidden')throw error;db.prepare('UPDATE attachment_asset_links SET staging_id=NULL WHERE user_id=? AND conversation_id=? AND attachment_id=?').run(p.userId,conversationId,id);stagingId=null;}}
    if(!stagingId){const temporary=await mkdtemp(join(home,'attachment-import-'));try{await writeFile(join(temporary,'input'),bytes,{mode:0o600});const staged=await files.stageFiles(p,null,[{allowedRoot:temporary,relativePath:'input',manifestPath:attachment.name}]);
      assertAuthorized();db.prepare('UPDATE attachment_asset_links SET staging_id=COALESCE(staging_id,?) WHERE user_id=? AND conversation_id=? AND attachment_id=?').run(staged.submissionId,p.userId,conversationId,id);stagingId=row(p,conversationId,id)!.staging_id as string;
     }finally{await rm(temporary,{recursive:true,force:true});}}
    assertAuthorized();const latest=row(p,conversationId,id)!;
    const saved=latest.state==='imported'?{asset:assets.getAuthorizedAsset(p,latest.asset_id as string),version:assets.getAuthorizedVersion(p,{assetId:latest.asset_id as string,versionId:latest.version_id as string})}:assets.importAsset(p,{kind:'file',title:attachment.name.slice(0,200),agentId:accepted.agent_id as string??undefined,submissionId:stagingId!},`attachment:${conversationId}:${id}`,undefined,result=>{
     assertAuthorized();if(accepted.project_id){const binding={ownerType:'project',ownerId:accepted.project_id,assetId:result.asset.id,versionPolicy:'latest'};db.prepare('INSERT INTO asset_bindings VALUES (?,?,?,?)').run('project',accepted.project_id as string,result.asset.id,JSON.stringify(binding));}
     db.prepare("UPDATE attachment_asset_links SET asset_id=?,version_id=?,state='imported' WHERE user_id=? AND conversation_id=? AND attachment_id=?").run(result.asset.id,result.version.id,p.userId,conversationId,id);
    });
    refs.push({assetId:saved.asset.id,versionId:saved.version.id});
   }
   return refs;
  },
 };
 return service;
}
