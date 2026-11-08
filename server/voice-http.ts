import type {IncomingMessage,ServerResponse} from 'node:http';
import {createVoiceService} from './voice';
import {readJsonBody} from './http-body';
import {VOICE_MAX_BYTES} from '../shared/voice';
import {DomainError} from '../shared/workspace-contracts';
export function createVoiceHttp(home:string){
 const service=createVoiceService(home);
 const json=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 async function handle(req:IncomingMessage,res:ServerResponse,url:URL){
  if(!url.pathname.startsWith('/api/voice'))return false;
  if(url.pathname==='/api/voice'&&req.method==='GET'){json(res,await service.status());return true;}
  if(url.pathname==='/api/voice'&&req.method==='PUT'){json(res,await service.configure(await readJsonBody(req,{maxBytes:4096,contentTypeError:'Expected JSON',sizeError:'Voice settings too large'})));return true;}
  const model=url.pathname.match(/^\/api\/voice\/models\/([a-z0-9-]+)$/);
  if(model&&req.method==='POST'){json(res,await service.download(model[1]));return true;}
  if(model&&req.method==='DELETE'){json(res,await service.remove(model[1]));return true;}
  if(url.pathname==='/api/voice/transcribe'&&req.method==='POST'){
   if(req.headers['content-type']!=='audio/wav')throw new DomainError('voice_audio',415,'Expected audio/wav');
   const chunks:Buffer[]=[];let length=0;
   for await(const chunk of req.iterator({destroyOnReturn:false})){length+=chunk.length;if(length>VOICE_MAX_BYTES){req.resume();throw new DomainError('voice_audio',413,'Recording is too large');}chunks.push(chunk);}
   const provider=req.headers['x-mandala-voice-provider'];
   if(provider!=='local'&&provider!=='openai')throw new DomainError('voice_provider',422,'Choose a voice provider before recording');
   const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
   try{json(res,{text:await service.transcribe(Buffer.concat(chunks),controller.signal,provider)});}finally{res.off('close',cancel);}return true;
  }
  throw new DomainError('voice_route',405,'Unsupported voice operation');
 }
 return {handle,close:service.close};
}
