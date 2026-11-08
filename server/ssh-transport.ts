import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {isValidSshHost} from '../shared/execution-machines';
import {createHash} from 'node:crypto';

export const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export function sshArgs(host:string,command:string):string[]{
 if(!isValidSshHost(host))throw new Error('Invalid SSH host alias');
 return ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','--',host,command];
}
export function spawnSsh(host:string,command:string){return spawn('ssh',sshArgs(host,command),{stdio:'pipe',shell:false});}
export async function runSsh(host:string,command:string,input=''):Promise<string>{
 const child=spawnSsh(host,command);let stdout='',stderr='';
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error('SSH setup timed out'));},60000);
  child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>32*1024*1024)child.kill();});
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(`SSH failed (${code}): ${stderr.trim()}`));});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
// Both desktop packaging and local development install these same standalone bundles and their permission extension.
export async function sshBundleFiles(){
 const directories=[new URL('./ssh-runner/',import.meta.url),new URL('../release/ssh-runner/',import.meta.url)];
 for(const directory of directories){try{return {runner:await readFile(new URL('ssh-runner.mjs',directory)),cli:await readFile(new URL('mandala.mjs',directory)),extension:await readFile(new URL('pi-permission-extension.mjs',directory))};}catch{}}
 throw new Error('SSH service bundle unavailable; run node scripts/build-ssh-runner.mjs');
}
export async function installSshService(host:string):Promise<string>{
 const {runner,cli,extension}=await sshBundleFiles();const version=createHash('sha256').update(runner).update(cli).update(extension).digest('hex').slice(0,24);
 // Send source via stdin, never interpolate source or local environment into a remote shell.
 const install=`const fs=require('node:fs'),p=require('node:path'),os=require('node:os');const v=process.versions.node.split('.').map(Number);if(process.platform!=='linux'||v[0]<22||v[0]===22&&(v[1]<23||v[1]===23&&v[2]<2))throw Error('Linux and Node >=22.23.2 required');const root=p.join(os.homedir(),'.mandala-execution');fs.mkdirSync(root,{recursive:true,mode:448});let st=fs.lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&63))throw Error('Unsafe execution directory');const dir=p.join(root,${JSON.stringify(version)});fs.mkdirSync(dir,{mode:448,recursive:true});if(fs.lstatSync(dir).isSymbolicLink())throw Error('Unsafe bundle directory');for(const [name,data]of Object.entries(${JSON.stringify({'ssh-runner.mjs':runner.toString('base64'),'mandala.mjs':cli.toString('base64'),'pi-permission-extension.mjs':extension.toString('base64')})})){const target=p.join(dir,name);if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink()||fs.readFileSync(target,'base64')!==data)throw Error('Bundle collision');}else fs.writeFileSync(target,Buffer.from(data,'base64'),{mode:384,flag:'wx'});}process.stdout.write(dir);`;
 const result=(await runSsh(host,'node',install)).trim();
 if(!result.startsWith('/')||/[\r\n\0]/.test(result))throw new Error('Invalid SSH service installation path');
 return result;
}
