import type { AuthorizedFile } from '../shared/assets';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../shared/workspace-contracts';
const run=promisify(execFile);
export async function openLocalAsset(home:string,file:AuthorizedFile,action:'open'|'reveal'):Promise<void>{
 if(action!=='open'&&action!=='reveal')throw new DomainError('invalid_request',422,'Invalid file action');
 // Never open the content-addressed blob: external editors get an independent named copy.
 const input=await open(file.blobPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let directory:string|undefined;
 try{
  const stat=await input.stat();if(!stat.isFile()||stat.size!==file.size)throw new DomainError('blob_missing',409,'Content missing; restore from backup');
  directory=await mkdtemp(join(home,'file-open-'));const path=join(directory,basename(file.name));
  const output=await open(path,'wx',0o600);
  try{await output.writeFile(input.createReadStream({autoClose:false}));}finally{await output.close();}
  const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','explorer.exe'):'xdg-open';
  const args=process.platform==='darwin'?[...action==='reveal'?['-R']:[],path]:process.platform==='win32'?[action==='reveal'?'/select,'+path:path]:[action==='reveal'?dirname(path):path];
  try{await run(command,args,{timeout:10000,windowsHide:true});}catch{throw new DomainError('local_open_failed',503,'无法打开本地文件，请下载后使用本机应用打开。');}
 }catch(error){if(directory)await rm(directory,{recursive:true,force:true});throw error;}finally{await input.close();}
}
