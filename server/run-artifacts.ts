import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileMaintenance } from './file-maintenance';
import type { Store } from './store';
import type { createAssets } from './assets';
import type { createAssetFiles } from './asset-files';
import type { Asset, AssetVersion } from '../shared/assets';
import { DomainError, type Principal, type VersionRef } from '../shared/workspace-contracts';

type Options = {store:Store;files:ReturnType<typeof createAssetFiles>;assets:ReturnType<typeof createAssets>;principal:Principal;outputRoot:string;sourceVersions:VersionRef[];assertActive:()=>void|Promise<void>;maintenanceUpdate?:(args:Record<string,unknown>)=>ReturnType<FileMaintenance['updateGate']>};
const invalid=():never=>{throw new DomainError('invalid_artifact_tool',422,'Invalid artifact tool arguments');};
export function createRunArtifacts({store,files,assets,principal:bound,outputRoot,sourceVersions,assertActive,maintenanceUpdate}:Options){
 const principal={...bound},sources=sourceVersions.map(ref=>({...ref}));
 if(!principal.agentId||!principal.runId)throw new Error('Actual Agent Run required');
 store.database.exec('CREATE TABLE IF NOT EXISTS run_artifact_commands(run_id TEXT NOT NULL,command_key TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,command_key))');
 store.database.exec('CREATE TABLE IF NOT EXISTS run_artifact_intents(run_id TEXT NOT NULL,command_key TEXT NOT NULL,input_hash TEXT NOT NULL,submission_id TEXT,PRIMARY KEY(run_id,command_key))');
 const authorize=async()=>{await assertActive();for(const ref of sources)assets.getAuthorizedVersion(principal,ref);};
 return {
  async publish(args:Record<string,unknown>,commandKey:string):Promise<{asset:Asset;version:AssetVersion}>{
   await authorize();
   if(Object.keys(args).some(k=>!['title','files'].includes(k))||typeof args.title!=='string'||!args.title.trim()||!Array.isArray(args.files)||!args.files.length||!commandKey||commandKey.length>200)invalid();
   const hash=createHash('sha256').update(JSON.stringify(args)).digest('hex');
   const intent=store.database.prepare('SELECT * FROM run_artifact_intents WHERE run_id=? AND command_key=?').get(principal.runId!,commandKey);
   if(intent&&intent.input_hash!==hash)throw new DomainError('idempotency_conflict',409,'Command changed');
   const replay=()=>{
    const old=store.database.prepare('SELECT * FROM run_artifact_commands WHERE run_id=? AND command_key=?').get(principal.runId!,commandKey);
    const saved=store.database.prepare('SELECT input_hash FROM run_artifact_intents WHERE run_id=? AND command_key=?').get(principal.runId!,commandKey);
    if(saved&&saved.input_hash!==hash)throw new DomainError('idempotency_conflict',409,'Command changed');
    if(!old){
     const published=store.database.prepare("SELECT d.version_id,v.asset_id FROM command_dedup d JOIN asset_versions v ON v.id=d.version_id WHERE d.command_key=? AND json_extract(d.principal,'$.userId')=? AND json_extract(d.principal,'$.agentId')=? AND json_extract(d.principal,'$.runId')=? AND json_extract(v.data,'$.provenance.runId')=?").get(commandKey,principal.userId,principal.agentId!,principal.runId!,principal.runId!);
     if(!published)return null;
     if(!saved)throw new DomainError('unverified_artifact_command',409,'Original tool input is unavailable');
     const result={asset:assets.getAuthorizedAsset(principal,published.asset_id as string),version:assets.getAuthorizedVersion(principal,{assetId:published.asset_id as string,versionId:published.version_id as string})};
     store.database.prepare('INSERT OR IGNORE INTO run_artifact_commands VALUES (?,?,?,?)').run(principal.runId!,commandKey,hash,JSON.stringify(result));return result;
    }
    if(old.input_hash!==hash)throw new DomainError('idempotency_conflict',409,'Command changed');
    const result=JSON.parse(old.result as string) as {asset:Asset;version:AssetVersion};
    return {asset:assets.getAuthorizedAsset(principal,result.asset.id),version:assets.getAuthorizedVersion(principal,{assetId:result.asset.id,versionId:result.version.id})};
   };
   const previous=replay();if(previous)return previous;
   const paths=(args.files as unknown[]).map(value=>{
    if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['path','name'].includes(k)))return invalid();
    const item=value as {path?:unknown;name?:unknown};if(typeof item.path!=='string'||item.name!==undefined&&typeof item.name!=='string')return invalid();
    return {allowedRoot:outputRoot,relativePath:item.path,manifestPath:item.name as string ?? item.path};
   });
   store.database.prepare('INSERT OR IGNORE INTO run_artifact_intents VALUES (?,?,?,NULL)').run(principal.runId!,commandKey,hash);
   const staged=intent?.submission_id?{submissionId:intent.submission_id as string}:await files.stageFiles(principal,principal.runId!,paths);
   store.database.prepare('UPDATE run_artifact_intents SET submission_id=COALESCE(submission_id,?) WHERE run_id=? AND command_key=?').run(staged.submissionId,principal.runId!,commandKey);
   await authorize();
   const repeated=replay();if(repeated)return repeated;
   {
    const result=assets.importAsset(principal,{kind:'file',title:args.title as string,agentId:principal.agentId,submissionId:staged.submissionId,sourceVersions:sources},commandKey);
    store.database.prepare('INSERT INTO run_artifact_commands VALUES (?,?,?,?)').run(principal.runId!,commandKey,hash,JSON.stringify(result));return result;
   }
  },
  async update(args:Record<string,unknown>,commandKey:string):Promise<{asset:Asset;version:AssetVersion}>{
   await authorize();if(!maintenanceUpdate||!commandKey||commandKey.length>200)invalid();
   const gate=await maintenanceUpdate!(args),hash=createHash('sha256').update(JSON.stringify(['update',args])).digest('hex');await authorize();
   const old=store.database.prepare('SELECT input_hash,result FROM run_artifact_commands WHERE run_id=? AND command_key=?').get(principal.runId!,commandKey);
   if(old){if(old.input_hash!==hash)throw new DomainError('idempotency_conflict',409,'Command changed');const result=JSON.parse(old.result as string) as {asset:Asset;version:AssetVersion};await gate.authorize(false);return {asset:assets.getAuthorizedAsset(principal,result.asset.id),version:assets.getAuthorizedVersion(principal,{assetId:result.asset.id,versionId:result.version.id})};}
   await gate.authorize();const file=gate.version.files[0];
   const intent=store.database.prepare('SELECT input_hash,submission_id FROM run_artifact_intents WHERE run_id=? AND command_key=?').get(principal.runId!,commandKey);
   if(intent&&intent.input_hash!==hash)throw new DomainError('idempotency_conflict',409,'Command changed');
   store.database.prepare('INSERT OR IGNORE INTO run_artifact_intents VALUES (?,?,?,NULL)').run(principal.runId!,commandKey,hash);
   const stage=intent?.submission_id?files.readStaging(principal,principal.runId!,intent.submission_id as string):await files.stageFiles(principal,principal.runId!,[{allowedRoot:outputRoot,relativePath:args.path as string,manifestPath:file.path}]);
   await authorize();await gate.authorize();
   if(stage.files.length!==1||stage.files[0].size>96000)invalid();
   const handle=await open(files.blobPath(stage.files[0].blobHash),'r');let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await handle.readFile());}finally{await handle.close();}
   await gate.authorize();await authorize();gate.assertCommit();if(text.length>24000||text.includes('\0'))invalid();
   store.database.prepare('UPDATE run_artifact_intents SET submission_id=? WHERE run_id=? AND command_key=?').run(stage.submissionId,principal.runId!,commandKey);
   const record=(version:AssetVersion)=>{const result={asset:assets.getAuthorizedAsset(principal,version.assetId),version};store.database.prepare('INSERT INTO run_artifact_commands VALUES (?,?,?,?)').run(principal.runId!,commandKey,hash,JSON.stringify(result));return result;};
   if(stage.files[0].blobHash===file.blobHash)return store.transaction(()=>{gate.assertCommit();return record(gate.version);});
   let result:{asset:Asset;version:AssetVersion}|undefined;
   gate.assertCommit();assets.publishAssetVersion(principal,{assetId:gate.version.assetId,expectedHeadVersionId:gate.version.id,submissionId:stage.submissionId,files:stage.files,provenance:{runId:principal.runId,sourceVersions:[...new Map([{assetId:gate.version.assetId,versionId:gate.version.id},...sources].map(ref=>[ref.assetId+'@'+ref.versionId,ref])).values()]}},commandKey,undefined,undefined,version=>{result=record(version);});return result!;
  },
  async read(args:Record<string,unknown>){
   await assertActive();
   if(Object.keys(args).some(k=>!['assetId','versionId','fileId'].includes(k))||typeof args.assetId!=='string'||typeof args.versionId!=='string'||typeof args.fileId!=='string')invalid();
   const ref={assetId:args.assetId as string,versionId:args.versionId as string};
   const version=assets.getAuthorizedVersion(principal,ref);
   if(!sources.some(source=>source.assetId===ref.assetId&&source.versionId===ref.versionId)&&version.provenance.runId!==principal.runId)throw new DomainError('forbidden',403,'Read is limited to this Run input and output versions');
   const file=assets.readAssetFile(principal,{assetId:args.assetId as string,versionId:args.versionId as string},args.fileId as string);
   if(!file.mediaType.startsWith('text/')&&file.mediaType!=='application/json'){assets.recordView(principal,ref);return {name:file.name,size:file.size,mediaType:file.mediaType,text:null};}
   const handle=await open(file.blobPath,'r');try{
    const buffer=Buffer.alloc(Math.min(file.size,65536));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    // Recheck after asynchronous file I/O; a revoke must never release the buffered body.
    await assertActive();assets.readAssetFile(principal,{assetId:args.assetId as string,versionId:args.versionId as string},args.fileId as string);
    assets.recordView(principal,ref);
    return {name:file.name,size:file.size,mediaType:file.mediaType,text:buffer.subarray(0,bytesRead).toString('utf8'),truncated:bytesRead<file.size};
   }finally{await handle.close();}
  },
 };
}

// Repair only commands whose original body hash and Asset import dedup survived.
// The current actual publisher's recursive access is still required.
export function reconcileArtifactCommands(store:Store,assets:ReturnType<typeof createAssets>):number{
 const db=store.database;
 if(!db.prepare("SELECT name FROM sqlite_master WHERE name='run_artifact_intents'").get())return 0;
 let repaired=0;
 for(const row of db.prepare(`SELECT i.*,d.principal,d.version_id,v.asset_id FROM run_artifact_intents i JOIN command_dedup d ON d.command_key=i.command_key AND json_extract(d.principal,'$.runId')=i.run_id JOIN asset_versions v ON v.id=d.version_id AND json_extract(v.data,'$.provenance.runId')=i.run_id WHERE NOT EXISTS(SELECT 1 FROM run_artifact_commands c WHERE c.run_id=i.run_id AND c.command_key=i.command_key)`).all()){
  const principal=JSON.parse(row.principal as string) as Principal;
  try{
   const result={asset:assets.getAuthorizedAsset(principal,row.asset_id as string),version:assets.getAuthorizedVersion(principal,{assetId:row.asset_id as string,versionId:row.version_id as string})};
   store.transaction(()=>db.prepare('INSERT OR IGNORE INTO run_artifact_commands VALUES (?,?,?,?)').run(row.run_id as string,row.command_key as string,row.input_hash as string,JSON.stringify(result)));repaired++;
  }catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;}
 }
 return repaired;
}
