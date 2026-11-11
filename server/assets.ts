import { assertSkillEvidence, skillEvidenceProject } from './skill-evidence';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from './store';
import type { createAssetFiles } from './asset-files';
import type { Asset, AssetBinding, AssetKind, AssetOwner, AssetVersion, AssetVersionInput, AuthorizedFile } from '../shared/assets';
import { canUseKnowledge } from '../shared/knowledge-access';
import type { KnowledgeEntry } from '../shared/types';
import type { KnowledgeAccess } from '../shared/types';
import { DomainError, type Principal, type VersionRef } from '../shared/workspace-contracts';
type VersionReadState={visiting:Set<string>;validated:Map<string,AssetVersion>};
const versionReads=new WeakMap<Store,Map<string,VersionReadState>>();
export function withAssetVersionRead<T>(store:Store,read:()=>T):T {
 const own=!versionReads.has(store);if(own)versionReads.set(store,new Map());
 try{return read();}finally{if(own)versionReads.delete(store);}
}
const wikiVersionReaders=new WeakMap<Store,(principal:Principal,version:AssetVersion)=>void>();
export function registerWikiVersionRead(store:Store,authorize:(principal:Principal,version:AssetVersion)=>void){wikiVersionReaders.set(store,authorize);}
const maintainedVersionReaders=new WeakMap<Store,(principal:Principal,ref:VersionRef)=>void>();
export function registerMaintainedVersionRead(store:Store,authorize:(principal:Principal,ref:VersionRef)=>void){maintainedVersionReaders.set(store,authorize);}
export type KnowledgeMetadata = Omit<KnowledgeEntry, 'content'>;
const fail = (code: string, status: number): never => { throw new DomainError(code, status, code); };
function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
 return JSON.stringify(value);
}
export function createAssets(store: Store, files: ReturnType<typeof createAssetFiles>, trustedProject?: (principal:Principal)=>string|undefined,
 canReadDeliveredVersion?: (principal:Principal,asset:Asset,version:AssetVersion)=>boolean) {
 const db=store.database;
 store.transaction(()=>{
  const key='workspace_foundation_002_assets';
  if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key)) return;
  db.exec(`CREATE TABLE assets(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE asset_versions(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id),ordinal INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(asset_id,ordinal));
   CREATE TABLE asset_grants(asset_id TEXT NOT NULL REFERENCES assets(id),target_type TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(asset_id,target_type,target_id));
   CREATE TABLE asset_bindings(owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES assets(id),data TEXT NOT NULL,PRIMARY KEY(owner_type,owner_id,asset_id));
   CREATE TABLE blobs(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,media_type TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','missing')));
   CREATE TABLE asset_version_files(version_id TEXT NOT NULL REFERENCES asset_versions(id),path TEXT NOT NULL,blob_hash TEXT NOT NULL REFERENCES blobs(hash),PRIMARY KEY(version_id,path));
   CREATE TABLE artifact_links(run_id TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES asset_versions(id),PRIMARY KEY(run_id,version_id));
   CREATE TABLE command_dedup(principal TEXT NOT NULL,command_key TEXT NOT NULL,payload_hash TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES asset_versions(id),PRIMARY KEY(principal,command_key));`);
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());
 });
 db.exec('CREATE TABLE IF NOT EXISTS asset_activity(user_id TEXT NOT NULL,asset_id TEXT NOT NULL,last_viewed_at TEXT,last_edited_at TEXT,PRIMARY KEY(user_id,asset_id))');
 store.transaction(()=>{db.exec('CREATE TABLE IF NOT EXISTS knowledge_asset_metadata(asset_id TEXT PRIMARY KEY REFERENCES assets(id),data TEXT NOT NULL)');});
 const load=(id:string):Asset=>{const row=db.prepare('SELECT data FROM assets WHERE id=?').get(id); if(!row) return fail('forbidden',403);return JSON.parse(row.data as string);};
 const manage=(p:Principal,a:Asset)=>{if(!p.userId || p.userId!==a.owner.userId || (p.agentId!==undefined && (a.owner.projectId ? trustedProject?.(p)!==a.owner.projectId : p.agentId!==a.owner.agentId))) fail('forbidden',403);};
 const legacy=(id:string):KnowledgeMetadata|undefined=>{
  const current=db.prepare('SELECT data FROM knowledge_asset_metadata WHERE asset_id=?').get(id);if(current)return JSON.parse(current.data as string);
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_asset_entries'").get())return undefined;
  const row=db.prepare("SELECT json_remove(data,'$.content') AS data FROM legacy_asset_entries WHERE asset_id=?").get(id);return row?JSON.parse(row.data as string):undefined;
 };
 const allowed=(a:Asset,agentId:string,projectId='')=>{
  const original=legacy(a.id);
  if(original?.status==='candidate')return false;
  if(original && a.accessPolicy.mode==='owner')return canUseKnowledge({...original,content:'',access:{mode:'owner'}},{agentId,projectId});
  if(a.owner.projectId)return a.owner.projectId===projectId;
  return a.accessPolicy.mode==='all' || a.accessPolicy.mode==='owner' && a.owner.agentId===agentId || a.accessPolicy.mode==='selected' && Boolean(a.accessPolicy.agentIds?.includes(agentId)||projectId&&a.accessPolicy.projectIds?.includes(projectId));
 };
 const authorize=(p:Principal,a:Asset,projectId=p.agentId!==undefined?trustedProject?.(p)??'':'',delivered=false)=>{if(!p.userId || p.userId!==a.owner.userId || a.lifecycle==='retracted' || (p.agentId!==undefined && !allowed(a,p.agentId,projectId) && !delivered)) fail('forbidden',403);};
 const edit=(p:Principal,id:string,at:string)=>db.prepare('INSERT INTO asset_activity(user_id,asset_id,last_edited_at) VALUES (?,?,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET last_edited_at=excluded.last_edited_at').run(p.userId,id,at);
 const write=(a:Asset)=>db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(a),a.id);
 const read=(p:Principal,ref:VersionRef,projectId=p.agentId!==undefined?trustedProject?.(p)??'':''):AssetVersion=>withAssetVersionRead(store,()=>{
  const queries=versionReads.get(store)!,principal=canonical([p,p.agentId!==undefined?projectId:null,!!canReadDeliveredVersion]);
  let query=queries.get(principal);if(!query){query={visiting:new Set(),validated:new Map()};queries.set(principal,query);}
  const key=canonical([ref.assetId,ref.versionId]);if(query.visiting.has(key))return fail('asset_source_cycle',403);
  const prior=query.validated.get(key);if(prior)return prior;
  query.visiting.add(key);
  try{
   if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_publication_journal'").get()&&db.prepare("SELECT version_id FROM skill_publication_journal WHERE version_id=? AND state!='published'").get(ref.versionId))return fail('skill_version_unpublished',403);
   const a=load(ref.assetId);
   const row=db.prepare('SELECT data FROM asset_versions WHERE id=? AND asset_id=?').get(ref.versionId,ref.assetId);
   if(!row)return fail('forbidden',403);const version=JSON.parse(row.data as string) as AssetVersion;
   // An explicitly edited access policy supersedes the default delivery access.
   const delivered=!!(p.agentId&&p.agentId!==a.owner.agentId&&a.kind==='file'&&a.accessPolicy.mode==='owner'&&a.accessRevision===1&&canReadDeliveredVersion?.(p,a,version));
   authorize(p,a,projectId,delivered);
   if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_maintenance_checks'").get()&&db.prepare("SELECT id FROM file_maintenance_checks WHERE json_extract(data,'$.resultVersionId')=?").get(ref.versionId)){
    const authority=maintainedVersionReaders.get(store);if(!authority)fail('maintenance_evidence_unavailable',403);authority!(p,ref);
   }
   if(version.provenance.wiki){const authority=wikiVersionReaders.get(store);if(!authority)fail('wiki_evidence_unavailable',403);authority!(p,version);}
   if(version.provenance.skill){
    const skill=version.provenance.skill;assertSkillEvidence(store,skill.source,skill.creatorAgentId,p);
    for(const creator of new Set([skill.source?.agentId,skill.creatorAgentId].filter((id):id is string=>!!id)))for(const source of version.provenance.sourceVersions)read({userId:p.userId,agentId:creator},source,skillEvidenceProject(store,{userId:p.userId,agentId:creator},skill.source?.projectId??''));
   }
   for(const source of version.provenance.sourceVersions)read(p,source,version.provenance.skill?skillEvidenceProject(store,p,projectId):projectId);
   const value={...version,accessRevision:a.accessRevision};query.validated.set(key,value);return value;
  }finally{query.visiting.delete(key);}
 });
 const subset=(target:Asset,source:Asset)=>{
  if(target.owner.userId!==source.owner.userId) return false;
  if(target.owner.projectId)return source.owner.projectId===target.owner.projectId||source.accessPolicy.mode==='all'||source.accessPolicy.mode==='selected'&&!!source.accessPolicy.projectIds?.includes(target.owner.projectId);
  if(target.accessPolicy.mode==='private') return true;
  if(target.accessPolicy.mode==='all') return source.accessPolicy.mode==='all';
  if(target.accessPolicy.projectIds?.length) return source.accessPolicy.mode==='all';
  const agents=target.accessPolicy.mode==='owner' ? (target.owner.agentId?[target.owner.agentId]:[]) : target.accessPolicy.agentIds??[];
  return agents.every(id=>allowed(source,id));
 };
 const publisherScope=(p:Principal,target:Asset,source:Asset,runId?:string)=>
  subset(target,source)||Boolean((runId&&runId===p.runId||target.kind==='wiki'&&wikiVersionReaders.has(store)&&db.prepare('SELECT id FROM wiki_bases WHERE id=?').get(target.id))&&p.agentId&&target.owner.userId===p.userId&&target.owner.agentId===p.agentId&&target.accessPolicy.mode==='owner'&&trustedProject?.(p)&&allowed(source,p.agentId,trustedProject(p)));
 const updateMetadata=(p:Principal,a:Asset,metadata:KnowledgeMetadata)=>{
  manage(p,a);if(a.owner.projectId)fail('wiki_project_owner_fixed',422);if(p.agentId!==undefined || metadata.id!==a.id || !['document','skill'].includes(metadata.kind) || 'content' in metadata)fail('invalid_knowledge_metadata',422);
  const next:Asset={...a,kind:metadata.kind as 'document'|'skill',title:metadata.title,owner:{userId:a.owner.userId,...(metadata.agentId?{agentId:metadata.agentId}:{})},accessPolicy:metadata.access??{mode:'owner'},revision:a.revision+1,accessRevision:a.accessRevision+1};
  if(a.headVersionId){const v=read(p,{assetId:a.id,versionId:a.headVersionId});for(const ref of v.provenance.sourceVersions)if(!subset(next,load(ref.assetId)))fail('source_scope_conflict',403);}
  db.prepare('INSERT INTO knowledge_asset_metadata VALUES (?,?) ON CONFLICT(asset_id) DO UPDATE SET data=excluded.data').run(a.id,JSON.stringify(metadata));
  db.prepare('DELETE FROM asset_grants WHERE asset_id=?').run(a.id);for(const [type,ids]of [['agent',next.accessPolicy.agentIds],['project',next.accessPolicy.projectIds]] as const)for(const target of ids??[])db.prepare('INSERT INTO asset_grants VALUES (?,?,?)').run(a.id,type,target);
  write(next);store.enqueueOutbox({type:'asset.access_changed',aggregateId:a.id,aggregateRevision:next.revision,causationId:randomUUID(),payload:{assetId:a.id,accessRevision:next.accessRevision}});return next;
 };
 return {
  getKnowledgeMetadata(p:Principal,id:string):KnowledgeMetadata|undefined {const a=load(id);authorize(p,a);return legacy(id);},
  setKnowledgeMetadata(p:Principal,id:string,metadata:KnowledgeMetadata,expectedRevision:number):Asset {return store.transaction(()=>{const a=load(id);if(a.revision!==expectedRevision)fail('revision_conflict',409);return updateMetadata(p,a,metadata);});},
  // Internal trusted Run bookkeeping; public callers must authorize the version first.
  pinVersion(runId:string,ref:VersionRef):void {
   if(!runId || !db.prepare('SELECT id FROM asset_versions WHERE id=? AND asset_id=?').get(ref.versionId,ref.assetId))fail('invalid_pin',422);
   store.transaction(()=>{db.prepare('INSERT OR IGNORE INTO artifact_links VALUES (?,?)').run(runId,ref.versionId);});
  },
  listGcCandidates(now:string):{blobHash:string;size:number;modifiedAt:string}[] {
   const time=Date.parse(now);if(!Number.isFinite(time))return fail('invalid_time',422);
   const root=dirname(dirname(files.blobPath('0'.repeat(64)))), home=dirname(dirname(root));
   const retained=new Set(db.prepare('SELECT blob_hash FROM asset_version_files').all().map(row=>row.blob_hash as string));
   // Read immutable manifests too: pin/source retention never relies on a refcount.
   for(const row of db.prepare('SELECT data FROM asset_versions').all())for(const file of (JSON.parse(row.data as string) as AssetVersion).files)retained.add(file.blobHash);
   const staging=join(home,'staging');
   if(existsSync(staging))for(const entry of readdirSync(staging,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
    // Corrupt leases fail closed rather than offering possibly in-flight bytes for GC.
    const lease=JSON.parse(readFileSync(join(staging,entry.name,'manifest.json'),'utf8'));
    const expiry=Date.parse(lease.manifest.expiresAt);if(!Number.isFinite(expiry)||!Array.isArray(lease.manifest.files))throw new Error('invalid_staging_lease');
    if(expiry>time)for(const file of lease.manifest.files)retained.add(file.blobHash);
   }
   const result:{blobHash:string;size:number;modifiedAt:string}[]=[];
   if(existsSync(root))for(const shard of readdirSync(root,{withFileTypes:true})){
    if(!shard.isDirectory()||! /^[a-f0-9]{2}$/.test(shard.name))continue;
    for(const entry of readdirSync(join(root,shard.name),{withFileTypes:true})){
     if(!entry.isFile()||! /^[a-f0-9]{64}$/.test(entry.name)||entry.name.slice(0,2)!==shard.name||retained.has(entry.name))continue;
     const stat=lstatSync(join(root,shard.name,entry.name));
     if(time-stat.mtimeMs>=86400000)result.push({blobHash:entry.name,size:stat.size,modifiedAt:stat.mtime.toISOString()});
    }
   }
   return result.sort((a,b)=>a.blobHash.localeCompare(b.blobHash));
  },
  importAsset(p:Principal,input:{kind:AssetKind;title:string;agentId?:string;submissionId:string;sourceVersions?:VersionRef[]},commandKey:string,metadata?:Omit<KnowledgeMetadata,'id'>,onImported?:(result:{asset:Asset;version:AssetVersion})=>void,privateImport=false):{asset:Asset;version:AssetVersion} {
   if(!commandKey||commandKey.length>200||!['document','file','wiki','skill','memory_collection','external_reference'].includes(input.kind)||typeof input.title!=='string'||!input.title.trim()||input.title.length>200)fail('invalid_asset',422);
   if(input.sourceVersions!==undefined&&(!Array.isArray(input.sourceVersions)||input.sourceVersions.some(ref=>!ref||typeof ref.assetId!=='string'||!ref.assetId||typeof ref.versionId!=='string'||!ref.versionId)))fail('invalid_publication',422);
   const principal=canonical(p),hash=createHash('sha256').update(canonical({import:input,metadata,...(privateImport?{privateImport:true}:{})})).digest('hex');
   const prior=db.prepare('SELECT * FROM command_dedup WHERE principal=? AND command_key=?').get(principal,commandKey);
   if(prior){if(prior.payload_hash!==hash)fail('idempotency_conflict',409);const row=db.prepare('SELECT asset_id FROM asset_versions WHERE id=?').get(prior.version_id as string)!;const asset=load(row.asset_id as string);manage(p,asset);return {asset,version:read(p,{assetId:asset.id,versionId:prior.version_id as string})};}
   const staged=files.readStaging(p,p.runId??null,input.submissionId);
   if(!staged.files.length)fail('invalid_manifest',422);
   for(const file of staged.files){try{const stat=lstatSync(files.blobPath(file.blobHash));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size)fail('blob_missing',409);}catch{fail('blob_missing',409);}}
   const a:Asset={id:randomUUID(),kind:input.kind,title:input.title.trim(),owner:{userId:p.userId,...(input.agentId?{agentId:input.agentId}:{})},accessPolicy:{mode:privateImport?'private':'owner'},headVersionId:null,lifecycle:'active',revision:1,accessRevision:1};manage(p,a);
   const v:AssetVersion={id:randomUUID(),assetId:a.id,ordinal:1,files:staged.files,provenance:{sourceVersions:input.sourceVersions??[],...(p.runId?{runId:p.runId}:{})},createdAt:new Date().toISOString(),accessRevision:1};
   return store.transaction(()=>{
    withAssetVersionRead(store,()=>{for(const ref of v.provenance.sourceVersions){read(p,ref);if(!publisherScope(p,a,load(ref.assetId),v.provenance.runId))fail('source_scope_conflict',403);}});
    db.prepare('INSERT INTO assets VALUES (?,?)').run(a.id,JSON.stringify(a));
    for(const file of v.files)db.prepare("INSERT INTO blobs VALUES (?,?,?,'ready') ON CONFLICT(hash) DO UPDATE SET state='ready'").run(file.blobHash,file.size,file.mediaType);
    db.prepare('INSERT INTO asset_versions VALUES (?,?,?,?)').run(v.id,a.id,1,JSON.stringify(v));
    for(const file of v.files)db.prepare('INSERT INTO asset_version_files VALUES (?,?,?)').run(v.id,file.path,file.blobHash);
    if(p.runId)db.prepare('INSERT INTO artifact_links VALUES (?,?)').run(p.runId,v.id);
    const asset={...a,headVersionId:v.id,revision:2};write(asset);
    store.enqueueOutbox({type:'asset.created',aggregateId:a.id,aggregateRevision:1,causationId:commandKey,payload:{assetId:a.id}});
    store.enqueueOutbox({type:'asset.version_published',aggregateId:a.id,aggregateRevision:2,causationId:commandKey,payload:{assetId:a.id,versionId:v.id}});
    edit(p,a.id,v.createdAt);
    const projectId=p.agentId&&p.runId?trustedProject?.(p):undefined;
    if(projectId){const binding:AssetBinding={ownerType:'project',ownerId:projectId,assetId:a.id,versionPolicy:'latest'};db.prepare('INSERT INTO asset_bindings VALUES (?,?,?,?)').run('project',projectId,a.id,JSON.stringify(binding));}
    const published=metadata?updateMetadata(p,asset,{...metadata,id:a.id}):asset;
    db.prepare('INSERT INTO command_dedup VALUES (?,?,?,?)').run(principal,commandKey,hash,v.id);const result={asset:published,version:v};onImported?.(result);return result;
   });
  },
  createAsset(p:Principal,input:{kind:AssetKind;title:string;owner:AssetOwner},onCreated?:(asset:Asset)=>void):Asset {
   if(input.owner?.projectId&&(input.kind!=='wiki'||input.owner.agentId||typeof input.owner.projectId!=='string'))fail('invalid_asset',422);
   if(!['document','file','wiki','skill','memory_collection','external_reference'].includes(input.kind) || typeof input.title!=='string' || !input.title.trim() || input.title.length>200 || !input.owner?.userId) fail('invalid_asset',422);
   const a:Asset={...input,id:randomUUID(),title:input.title.trim(),accessPolicy:{mode:'owner'},headVersionId:null,lifecycle:'active',revision:1,accessRevision:1};manage(p,a);
   return store.transaction(()=>{db.prepare('INSERT INTO assets VALUES (?,?)').run(a.id,JSON.stringify(a));store.enqueueOutbox({type:'asset.created',aggregateId:a.id,aggregateRevision:1,causationId:randomUUID(),payload:{assetId:a.id}});onCreated?.(a);return a;});
  },
  publishAssetVersion(p:Principal,input:AssetVersionInput,commandKey:string,metadata?:KnowledgeMetadata,expectedRevision?:number,onPublished?:(version:AssetVersion)=>void):AssetVersion {
   if(!commandKey || typeof commandKey!=='string' || !Array.isArray(input.files) || !Array.isArray(input.provenance?.sourceVersions)) fail('invalid_publication',422);
   const principal=canonical(p),hash=createHash('sha256').update(canonical(input)).digest('hex');
   const replay=()=>{const row=db.prepare('SELECT * FROM command_dedup WHERE principal=? AND command_key=?').get(principal,commandKey);if(!row)return undefined; if(row.payload_hash!==hash)fail('idempotency_conflict',409); manage(p,load(input.assetId));return read(p,{assetId:input.assetId,versionId:row.version_id as string});};
   const prior=replay();if(prior)return prior;
   if(input.provenance.runId!==p.runId) fail('forbidden',403);
   if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_bases'").get()&&db.prepare('SELECT id FROM wiki_bases WHERE id=?').get(input.assetId)&&(!input.provenance.wiki||!onPublished))fail('wiki_use_page_editor',422);
   const staged=files.readStaging(p,p.runId??null,input.submissionId);
   if(canonical(staged.files)!==canonical(input.files)) fail('invalid_manifest',422);
   for(const file of staged.files){const stat=lstatSync(files.blobPath(file.blobHash));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size)fail('blob_missing',409);}
   return store.transaction(()=>{
    const repeated=replay();if(repeated)return repeated;
    const a=load(input.assetId);manage(p,a);authorize(p,a);
    if(expectedRevision!==undefined&&a.revision!==expectedRevision)fail('revision_conflict',409);
    if(a.headVersionId!==input.expectedHeadVersionId)fail('head_conflict',409);
    withAssetVersionRead(store,()=>{for(const ref of input.provenance.sourceVersions){read(p,ref);if(!publisherScope(p,a,load(ref.assetId),input.provenance.runId))fail('source_scope_conflict',403);}});
    const ordinal=Number(db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM asset_versions WHERE asset_id=?').get(a.id)!.n);
    const v:AssetVersion={id:randomUUID(),assetId:a.id,ordinal,files:staged.files,provenance:input.provenance,createdAt:new Date().toISOString(),accessRevision:a.accessRevision};
    for(const file of v.files) db.prepare("INSERT INTO blobs VALUES (?,?,?,'ready') ON CONFLICT(hash) DO UPDATE SET state='ready'").run(file.blobHash,file.size,file.mediaType);
    db.prepare('INSERT INTO asset_versions VALUES (?,?,?,?)').run(v.id,a.id,ordinal,JSON.stringify(v));
    for(const file of v.files)db.prepare('INSERT INTO asset_version_files VALUES (?,?,?)').run(v.id,file.path,file.blobHash);
    if(p.runId)db.prepare('INSERT INTO artifact_links VALUES (?,?)').run(p.runId,v.id);
    edit(p,a.id,v.createdAt);
    const next={...a,headVersionId:v.id,revision:a.revision+1};write(next);if(metadata)updateMetadata(p,next,metadata);
    store.enqueueOutbox({type:'asset.version_published',aggregateId:a.id,aggregateRevision:a.revision+1,causationId:commandKey,payload:{assetId:a.id,versionId:v.id}});
    db.prepare('INSERT INTO command_dedup VALUES (?,?,?,?)').run(principal,commandKey,hash,v.id);onPublished?.(v);return v;
   });
  },
  readAssetFile(p:Principal,ref:VersionRef,fileId:string):AuthorizedFile {
   const version=read(p,ref);
   if(!/^(0|[1-9][0-9]*)$/.test(fileId))return fail('file_not_found',404);
   const file=version.files[Number(fileId)];if(!file)return fail('file_not_found',404);
   const blobPath=files.blobPath(file.blobHash);
   try {const stat=lstatSync(blobPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size)return fail('blob_missing',409);}
   catch {return fail('blob_missing',409);}
   return {blobPath,name:file.path,size:file.size,mediaType:file.mediaType,etag:`"${file.blobHash}"`};
  },
  listVersions(p:Principal,id:string):AssetVersion[]{authorize(p,load(id));return withAssetVersionRead(store,()=>db.prepare('SELECT data FROM asset_versions WHERE asset_id=? ORDER BY ordinal DESC').all(id).filter(row=>!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_publication_journal'").get()||!db.prepare("SELECT version_id FROM skill_publication_journal WHERE version_id=? AND state!='published'").get((JSON.parse(row.data as string) as AssetVersion).id)).map(row=>{const v=JSON.parse(row.data as string) as AssetVersion;return read(p,{assetId:id,versionId:v.id});}));},
  listBindings(p:Principal,ownerType:AssetBinding['ownerType'],ownerId:string):AssetBinding[]{return db.prepare('SELECT data FROM asset_bindings WHERE owner_type=? AND owner_id=?').all(ownerType,ownerId).map(row=>JSON.parse(row.data as string) as AssetBinding).filter(b=>{try{authorize(p,load(b.assetId));return true;}catch{return false;}});},
  listAssetBindings(p:Principal,id:string):AssetBinding[]{authorize(p,load(id));return db.prepare("SELECT data FROM asset_bindings WHERE asset_id=? AND owner_type IN ('project','agent') ORDER BY owner_type,owner_id").all(id).map(row=>JSON.parse(row.data as string) as AssetBinding);},
  removeBinding(p:Principal,ownerType:AssetBinding['ownerType'],ownerId:string,id:string):void {
   store.transaction(()=>{const a=load(id);authorize(p,a);if(a.owner.projectId&&ownerType==='project'&&ownerId===a.owner.projectId)fail('wiki_project_owner_fixed',422);if(p.agentId&&(ownerType!=='agent'||ownerId!==p.agentId))fail('forbidden',403);db.prepare('DELETE FROM asset_bindings WHERE owner_type=? AND owner_id=? AND asset_id=?').run(ownerType,ownerId,id);store.enqueueOutbox({type:'asset.binding_removed',aggregateId:id,aggregateRevision:a.revision,causationId:randomUUID(),payload:{assetId:id,ownerType,ownerId}});});
  },
  getAuthorizedVersion:(p:Principal,ref:VersionRef)=>read(p,ref),
  getAuthorizedAsset(p:Principal,id:string):Asset {const a=load(id);authorize(p,a);return a;},
  recordView(p:Principal,ref:VersionRef):void {read(p,ref);db.prepare('INSERT INTO asset_activity(user_id,asset_id,last_viewed_at) VALUES (?,?,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET last_viewed_at=excluded.last_viewed_at').run(p.userId,ref.assetId,new Date().toISOString());},
  activity(p:Principal,id:string):{lastViewedAt:string|null;lastEditedAt:string|null} {authorize(p,load(id));const row=db.prepare('SELECT * FROM asset_activity WHERE user_id=? AND asset_id=?').get(p.userId,id);return {lastViewedAt:row?.last_viewed_at as string??null,lastEditedAt:row?.last_edited_at as string??null};},
  listAssets(p:Principal):Asset[]{return db.prepare('SELECT data FROM assets').all().map(row=>JSON.parse(row.data as string) as Asset).filter(a=>{try{authorize(p,a);return a.lifecycle!=='archived';}catch{return false;}});},
  assignMaintenanceOwner(p:Principal,id:string,agentId:string,expectedRevision:number,onAssigned?:()=>void):Asset {
   return store.transaction(()=>{const a=load(id);manage(p,a);if(p.agentId||a.owner.agentId&&a.owner.agentId!==agentId||a.accessPolicy.mode!=='owner')fail('forbidden',403);if(a.revision!==expectedRevision)fail('revision_conflict',409);if(a.owner.agentId===agentId){onAssigned?.();return a;}
    if(a.owner.projectId)fail('wiki_project_owner_fixed',422);
    const next={...a,owner:{...a.owner,agentId},revision:a.revision+1,accessRevision:a.accessRevision+1};write(next);store.enqueueOutbox({type:'asset.access_changed',aggregateId:id,aggregateRevision:next.revision,causationId:randomUUID(),payload:{assetId:id,accessRevision:next.accessRevision}});onAssigned?.();return next;});
  },
  setAccess(p:Principal,id:string,policy:KnowledgeAccess,expectedRevision:number):Asset {
   if(load(id).owner.projectId)fail('wiki_project_access_fixed',422);
   if(!policy || !['owner','private','selected','all'].includes(policy.mode) || [policy.agentIds,policy.projectIds].some(ids=>ids!==undefined&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id))))fail('invalid_access',422);
   return store.transaction(()=>{const a=load(id);manage(p,a);if(a.revision!==expectedRevision)fail('revision_conflict',409);if(p.agentId && canonical(policy)!==canonical(a.accessPolicy))fail('forbidden',403);
    const next={...a,accessPolicy:policy,revision:a.revision+1,accessRevision:a.accessRevision+1};
    if(a.headVersionId){const v=read(p,{assetId:id,versionId:a.headVersionId});for(const ref of v.provenance.sourceVersions)if(!subset(next,load(ref.assetId)))fail('source_scope_conflict',403);}
    db.prepare('DELETE FROM asset_grants WHERE asset_id=?').run(id);for(const [type,ids]of [['agent',policy.agentIds],['project',policy.projectIds]] as const)for(const target of ids??[])db.prepare('INSERT INTO asset_grants VALUES (?,?,?)').run(id,type,target);
    write(next);store.enqueueOutbox({type:'asset.access_changed',aggregateId:id,aggregateRevision:next.revision,causationId:randomUUID(),payload:{assetId:id,accessRevision:next.accessRevision}});return next;});
  },
  setLifecycle(p:Principal,id:string,lifecycle:Asset['lifecycle'],expectedRevision:number):Asset {
   if(!['active','archived','retracted'].includes(lifecycle))fail('invalid_lifecycle',422);
   return store.transaction(()=>{const a=load(id);manage(p,a);if(a.revision!==expectedRevision)fail('revision_conflict',409);const next={...a,lifecycle,revision:a.revision+1,accessRevision:a.accessRevision+1};write(next);store.enqueueOutbox({type:'asset.lifecycle_changed',aggregateId:id,aggregateRevision:next.revision,causationId:randomUUID(),payload:{assetId:id,lifecycle}});return next;});
  },
  bind(p:Principal,binding:AssetBinding):void {
   if(!['agent','project','task'].includes(binding.ownerType)||!binding.ownerId||!['latest','pinned'].includes(binding.versionPolicy)||binding.versionPolicy==='pinned'&&!binding.versionId)fail('invalid_binding',422);
   store.transaction(()=>{const a=load(binding.assetId);authorize(p,a);if(a.owner.projectId&&(binding.ownerType!=='project'||binding.ownerId!==a.owner.projectId))fail('wiki_project_owner_fixed',422);if(p.agentId && (binding.ownerType!=='agent'||binding.ownerId!==p.agentId))fail('forbidden',403);const versionId=binding.versionPolicy==='latest'?a.headVersionId:binding.versionId;if(!versionId)return fail('asset_not_ready',409);read(p,{assetId:a.id,versionId});db.prepare('INSERT INTO asset_bindings VALUES (?,?,?,?) ON CONFLICT(owner_type,owner_id,asset_id) DO UPDATE SET data=excluded.data').run(binding.ownerType,binding.ownerId,a.id,JSON.stringify(binding));store.enqueueOutbox({type:'asset.binding_changed',aggregateId:a.id,aggregateRevision:a.revision,causationId:randomUUID(),payload:{assetId:a.id,ownerType:binding.ownerType,ownerId:binding.ownerId}});});
  },
 };
}
