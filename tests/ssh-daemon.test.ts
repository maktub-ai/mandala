import {expect,it} from 'vitest';
import {openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createConnection,type Socket} from 'node:net';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

it('keeps a native process and approvals across detached socket connections, deduplicates start, and acknowledges interrupt',async()=>{
 const home=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'mandala-daemon-'));const socketPath=join(home,'service.sock'),receipt=join(home,'survived');
 const runner=pathToFileURL(resolve('server/ssh-runner.ts')).href,script=join(home,'fixture.mjs');
 await writeFile(script,`import {runSshDaemon} from ${JSON.stringify(runner)};import {openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';let child;await runSshDaemon(${JSON.stringify(home)},async(cli,options)=>({getStatus:async()=>({status:'ready',pid:child?.pid}),startTurn:async()=>{child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(receipt)},'alive');setInterval(()=>{},1000)`)}],{stdio:'ignore'});child.on('exit',()=>options.onEvent({method:'turn/completed',params:{turn:{id:'turn',status:'interrupted'}}}));options.onEvent({method:'turn/started',params:{turn:{id:'turn'}}});options.onApproval({id:9,method:'approval',params:{}});return 'turn'},replyApproval(){},interrupt:async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve))},close(){child?.kill()}}));`);
 const diagnostics=join(home,'stderr.log'),log=openSync(diagnostics,'a');
 const daemon=spawn(process.execPath,['--import','tsx',script],{cwd:process.cwd(),detached:true,stdio:['ignore','ignore',log]});closeSync(log);daemon.unref();const sockets:Socket[]=[];
 const attach=async(cursor=0)=>{
  let socket:Socket|undefined;for(let i=0;i<100;i++){try{socket=await new Promise<Socket>((resolve,reject)=>{const value=createConnection(socketPath);value.once('connect',()=>resolve(value));value.once('error',reject);});break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
  if(!socket)throw new Error('Daemon did not start: '+await readFile(diagnostics,'utf8'));sockets.push(socket);const events:any[]=[],pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();let buffer='';socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const frame=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);if(frame.event)events.push(frame.event);else if(!('checkpoint'in frame)){const entry=pending.get(frame.id);pending.delete(frame.id);frame.error?entry?.reject(new Error(frame.error.message)):entry?.resolve(frame.result);}}});
  const call=(method:string,params:any,id:string=randomUUID())=>new Promise<any>((resolve,reject)=>{pending.set(id,{resolve,reject});socket!.write(JSON.stringify({id,method,params})+'\n');});
  const handshake=await call('attach',{cursor});return {socket,call,events,handshake};
 };
 try{
  const first=await attach(),start={runtimeId:'chat',cli:'codex',options:{cwd:home}};await first.call('runtime.start',start,'stable-start');expect(await first.call('runtime.call',{runtimeId:'chat',method:'startTurn',args:['thread','hello']})).toBe('turn');
  const status=await first.call('runtime.call',{runtimeId:'chat',method:'getStatus',args:[]});expect(status.pid).toBeGreaterThan(0);first.socket.destroy();
  await expect.poll(()=>readFile(receipt,'utf8').catch(()=>''),{timeout:3000}).toBe('alive');expect(()=>process.kill(status.pid,0)).not.toThrow();
  const second=await attach();expect(second.handshake.instanceId).toBe(first.handshake.instanceId);await expect.poll(()=>second.events.map(event=>event.kind)).toEqual(['event','approval']);expect(second.events[1].payload.id).toBe(9);
  await second.call('runtime.start',start,'stable-start');expect((await second.call('runtime.call',{runtimeId:'chat',method:'getStatus',args:[]})).pid).toBe(status.pid);
  await second.call('runtime.call',{runtimeId:'chat',method:'replyApproval',args:[9,{approved:false}]});await second.call('runtime.call',{runtimeId:'chat',method:'interrupt',args:['thread','turn']});
  await expect.poll(()=>second.events.some(event=>event.payload?.method==='turn/completed')).toBe(true);expect(()=>process.kill(status.pid,0)).toThrow();
 }finally{for(const socket of sockets)socket.destroy();if(daemon.pid){try{process.kill(daemon.pid,'SIGTERM');}catch{}}await new Promise(resolve=>setTimeout(resolve,100));await rm(home,{recursive:true,force:true});}
},15000);
