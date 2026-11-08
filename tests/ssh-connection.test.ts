import {expect,it,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {SshRpcConnection} from '../server/ssh-execution';

function transportFixture(restart=false){
 let launches=0,executions=0;const children:any[]=[],requests:any[]=[];const dedupe=new Map<string,unknown>();
 const spawn=vi.fn(()=>{
  const generation=++launches;const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{if(!child.killed){child.killed=true;child.stdin.destroy();queueMicrotask(()=>child.emit('close',1));}return true;};children.push(child);
  child.stdin.on('data',(bytes:Buffer)=>{for(const line of bytes.toString().trim().split('\n')){
   const request=JSON.parse(line);requests.push(request);
   const reply=(value:any)=>child.stdout.write(JSON.stringify(value)+'\n');
   if(request.method==='attach'){reply({id:request.id,result:{attached:true,instanceId:restart&&generation>1?'new-daemon':'same-daemon'}});continue;}
   if(request.method==='runtime.start'){
    if(!dedupe.has(request.id)){executions++;dedupe.set(request.id,{nativeId:'native-1'});}
    if(generation===1){child.kill();continue;}reply({id:request.id,result:dedupe.get(request.id)});
   }
  }});return child;
 });
 return {spawn,requests,children,get executions(){return executions;}};
}
it('reattaches and resends the exact uncertain request id without duplicating start',async()=>{
 const fixture=transportFixture(),connection=new SshRpcConnection('host','/remote/service',fixture.spawn as any);
 try{expect(await connection.request('runtime.start',{cli:'codex'})).toEqual({nativeId:'native-1'});expect(fixture.executions).toBe(1);const starts=fixture.requests.filter(request=>request.method==='runtime.start');expect(starts).toHaveLength(2);expect(starts[0].id).toBe(starts[1].id);expect(fixture.spawn).toHaveBeenCalledTimes(2);}finally{connection.close();}
});
it('rejects uncertain start after a daemon restart instead of replaying it',async()=>{
 const fixture=transportFixture(true),connection=new SshRpcConnection('host','/remote/service',fixture.spawn as any),disconnected=vi.fn();connection.onDisconnect=disconnected;
 try{await expect(connection.request('runtime.start',{cli:'codex'})).rejects.toThrow(/restarted/);expect(fixture.requests.filter(request=>request.method==='runtime.start')).toHaveLength(1);expect(fixture.executions).toBe(1);expect(disconnected).toHaveBeenCalledOnce();}finally{connection.close();}
});
it('detaches pending requests with an explicit unknown execution state',async()=>{
 const fixture=transportFixture(),connection=new SshRpcConnection('host','/remote/service',fixture.spawn as any);const request=connection.request('never-replies',{});await vi.waitFor(()=>expect(fixture.requests.some(request=>request.method==='never-replies')).toBe(true));connection.close();await expect(request).rejects.toThrow(/may still be running/);
});
it('rejects a stale service bundle before sending any native start request',async()=>{
 const fixture=transportFixture(),connection=new SshRpcConnection('host','/remote/0123456789abcdef01234567',fixture.spawn as any);
 try{await expect(connection.request('runtime.start',{cli:'codex'})).rejects.toThrow(/version differs/);expect(fixture.executions).toBe(0);expect(fixture.requests.every(request=>request.method==='attach')).toBe(true);}finally{connection.close();}
});
