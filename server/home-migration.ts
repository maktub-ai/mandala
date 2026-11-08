import { constants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireWorkspaceMaintenance } from './store';
import { claimServiceHome } from './service-home-lock';
import { rebaseManagedPaths } from './workspace-backup';

async function entry(path:string){
 try{return await fs.lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
const inside=(root:string,path:string)=>path===root||path.startsWith(root+sep);
const transient=new Set(['.workspace-maintenance','.service-home-lock','.store-leases','.desktop-runtime.json']);
const run=promisify(execFile);
async function validateMetadata(home:string,names:string[]){
 for(const name of names){const item=await entry(join(home,name));if(item&&!item.isFile())throw new Error('migration_unsafe_metadata');}
}
function alive(pid:number){
 if(!Number.isSafeInteger(pid)||pid<1)throw new Error('workspace_in_use');
 try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
}
async function refuseNestedUsers(root:string){
 for(const child of await fs.readdir(root,{withFileTypes:true})){
  const path=join(root,child.name);
  if(child.name==='.service-home-lock'){
   if(!child.isFile()||alive(JSON.parse(await fs.readFile(path,'utf8')).pid))throw new Error('workspace_in_use');
  }else if(child.name==='.store-leases'){
   if(!child.isDirectory())throw new Error('workspace_in_use');
   for(const name of await fs.readdir(path)){
    const match=/^([1-9][0-9]*)-[0-9a-f-]{36}$/.exec(name);
    if(!match||alive(Number(match[1])))throw new Error('workspace_in_use');
   }
  }else if(child.isDirectory())await refuseNestedUsers(path);
 }
}

/** Offline only. The original directory becomes the complete backup, never a partial restore. */
export async function migrateHome(from:string,to:string,backup:string,nestedHomes:string[]=[]){
 from=resolve(from);to=resolve(to);backup=resolve(backup);
 const suffix=basename(from).slice('.open-mana'.length);
 if(!['','-account-service','-releases'].includes(suffix)||basename(from)!=='.open-mana'+suffix||
    basename(to)!=='.mandala'+suffix||dirname(from)!==dirname(to)||inside(from,backup)||inside(to,backup))throw new Error('invalid_home_migration_paths');
 const source=await entry(from),target=await entry(to);
 if(source?.isSymbolicLink()&&target?.isDirectory()&&await fs.realpath(from)===await fs.realpath(to))return {status:'already_migrated',from,to,backup};
 if(!source?.isDirectory()||source.isSymbolicLink())throw new Error('migration_source_unavailable');
 if(target)throw new Error('migration_target_exists');
 if(await entry(backup))throw new Error('migration_backup_exists');
 const homes=[''];
 for(const relative of new Set(nestedHomes)){
  if(suffix||!relative||isAbsolute(relative)||relative.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))throw new Error('invalid_nested_home');
  let path=from;
  for(const part of relative.split(/[\\/]/)){path=join(path,part);if(!(await entry(path))?.isDirectory())throw new Error('invalid_nested_home');}
  homes.push(relative);
 }
 if(suffix==='-releases'&&await entry(join(from,'release.lock')))throw new Error('release_in_use');
 const marker=to+'.migrating';await fs.mkdir(marker,{mode:0o700});
 const locks:{home:string;service:ReturnType<typeof claimServiceHome>;maintenance?:ReturnType<typeof acquireWorkspaceMaintenance>}[]=[];
 let stage:string|undefined,backupCreated=false,moved=false,published=false,alias=false,complete=false;
 try{
  if(!suffix)for(const child of await fs.readdir(from,{withFileTypes:true}))if(child.isDirectory()&&!transient.has(child.name))await refuseNestedUsers(join(from,child.name));
  for(const home of homes){const lock={home,service:claimServiceHome(join(from,home)),maintenance:undefined as ReturnType<typeof acquireWorkspaceMaintenance>|undefined};locks.push(lock);lock.maintenance=acquireWorkspaceMaintenance(join(from,home));}
  const metadata=suffix==='-releases'?['current.json','control-current.json']:['config.json','accounts.json','state.sqlite','state.sqlite-wal','state.sqlite-shm','state.sqlite-journal'];
  for(const home of homes){await validateMetadata(join(from,home),metadata);if(!suffix&&!await entry(join(from,home,'state.sqlite')))throw new Error('migration_missing_database');}
  await fs.mkdir(dirname(backup),{recursive:true,mode:0o700});
  const realBackup=join(await fs.realpath(dirname(backup)),basename(backup)),realSource=await fs.realpath(from),realTarget=join(await fs.realpath(dirname(to)),basename(to));
  if(inside(realSource,realBackup)||inside(to,realBackup))throw new Error('invalid_home_migration_paths');
  if((await fs.stat(dirname(backup))).dev!==source.dev)throw new Error('migration_backup_requires_same_filesystem');
  stage=await fs.mkdtemp(join(dirname(to),'.mandala-home-stage-'));
  if(process.platform==='darwin')await run('/bin/cp',['-cR',from+'/.',stage]);
  else await fs.cp(from,stage,{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
  for(const home of homes){
   for(const name of transient)await fs.rm(join(stage,home,name),{recursive:true,force:true});
   await validateMetadata(join(stage,home),metadata);
   if(!suffix){
   for(const old of new Set([from,realSource]))await rebaseManagedPaths(join(stage,home),old,to,realTarget,['']);
   const db=new DatabaseSync(join(stage,home,'state.sqlite'),{readOnly:true});
   try{if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('migration_invalid_database');}finally{db.close();}
   }
  }
  if(suffix==='-releases')for(const name of ['current.json','control-current.json']){
   const path=join(stage,name);if(!await entry(path))continue;
   const manifest=JSON.parse(await fs.readFile(path,'utf8'));
   for(const key of ['directory','home'])if(typeof manifest[key]==='string'){
    for(const ending of ['-account-service','-releases','']){
     const old=join(dirname(from),'.open-mana'+ending),current=join(dirname(from),'.mandala'+ending);
     if(inside(old,manifest[key]))manifest[key]=current+manifest[key].slice(old.length);
    }
   }
   await fs.writeFile(path,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  }
  if(await entry(to))throw new Error('migration_target_exists');
  await fs.mkdir(backup,{mode:0o700});backupCreated=true;
  await fs.rename(from,join(backup,'home'));moved=true;
  await fs.rename(stage,to);published=true;
  await fs.symlink(to,from,process.platform==='win32'?'junction':'dir');alias=true;
  await fs.writeFile(join(backup,'migration.json'),JSON.stringify({from,to,backupHome:join(backup,'home'),nestedHomes:homes.slice(1),migratedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  complete=true;
  return {status:'migrated',from,to,backup};
 }finally{
  if(!complete){
   if(alias)await fs.unlink(from);
   if(moved)await fs.rename(join(backup,'home'),from);
   if(published)await fs.rename(to,stage!);
  }
  for(const lock of locks.reverse()){lock.maintenance?.release();lock.service.release();}
  if(complete)for(const home of homes)for(const name of ['.workspace-maintenance','.service-home-lock'])await fs.rm(join(backup,'home',home,name),{recursive:true,force:true});
  if(stage)await fs.rm(stage,{recursive:true,force:true});
  if(backupCreated&&!complete)await fs.rm(backup,{recursive:true,force:true});
  await fs.rmdir(marker);
 }
}
