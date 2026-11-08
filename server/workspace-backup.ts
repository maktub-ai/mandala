import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {acquireWorkspaceMaintenance} from './store';

const files=['state.sqlite','config.json','knowledge.json','automations.json','desktop-appearance.json','desktop-preferences.json'];
const directories=['blobs','attachments','workspaces','outputs','market/packages'];
type Entry={path:string;size:number;sha256:string;mode:number};
type Manifest={version:1;createdAt:string;sourceHome:string;sourceRealHome:string;files:Entry[];directories:string[]};
const contained=(root:string,path:string)=>path===root||path.startsWith(root+sep);
const managed=(path:string)=>files.includes(path)||directories.some(root=>path===root||path.startsWith(root+'/'));
const validPath=(path:unknown):path is string=>typeof path==='string'&&!isAbsolute(path)&&!path.includes('\\')&&!path.split('/').some(part=>!part||part==='.'||part==='..')&&managed(path);
async function hash(path:string){const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}
async function absent(path:string){try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw new Error('backup_destination_exists');}
async function collect(root:string){
 const paths:string[]=[],dirs:string[]=[];
 const visit=async(path:string)=>{
  const info=await lstat(join(root,path));
  if(info.isDirectory()){dirs.push(path);for(const name of await readdir(join(root,path)))await visit(path+'/'+name);}
  else if(info.isFile())paths.push(path);else throw new Error('backup_unsafe_file');
 };
 for(const path of [...files,...directories]){
  try{await lstat(join(root,path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  // An allowed nested root must not cross a symbolic link either.
  if(path.includes('/')){const parent=await lstat(join(root,dirname(path)));if(!parent.isDirectory())throw new Error('backup_unsafe_file');}
  await visit(path);
 }
 return {paths,dirs};
}
async function targetDirectory(path:string){
 const requested=resolve(path);await absent(requested);let parent=dirname(requested),suffix=basename(requested);
 while(true){try{return join(await realpath(parent),suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;suffix=join(basename(parent),suffix);parent=dirname(parent);}}
}
function checkDatabase(path:string){const db=new DatabaseSync(path,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('backup_invalid_database');}finally{db.close();}}

/** Offline, application-managed data only. Native authentication/history is intentionally outside this boundary. */
export async function backupWorkspace(home:string,output:string):Promise<void>{
 const source=await realpath(home),target=await targetDirectory(output);
 if(contained(source,target))throw new Error('backup_inside_workspace');
 const maintenance=acquireWorkspaceMaintenance(source);let temporary:string|undefined;
 try{
  const {paths,dirs}=await collect(source);if(!paths.includes('state.sqlite'))throw new Error('backup_missing_database');
  await mkdir(dirname(target),{recursive:true,mode:0o700});temporary=await mkdtemp(join(dirname(target),'.mandala-backup-'));await chmod(temporary,0o700);
  for(const path of dirs)await mkdir(join(temporary,path),{recursive:true,mode:0o700});
  const entries:Entry[]=[];
  for(const path of paths){
   const destination=join(temporary,path);await mkdir(dirname(destination),{recursive:true,mode:0o700});
   if(path==='state.sqlite'){const db=new DatabaseSync(join(source,path),{readOnly:true});try{await backup(db,destination);}finally{db.close();}checkDatabase(destination);}
   else await copyFile(join(source,path),destination);
   const mode=0o600|((await lstat(join(source,path))).mode&0o100);
   await chmod(destination,mode);entries.push({path,size:(await lstat(destination)).size,sha256:await hash(destination),mode});
  }
  const manifest:Manifest={version:1,createdAt:new Date().toISOString(),sourceHome:resolve(home),sourceRealHome:source,files:entries,directories:dirs};
  await writeFile(join(temporary,'backup.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  await absent(target);await rename(temporary,target);temporary=undefined;
 }finally{if(temporary)await rm(temporary,{recursive:true,force:true});maintenance.release();}
}
function rebasePath(value:string,oldHome:string,newHome:string,roots=directories){
 if(!isAbsolute(value))return value;
 const path=resolve(value);
 for(const root of roots){const prefix=join(oldHome,root);if(contained(prefix,path))return join(newHome,relative(oldHome,path));}
 return value;
}
export async function rebaseManagedPaths(home:string,oldHome:string,newHome:string,newRealHome:string,roots=directories){
 const configPath=join(home,'config.json');
 try{
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const visit=(value:unknown):void=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){
   if(typeof item==='string'&&['cwd','path','location','command'].includes(key))(value as Record<string,unknown>)[key]=rebasePath(item,oldHome,newHome,roots);
   else if(key==='args'&&Array.isArray(item))(value as Record<string,unknown>)[key]=item.map(arg=>typeof arg==='string'?rebasePath(arg,oldHome,newHome,roots):arg);
   else visit(item);
  }};
  visit(config);await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const db=new DatabaseSync(join(home,'state.sqlite'));
 try{
  db.exec('BEGIN');const has=(name:string)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(has('conversations'))for(const row of db.prepare('SELECT id,data FROM conversations').all()){
   const data=JSON.parse(row.data as string);if(typeof data.cwd==='string'){data.cwd=rebasePath(data.cwd,oldHome,newHome,roots);db.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify(data),row.id);}
  }
  if(has('events'))for(const row of db.prepare("SELECT id,data FROM events WHERE kind='user'").all()){
   const data=JSON.parse(row.data as string);if(!Array.isArray(data.attachments))continue;let changed=false;
   for(const item of data.attachments)if(item&&typeof item.path==='string'){
    const path=rebasePath(item.path,oldHome,newHome,roots);if(path!==item.path){item.path=path;changed=true;}
   }
   if(changed)db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
  }
  if(has('task_directory_claims'))for(const row of db.prepare('SELECT kind,owner_id,paths FROM task_directory_claims').all()){
   const paths=(JSON.parse(row.paths as string) as string[]).map(path=>rebasePath(path,oldHome,newRealHome,roots));db.prepare('UPDATE task_directory_claims SET paths=? WHERE kind=? AND owner_id=?').run(JSON.stringify(paths),row.kind,row.owner_id);
  }
  db.exec('COMMIT');
 }finally{db.close();}
}
/** Restore is published atomically to a new directory; existing homes are never overwritten. */
export async function restoreWorkspace(input:string,home:string):Promise<void>{
 const source=await realpath(input),target=await targetDirectory(home);
 if(contained(source,target))throw new Error('backup_inside_workspace');
 const manifest=JSON.parse(await readFile(join(source,'backup.json'),'utf8')) as Manifest;
 if(manifest.version!==1||typeof manifest.sourceHome!=='string'||!isAbsolute(manifest.sourceHome)||typeof manifest.sourceRealHome!=='string'||!isAbsolute(manifest.sourceRealHome)||!Array.isArray(manifest.files)||!Array.isArray(manifest.directories)||!manifest.files.some(e=>e?.path==='state.sqlite'))throw new Error('backup_invalid_manifest');
 const seen=new Set<string>();
 for(const path of manifest.directories){if(!validPath(path)||!directories.some(root=>path===root||path.startsWith(root+'/'))||seen.has(path))throw new Error('backup_invalid_manifest');seen.add(path);}
 for(const entry of manifest.files){
  if(!validPath(entry.path)||seen.has(entry.path)||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256)||![0o600,0o700].includes(entry.mode))throw new Error('backup_invalid_manifest');seen.add(entry.path);
  for(let path=entry.path;path!=='.';path=dirname(path)){const info=await lstat(join(source,path));if(path===entry.path?!info.isFile():!info.isDirectory())throw new Error('backup_unsafe_file');}
  if((await lstat(join(source,entry.path))).size!==entry.size||await hash(join(source,entry.path))!==entry.sha256)throw new Error('backup_checksum_mismatch');
 }
 checkDatabase(join(source,'state.sqlite'));let temporary:string|undefined;
 try{
  await mkdir(dirname(target),{recursive:true,mode:0o700});temporary=await mkdtemp(join(dirname(target),'.mandala-restore-'));await chmod(temporary,0o700);
  for(const path of manifest.directories)await mkdir(join(temporary,path),{recursive:true,mode:0o700});
  for(const entry of manifest.files){const destination=join(temporary,entry.path);await mkdir(dirname(destination),{recursive:true,mode:0o700});await copyFile(join(source,entry.path),destination);await chmod(destination,entry.mode);}
  for(const oldHome of new Set([manifest.sourceHome,manifest.sourceRealHome]))await rebaseManagedPaths(temporary,oldHome,resolve(home),target);
  checkDatabase(join(temporary,'state.sqlite'));
  await absent(target);await rename(temporary,target);temporary=undefined;
 }finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
