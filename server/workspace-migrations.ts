import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore, acquireWorkspaceMaintenance } from './store';
import { createAssets } from './assets';
import { createAssetFiles } from './asset-files';
import { parseLegacyKnowledge, KNOWLEDGE_CUTOVER } from './knowledge';
export { KNOWLEDGE_CUTOVER } from './knowledge';
import type { KnowledgeEntry } from '../shared/types';
import type { Asset, AssetVersion } from '../shared/assets';
export type MigrationReport = { read:number; imported:number; retainedCandidates:string[]; errors:string[]; hashes:{knowledge:string|null;config:string|null}; mappings:{legacyId:string;assetId:string;contentHash:string}[]; alreadyApplied:boolean };
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const fileHash=(path:string)=>existsSync(path)?digest(readFileSync(path)):null;
const baseline=(home:string)=>({knowledge:fileHash(join(home,'knowledge.json')),config:fileHash(join(home,'config.json'))});
function applied(home:string):MigrationReport|undefined {
 if(!existsSync(join(home,'state.sqlite')))return;
 // Read-only SQLite can create WAL/SHM beside its input. Query a captured DB+WAL
 // outside the workspace, preserving committed WAL state without touching source.
 const scratch=mkdtempSync(join(tmpdir(),'mandala-migration-preview-'));
 let db:DatabaseSync|undefined;
 try {
  const names=['state.sqlite','state.sqlite-wal'];
  const captured=names.map(name=>existsSync(join(home,name))?readFileSync(join(home,name)):null);
  for(let i=0;i<names.length;i++){
   const current=existsSync(join(home,names[i]))?readFileSync(join(home,names[i])):null;
   if(current===null?captured[i]!==null:captured[i]===null||!current.equals(captured[i]!))throw new Error('migration_source_changed');
   if(captured[i]!==null)writeFileSync(join(scratch,names[i]),captured[i]!);
  }
  db=new DatabaseSync(join(scratch,'state.sqlite'));
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_migrations'").get())return;
  const row=db.prepare('SELECT data FROM workspace_migrations WHERE key=?').get(KNOWLEDGE_CUTOVER);return row?JSON.parse(row.data as string):undefined;
 }finally{db?.close();rmSync(scratch,{recursive:true,force:true});}
}
// Offline single-writer migration. Acquiring maintenance refuses every open Store lease.
export async function migrateWorkspace(home:string,mode:'preview'|'apply'):Promise<MigrationReport> {
 const maintenance=mode==='apply'?acquireWorkspaceMaintenance(home):undefined;
 const backup=join(home,'migration-backup'), input=join(home,`.migration-input-${randomUUID()}`);
 let store:ReturnType<typeof openStore>|undefined, ownsBackup=false;
 try {
  const previous=applied(home);if(previous)return {...previous,alreadyApplied:true};
  const source=existsSync(join(home,'knowledge.json'))?readFileSync(join(home,'knowledge.json')):null;
  const entries=source===null?[]:parseLegacyKnowledge(source.toString('utf8')), importing=entries.filter(e=>e.kind!=='memory');
  const report:MigrationReport={read:entries.length,imported:0,retainedCandidates:importing.filter(e=>e.status==='candidate').map(e=>e.id),errors:[],hashes:{knowledge:source===null?null:digest(source),config:fileHash(join(home,'config.json'))},mappings:importing.map(e=>({legacyId:e.id,assetId:e.id,contentHash:digest(e.content)})),alreadyApplied:false};
  if(mode==='preview')return report;
  if(JSON.stringify(baseline(home))!==JSON.stringify(report.hashes))throw new Error('migration_source_changed');
  // Prior attempts leave their original backup intact. Never replace a recovery snapshot.
  if(existsSync(backup))throw new Error('migration_backup_exists');
  if(existsSync(join(home,'state.sqlite'))){
   const check=new DatabaseSync(join(home,'state.sqlite'));
   try {
    for(const table of ['conversations','tasks'])if(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
     for(const row of check.prepare(`SELECT data FROM ${table}`).all())if(['running','approval'].includes(JSON.parse(row.data as string).status))throw new Error('running_execution');
    const checkpoint=check.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(checkpoint?.busy)throw new Error('workspace_in_use');
   }finally{check.close();}
  }
  mkdirSync(backup);ownsBackup=true;const hadDatabase=existsSync(join(home,'state.sqlite'));
  for(const name of ['state.sqlite','config.json','knowledge.json'])if(existsSync(join(home,name)))copyFileSync(join(home,name),join(backup,name));
  writeFileSync(join(backup,'baseline.json'),JSON.stringify({hadDatabase,hashes:report.hashes}));
  store=openStore(home,maintenance!.token);const files=createAssetFiles(home);createAssets(store,files);mkdirSync(input);
  const prepared: {entry:KnowledgeEntry;asset:Asset;version:AssetVersion}[]=[];
  for(const entry of importing){
   const filename=entry.kind==='skill'?'SKILL.md':'document.md';writeFileSync(join(input,filename),entry.content);
   const staged=await files.stageFiles({userId:'local'},null,[{allowedRoot:input,relativePath:filename,manifestPath:filename}]);
   if(staged.files[0].blobHash!==digest(entry.content))throw new Error('migration_hash_mismatch');
   const asset:Asset={id:entry.id,kind:entry.kind as 'document'|'skill',title:entry.title,owner:{userId:'local',...(entry.agentId?{agentId:entry.agentId}:{})},accessPolicy:entry.access??{mode:'owner'},headVersionId:randomUUID(),lifecycle:'active',revision:1,accessRevision:1};
   const version:AssetVersion={id:asset.headVersionId!,assetId:asset.id,ordinal:1,files:staged.files,provenance:{sourceVersions:[]},createdAt:entry.createdAt,accessRevision:1};prepared.push({entry,asset,version});
  }
  if(JSON.stringify(baseline(home))!==JSON.stringify(report.hashes))throw new Error('migration_source_changed');
  report.imported=prepared.length;
  const db=store.database;
  store.transaction(()=>{
   db.exec('CREATE TABLE IF NOT EXISTS legacy_asset_entries(legacy_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id),data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_migrations(key TEXT PRIMARY KEY,data TEXT NOT NULL)');
   for(const {entry,asset,version} of prepared){
    db.prepare('INSERT INTO assets VALUES (?,?)').run(asset.id,JSON.stringify(asset));
    for(const file of version.files)db.prepare("INSERT INTO blobs VALUES (?,?,?,'ready') ON CONFLICT(hash) DO NOTHING").run(file.blobHash,file.size,file.mediaType);
    db.prepare('INSERT INTO asset_versions VALUES (?,?,?,?)').run(version.id,asset.id,1,JSON.stringify(version));
    for(const file of version.files)db.prepare('INSERT INTO asset_version_files VALUES (?,?,?)').run(version.id,file.path,file.blobHash);
    db.prepare('INSERT INTO legacy_asset_entries VALUES (?,?,?)').run(entry.id,asset.id,JSON.stringify(entry));
    for(const [type,ids]of [['agent',asset.accessPolicy.agentIds],['project',asset.accessPolicy.projectIds]] as const)for(const id of ids??[])db.prepare('INSERT INTO asset_grants VALUES (?,?,?)').run(asset.id,type,id);
   }
   db.prepare('INSERT INTO workspace_migrations VALUES (?,?)').run(KNOWLEDGE_CUTOVER,JSON.stringify(report));
   db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(KNOWLEDGE_CUTOVER,new Date().toISOString());
  });
  store.close();store=undefined;
  // Closed-DB fingerprint detects any later write, including legacy memory/config writes.
  writeFileSync(join(backup,'cutover.json'),JSON.stringify({database:fileHash(join(home,'state.sqlite')),hashes:baseline(home)}));
  return report;
 }finally{
  try {
   store?.close();
   if(ownsBackup&&existsSync(join(backup,'baseline.json'))&&!existsSync(join(backup,'cutover.json'))&&!applied(home))
    writeFileSync(join(backup,'pre-cutover.json'),JSON.stringify({database:fileHash(join(home,'state.sqlite')),hashes:baseline(home)}));
   if(mode==='apply')rmSync(input,{recursive:true,force:true});
  }finally{maintenance?.release();}
 }

}
export async function rollbackWorkspaceMigration(home:string):Promise<void> {
 const maintenance=acquireWorkspaceMaintenance(home), backup=join(home,'migration-backup');
 try {
  const metadata=JSON.parse(readFileSync(join(backup,'baseline.json'),'utf8'));
  const cutoverPath=join(backup,'cutover.json'), recoveryPath=existsSync(cutoverPath)?cutoverPath:join(backup,'pre-cutover.json');
  if(!existsSync(recoveryPath)||!existsSync(cutoverPath)&&applied(home))throw new Error('rollback_requires_export');
  {
   const cutover=JSON.parse(readFileSync(recoveryPath,'utf8'));
   if(fileHash(join(home,'state.sqlite'))!==cutover.database||JSON.stringify(baseline(home))!==JSON.stringify(cutover.hashes)||existsSync(join(home,'state.sqlite-wal'))&&readFileSync(join(home,'state.sqlite-wal')).length>0)throw new Error('rollback_requires_export');
  }
  for(const suffix of ['','-wal','-shm'])rmSync(join(home,`state.sqlite${suffix}`),{force:true});
  if(metadata.hadDatabase)copyFileSync(join(backup,'state.sqlite'),join(home,'state.sqlite'));
  // Historical JSON/config never changed; managed orphan bytes remain for listing-only GC.
  rmSync(backup,{recursive:true});
 }finally{maintenance.release();}
}

// Startup-only cutover: preserve original JSON bytes, then verify every memory before the marker.
export async function migrateMemory(home:string,store:import('./store').Store,memory:import('./memory-store').MemoryStore) {
 const key='memory_closure_001_cutover',db=store.database;
 if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
 const path=join(home,'knowledge.json'),source=existsSync(path)?readFileSync(path):Buffer.from('[]');
 const entries=parseLegacyKnowledge(source.toString()).filter(entry=>entry.kind==='memory');
 const backup=join(home,'memory-migration-backup');mkdirSync(backup,{recursive:true,mode:0o700});
 const saved=join(backup,'knowledge.json');
 if(existsSync(saved)){if(!readFileSync(saved).equals(source))throw new Error('memory_migration_source_changed');}
 else writeFileSync(saved,source,{flag:'wx',mode:0o600});
 memory.importLegacy({userId:'local'},entries);
 const records=memory.listAll({userId:'local'});
 for(const entry of entries){
  const record=records.find(r=>r.legacyId===entry.id);
  if(!record||record.text!==entry.content||record.contentHash!==digest(entry.content)||record.status!==(entry.status==='active'?'active':'proposed')||JSON.stringify(record.legacy)!==JSON.stringify((({content,...metadata})=>metadata)(entry)))throw new Error('memory_migration_verification_failed');
  const collection=memory.collection({userId:'local'},record.collectionId),asset=memory.options.assets.getAuthorizedAsset({userId:'local'},collection.id);
  if(collection.projectId!==(entry.projectId??null)||collection.agentId!==(entry.agentId??null)||JSON.stringify(asset.accessPolicy)!==JSON.stringify(entry.access??{mode:'owner'}))throw new Error('memory_migration_acl_mismatch');
 }
 if(existsSync(path)&&!readFileSync(path).equals(source))throw new Error('memory_migration_source_changed');
 const report={count:entries.length,sourceHash:digest(source),verified:entries.map(e=>({id:e.id,hash:digest(e.content),status:e.status,scope:e.scope,access:e.access??{mode:'owner'}}))};
 writeFileSync(join(backup,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
 store.transaction(()=>{db.exec('CREATE TABLE IF NOT EXISTS workspace_migrations(key TEXT PRIMARY KEY,data TEXT NOT NULL)');db.prepare('INSERT INTO workspace_migrations VALUES (?,?)').run(key,JSON.stringify(report));db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());});
}
