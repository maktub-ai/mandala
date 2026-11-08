import {createServer,createConnection,type Socket} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdir,lstat,unlink} from 'node:fs/promises';
import {dirname,join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {SshService,type RemoteFactory} from './ssh-service';
import {SSH_FRAME_LIMIT,SSH_PROTOCOL_VERSION,type SshRequest,type SshEvent} from '../shared/ssh-execution';

const here=dirname(fileURLToPath(import.meta.url));
function assertPlatform(){const [major,minor,patch]=process.versions.node.split('.').map(Number);if(process.platform!=='linux'||major<22||major===22&&(minor<23||minor===23&&patch<2))throw new Error('Remote execution requires Linux and Node >=22.23.2');}
async function privateDirectory(path:string){await mkdir(path,{recursive:true,mode:0o700});const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('Unsafe SSH service directory');}
export async function runSshDaemon(directory:string,factory?:RemoteFactory){
 await privateDirectory(directory);const service=new SshService(join(directory,'data'),join(here,'mandala.mjs'),factory);
 await privateDirectory(service.home);const socket=join(directory,'service.sock');
 const instanceId=randomUUID();const sweeper=setInterval(()=>{void service.sweepIdle();},60000);sweeper.unref();
 const server=createServer(connection=>{
  let attached=false;let cursor=0;let runtimeId:string|undefined;let unsubscribe=()=>{};
  const send=(frame:unknown)=>{if(!connection.destroyed){if(connection.writableLength>SSH_FRAME_LIMIT*2){connection.destroy();return;}connection.write(JSON.stringify(frame)+'\n');}};
  const event=(value:SshEvent)=>{if(attached&&(!runtimeId||value.runtimeId===runtimeId)&&value.sequence>cursor){send({event:value});cursor=value.sequence;}};
  service.on('event',event);
  let buffer='';connection.setEncoding('utf8');
  connection.on('data',chunk=>{
   buffer+=chunk;if(Buffer.byteLength(buffer)>SSH_FRAME_LIMIT){connection.destroy();return;}
   let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let request:SshRequest;
    try{request=JSON.parse(line);}catch{connection.destroy();return;}
    if(request.method==='attach'){
     try{unsubscribe();runtimeId=request.params.runtimeId;unsubscribe=service.subscribe(runtimeId);const requestedCursor=request.params.cursor===null||request.params.cursor===undefined?undefined:Number(request.params.cursor);const replay=service.eventsAfter(requestedCursor,runtimeId);cursor=requestedCursor??0;attached=true;send({id:request.id,result:{attached:true,instanceId,bundleVersion:basename(here),protocolVersion:SSH_PROTOCOL_VERSION,sequence:service.currentSequence()}});for(const value of replay)event(value);cursor=service.currentSequence();send({checkpoint:cursor});}catch(error){send({id:request.id,error:{message:(error as Error).message}});}continue;
    }
    if(!attached){send({id:request.id,error:{message:'Attach required'}});continue;}
    void service.request(request).then(result=>send({id:request.id,result}),error=>send({id:request.id,error:{message:error.message,code:error.code,status:error.status}}));
   }
  });
  connection.on('error',()=>{});connection.on('close',()=>{service.off('event',event);unsubscribe();});
 });
 server.on('error',error=>{if((error as NodeJS.ErrnoException).code==='EADDRINUSE')process.exit(0);console.error(error);process.exit(1);});
 server.listen(socket);
 for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void service.shutdown().finally(()=>server.close(()=>process.exit(0)));});
}
async function connect(path:string):Promise<Socket>{return new Promise((resolve,reject)=>{const socket=createConnection(path);socket.once('connect',()=>resolve(socket));socket.once('error',reject);});}
export async function attachSshDaemon(directory:string){
 await privateDirectory(directory);const path=join(directory,'service.sock');let socket:Socket|undefined;
 try{socket=await connect(path);}catch(error){
  if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;
  if((error as NodeJS.ErrnoException).code==='ECONNREFUSED')await unlink(path).catch(()=>{});
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--daemon',directory],{detached:true,stdio:'ignore',env:process.env});child.unref();
  for(let i=0;i<100;i++){try{socket=await connect(path);break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
 }
 if(!socket)throw new Error('Remote service could not start');
 process.stdin.pipe(socket);socket.pipe(process.stdout);process.stdin.on('end',()=>socket!.end());socket.on('error',error=>{console.error(error.message);process.exitCode=1;});socket.on('close',()=>process.stdin.destroy());
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assertPlatform();const [mode,directory]=process.argv.slice(2);if(!directory)throw new Error('Missing service directory');
 if(mode==='--daemon')await runSshDaemon(directory);else if(mode==='--attach')await attachSshDaemon(directory);else throw new Error('Unknown service mode');
}
