import { existsSync, lstatSync, mkdirSync, rmdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownedPrivatePath } from '../cli/private-path.mjs';
export function claimServiceHome(home:string){
 mkdirSync(home,{recursive:true,mode:0o700});
 const path=join(realpathSync(resolve(home)),'.service-home-lock'),token=randomUUID();
 const read=()=>{const stat=lstatSync(path);if(!stat.isFile()||!ownedPrivatePath(path,stat,4096))throw new Error('unsafe_service_home_lock');const record=JSON.parse(readFileSync(path,'utf8')) as {pid:number;token:string};if(!Number.isSafeInteger(record.pid)||record.pid<1||typeof record.token!=='string'||!record.token)throw new Error('unsafe_service_home_lock');return {record,stat};};
 // The recovery directory serializes removal of a stale record. Normal live claims
 // still use exclusive creation. An interrupted recovery is a conservative blocker.
 const recovery=path+'-recovery';
 if(existsSync(recovery))throw new Error('service_home_in_use');
 try{writeFileSync(path,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});if(existsSync(recovery)){if(read().record.token===token)unlinkSync(path);throw new Error('service_home_in_use');}}
 catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  const previous=read();let dead=false;try{process.kill(previous.record.pid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
  if(!dead)throw new Error('service_home_in_use');
  try{mkdirSync(recovery,{mode:0o700});}catch{throw new Error('service_home_in_use');}
  try{const current=read();if(current.stat.ino!==previous.stat.ino||current.stat.dev!==previous.stat.dev||current.record.token!==previous.record.token)throw new Error('service_home_in_use');unlinkSync(path);writeFileSync(path,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});}
  finally{rmdirSync(recovery);}
 }
 let released=false;
 return {release(){if(released)return;released=true;try{if(read().record.token===token)unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}};
}
