import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../shared/workspace-contracts';
const run=promisify(execFile);
// Callers must recheck conversation access and file scope before launching the OS.
export async function openLocalFile(path:string):Promise<void>{
 const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?join(process.env.SystemRoot??'C:\\Windows','explorer.exe'):'xdg-open';
 try{await run(command,[path],{shell:false,timeout:10000,windowsHide:true});}
 catch{throw new DomainError('local_open_failed',503,'无法打开本地文件，请下载后使用本机应用打开。');}
}
