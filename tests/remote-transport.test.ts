import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createRemoteTransport } from '../server/remote-transport';
import { createRemoteFetch } from '../src/remote-client';
import { newRemoteKey, sealRemote, openRemote, remoteRequestId, MAX_REMOTE_BODY, boundedBody, toBase64 } from '../shared/remote-crypto';
const servers:Server[]=[];
async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(servers.splice(0).map(s=>{s.closeAllConnections();return new Promise<void>(r=>s.close(()=>r()));}));});
function routeFetch(url:string){const nativeFetch=globalThis.fetch;vi.stubGlobal('fetch',(input:string|URL|Request,init?:RequestInit)=>nativeFetch(input==='/api/remote/transport'?url+input:input,init));}
it('rejects replay and stale requests before dispatch and binds each encrypted response to its request',async()=>{
 const host=newRemoteKey(),phone=newRemoteKey();let calls=0;
 const transport=createRemoteTransport({identity:host,peer:()=>phone.publicKey,async dispatch(){calls++;return Response.json({ok:true});}});
 const url=await listen(createServer((req,res)=>{void transport(req,res);}));
 const id=remoteRequestId(),request={id,timestamp:Date.now(),method:'GET',path:'/api/conversations',headers:{},body:''},wire=sealRemote(request,host.publicKey,phone.secretKey);
 const send=(body:string)=>fetch(url+'/api/remote/transport',{method:'POST',body});
 const response=await send(wire);expect(response.status).toBe(200);
 const records=(await response.text()).trim().split('\n').map(line=>openRemote(line,host.publicKey,phone.secretKey));
 expect(records.map(r=>r.seq)).toEqual([0,1,2]);expect(records.every(r=>r.id===id)).toBe(true);expect(records.at(-1).type).toBe('end');
 expect((await send(wire)).status).toBe(403);expect((await send(sealRemote({...request,id:remoteRequestId(),timestamp:Date.now()-180000},host.publicKey,phone.secretKey))).status).toBe(403);expect(calls).toBe(1);
});
it.each(['truncated','reordered','wrong-request','tampered','after-end'])('errors the browser response stream for %s records',async(mode)=>{
 const host=newRemoteKey(),phone=newRemoteKey();
 const url=await listen(createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=openRemote(Buffer.concat(chunks).toString(),phone.publicKey,host.secretKey);
  const frame=(record:unknown)=>sealRemote(record,phone.publicKey,host.secretKey)+'\n';
  res.write(frame({id:request.id,seq:0,type:'headers',status:200,headers:{'content-type':'text/event-stream'}}));
  if(mode==='truncated'){res.end();return;}
  const record={id:mode==='wrong-request'?remoteRequestId():request.id,seq:mode==='reordered'?2:1,type:mode==='after-end'?'end':'data',body:toBase64(new TextEncoder().encode('marker'))};
  let wire=frame(record);if(mode==='tampered'){const v=JSON.parse(wire);v.box=(v.box[0]==='A'?'B':'A')+v.box.slice(1);wire=JSON.stringify(v)+'\n';}
  res.end(wire+(mode==='after-end'?'extra':''));
 }));routeFetch(url);
 const response=await createRemoteFetch(host.publicKey,phone)('/api/conversations/chat/events');await expect(response.text()).rejects.toThrow();
});
it('bounds requests and preserves the existing 20 MiB attachment limit',async()=>{
 const limit=new Uint8Array(MAX_REMOTE_BODY);
 expect((await boundedBody(new Blob([limit]).stream(),MAX_REMOTE_BODY)).length).toBe(20*1024*1024);
 await expect(boundedBody(new Blob([limit,new Uint8Array(1)]).stream(),MAX_REMOTE_BODY)).rejects.toThrow(/too large/);
 const host=newRemoteKey(),phone=newRemoteKey();let received=0;
 const transport=createRemoteTransport({identity:host,peer:()=>phone.publicKey,async dispatch(_req,inner){received=inner.body.length;return new Response(null,{status:204});}});
 const url=await listen(createServer((req,res)=>{void transport(req,res);}));routeFetch(url);
 expect((await createRemoteFetch(host.publicKey,phone)('/api/conversations/chat/attachments?name=boundary',{method:'POST',body:limit})).status).toBe(204);
 expect(received).toBe(MAX_REMOTE_BODY);
},15000);
it('persists replay protection across host restart before dispatch',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const home=mkdtempSync(join(tmpdir(),'mana-replay-'));
 try{
  const host=newRemoteKey(),phone=newRemoteKey();let calls=0;
  const options={identity:host,peer:()=>phone.publicKey,replayFile:join(home,'replay.json'),async dispatch(){calls++;return Response.json({ok:true});}};
  const wire=sealRemote({id:remoteRequestId(),timestamp:Date.now(),method:'GET',path:'/api/conversations',headers:{},body:''},host.publicKey,phone.secretKey);
  const first=createRemoteTransport(options),firstUrl=await listen(createServer((req,res)=>{void first(req,res);}));
  expect((await fetch(firstUrl,{method:'POST',body:wire})).status).toBe(200);
  const restarted=createRemoteTransport(options),secondUrl=await listen(createServer((req,res)=>{void restarted(req,res);}));
  expect((await fetch(secondUrl,{method:'POST',body:wire})).status).toBe(403);expect(calls).toBe(1);
 }finally{rmSync(home,{recursive:true,force:true});}
});
it('accepts many complete response records coalesced into one fetch chunk',async()=>{
 const host=newRemoteKey(),phone=newRemoteKey();
 vi.stubGlobal('fetch',async(_input:string,init:RequestInit)=>{
  const request=openRemote(init.body as string,phone.publicKey,host.secretKey),records:string[]=[];
  const add=(record:object)=>records.push(sealRemote({id:request.id,seq:records.length,...record},phone.publicKey,host.secretKey));
  add({type:'headers',status:200,headers:{}});for(let i=0;i<12;i++)add({type:'data',body:toBase64(new Uint8Array(48000))});add({type:'end'});
  return new Response(records.join('\n')+'\n');
 });
 const response=await createRemoteFetch(host.publicKey,phone)('/api/conversations/chat/attachments/item');expect((await response.arrayBuffer()).byteLength).toBe(576000);
});
