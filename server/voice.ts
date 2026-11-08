import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,rename,rm,stat,writeFile,open,mkdtemp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {defaultVoiceSettings,voiceModels,voiceLanguages,VOICE_MAX_BYTES,VOICE_SAMPLE_RATE,type VoiceStatus,type VoiceSettings} from '../shared/voice';
import {DomainError} from '../shared/workspace-contracts';

const error=(code:string,status:number,message:string)=>new DomainError(code,status,message);
type Saved=Omit<VoiceSettings,'hasApiKey'>&{apiKey:string};
type ModelDownload={id:string;file:string;bytes:number;sha256:string;url:string};
export function validateVoiceWav(bytes:Buffer){
 if(bytes.length<46||bytes.length>VOICE_MAX_BYTES||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,16)!=='WAVEfmt '||bytes.readUInt32LE(4)!==bytes.length-8||bytes.readUInt32LE(16)!==16||bytes.readUInt16LE(20)!==1||bytes.readUInt16LE(22)!==1||bytes.readUInt32LE(24)!==VOICE_SAMPLE_RATE||bytes.readUInt32LE(28)!==VOICE_SAMPLE_RATE*2||bytes.readUInt16LE(32)!==2||bytes.readUInt16LE(34)!==16||bytes.toString('ascii',36,40)!=='data'||bytes.readUInt32LE(40)!==bytes.length-44||(bytes.length-44)%2)throw error('voice_audio',422,'Expected mono PCM16 WAV at 16 kHz, up to 120 seconds');
 return (bytes.length-44)/(VOICE_SAMPLE_RATE*2);
}
export async function downloadVoiceModel(directory:string,model:ModelDownload,signal:AbortSignal,progress:(bytes:number)=>void,fetcher:typeof fetch=fetch){
 await mkdir(directory,{recursive:true,mode:0o700});
 const temporary=join(directory,model.file+'.'+randomUUID()+'.part');
 try{
  signal.throwIfAborted();
  const response=await fetcher(model.url,{signal});
  if(!response.ok||!response.body)throw new Error('Model download failed');
  const handle=await open(temporary,'wx',0o600),hash=createHash('sha256');let count=0;
  const reader=response.body.getReader();
  try{while(true){signal.throwIfAborted();const {done,value:chunk}=await reader.read();if(done)break;count+=chunk.length;if(count>model.bytes)throw new Error('Model size mismatch');hash.update(chunk);await handle.writeFile(chunk);progress(count);}}
  finally{await reader.cancel();await handle.close();}
  signal.throwIfAborted();
  if(count!==model.bytes||hash.digest('hex')!==model.sha256)throw new Error('Model checksum mismatch');
  await rename(temporary,join(directory,model.file));
 }finally{await rm(temporary,{force:true});}
}
async function localTranscribe(model:string,wav:string,language:string,signal:AbortSignal):Promise<string>{
 const require=createRequire(import.meta.url),root=dirname(require.resolve('@kutalia/whisper-node-addon/package.json'));
 const native=join(root,'dist',`${process.platform==='darwin'?'mac':process.platform}-${process.arch}`);
 return new Promise((resolve,reject)=>{
  // The upstream macOS prebuild uses build-machine rpaths. Scope library lookup to this child.
  const child=fork(fileURLToPath(new URL('./voice-worker.mjs',import.meta.url)),[model,wav,language,native],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],signal,env:{...process.env,...process.platform==='darwin'?{DYLD_LIBRARY_PATH:native}:{}}});
  let settled=false;
  const finish=(failure:Error|null,text='')=>{if(settled)return;settled=true;failure?reject(failure):resolve(text);};
  child.on('message',(value:any)=>{if(value&&typeof value.text==='string')finish(null,value.text);else finish(error('voice_local',502,'Local transcription failed'));});
  child.on('error',()=>finish(error('voice_local',502,'Local transcription was cancelled or could not start')));
  child.on('exit',()=>finish(error('voice_local',502,'Local speech engine exited without a result')));
 });
}
export function createVoiceService(home:string,options:{fetcher?:typeof fetch;localTranscribe?:typeof localTranscribe}={}){
 const fetcher=options.fetcher??fetch,directory=join(home,'voice-models'),path=join(home,'voice.json');
 const downloads=new Map<string,{controller:AbortController;promise:Promise<void>;downloaded:number;error?:string;downloading:boolean}>();
 let writing:Promise<unknown>=Promise.resolve(),active:AbortController|undefined;
 async function read():Promise<Saved>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){const {hasApiKey,...settings}=defaultVoiceSettings;return {...settings,apiKey:''};}throw error('voice_config',500,'Could not read voice settings');}}
 const findModel=(id:string)=>{const model=voiceModels.find(m=>m.id===id);if(!model)throw error('voice_model',422,'Unknown voice model');return model;};
 async function installed(id:string){const model=findModel(id);try{return (await stat(join(directory,model.file))).size===model.bytes;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
 async function status():Promise<VoiceStatus>{
  const {apiKey,...settings}=await read();
  return {settings:{...settings,hasApiKey:!!apiKey},models:await Promise.all(voiceModels.map(async model=>{const state=downloads.get(model.id);return {id:model.id,installed:await installed(model.id),downloaded:state?.downloaded??0,downloading:state?.downloading??false,...state?.error?{error:state.error}:{}};}))};
 }
 async function configure(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['enabled','provider','localModel','language','apiKey'].includes(key)))throw error('voice_config',422,'Invalid voice settings');
  const value=input as Partial<Saved>;
  if(value.enabled!==undefined&&typeof value.enabled!=='boolean'||value.provider!==undefined&&!['local','openai'].includes(value.provider)||value.language!==undefined&&!(voiceLanguages as readonly string[]).includes(value.language)||value.apiKey!==undefined&&(typeof value.apiKey!=='string'||value.apiKey.length>1024||/[^\x21-\x7e]/.test(value.apiKey)))throw error('voice_config',422,'Invalid voice settings');
  if(value.localModel!==undefined)findModel(value.localModel);
  const operation=writing.then(async()=>{
   const settings={...await read(),...value};const temporary=path+'.'+randomUUID()+'.tmp';
   await mkdir(home,{recursive:true,mode:0o700});
   try{await writeFile(temporary,JSON.stringify(settings)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
   active?.abort();return status();
  });writing=operation.catch(()=>{});return operation;
 }
 async function download(id:string){
  const model=findModel(id);if(downloads.get(id)?.downloading||await installed(id))return status();
  if([...downloads.values()].some(item=>item.downloading))throw error('voice_busy',409,'Another model is downloading');
  const controller=new AbortController(),state={controller,promise:Promise.resolve(),downloaded:0,downloading:true,error:undefined as string|undefined};downloads.set(id,state);
  state.promise=downloadVoiceModel(directory,{...model,url:`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`},AbortSignal.any([controller.signal,AbortSignal.timeout(30*60*1000)]),bytes=>{state.downloaded=bytes;},fetcher).catch(()=>{if(!controller.signal.aborted)state.error='Download failed. Check your connection and retry.';}).finally(()=>{state.downloading=false;});
  return status();
 }
 async function remove(id:string){const model=findModel(id);if(active)throw error('voice_busy',409,'Finish or cancel transcription first');const state=downloads.get(id);state?.controller.abort();await state?.promise;downloads.delete(id);await rm(join(directory,model.file),{force:true});return status();}
 async function transcribe(bytes:Buffer,signal:AbortSignal,expectedProvider?:string){
  validateVoiceWav(bytes);const settings=await read();if(!settings.enabled)throw error('voice_disabled',409,'Voice input is disabled');
  if(expectedProvider!==undefined&&expectedProvider!==settings.provider)throw error('voice_changed',409,'Voice settings changed. Start a new recording.');
  if(active)throw error('voice_busy',409,'Another transcription is running');
  const controller=new AbortController();active=controller;const combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(180000)]);let temporary:string|undefined;
  try{
   combined.throwIfAborted();let text:string;
   if(settings.provider==='openai'){
    if(!settings.apiKey)throw error('voice_key',409,'Configure an OpenAI API key first');
    const form=new FormData();form.set('model','gpt-transcribe');form.set('file',new Blob([new Uint8Array(bytes)],{type:'audio/wav'}),'dictation.wav');if(settings.language!=='auto')form.append('languages[]',settings.language);
    let response:Response;
    try{response=await fetcher('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${settings.apiKey}`},body:form,signal:combined,redirect:'error'});}catch{throw error('voice_cloud',502,'Could not reach OpenAI. Check your connection or cancel and retry.');}
    if(!response.ok){await response.body?.cancel();throw error('voice_cloud',502,`OpenAI transcription failed (HTTP ${response.status}). Check the API key and quota.`);}
    const result=await response.json();if(typeof result?.text!=='string'||result.text.length>50000)throw error('voice_cloud',502,'Invalid transcription response');text=result.text;
   }else{
    const model=findModel(settings.localModel);if(!await installed(model.id))throw error('voice_model',409,'Download the selected voice model in Settings first');
    const modelPath=join(directory,model.file),hash=createHash('sha256');for await(const chunk of createReadStream(modelPath)){combined.throwIfAborted();hash.update(chunk);}if(hash.digest('hex')!==model.sha256)throw error('voice_model',409,'Model checksum mismatch. Remove and download it again.');
    temporary=await mkdtemp(join(directory,'recording-'));const wav=join(temporary,'audio.wav');await writeFile(wav,bytes,{mode:0o600});
    text=await (options.localTranscribe??localTranscribe)(modelPath,wav,settings.language,combined);
   }
   combined.throwIfAborted();return text.trim();
  }finally{active=undefined;if(temporary)await rm(temporary,{recursive:true,force:true});}
 }
 return {status,configure,download,remove,transcribe,close(){active?.abort();for(const state of downloads.values())state.controller.abort();}};
}
