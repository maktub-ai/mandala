import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {defaultMemoryRetrievalSettings,type MemoryRetrievalSettings} from '../shared/memory-retrieval';
import {DomainError} from '../shared/workspace-contracts';
import type {MemoryVectorOptions} from './memory-vectors';
type Saved=Omit<MemoryRetrievalSettings,'hasApiKey'>&{apiKey:string};
const invalid=()=>new DomainError('memory_retrieval_config',422,'Choose a provider, a valid HTTP(S) base URL and an embedding model.');
function validate(value:Partial<Saved>){
 if(value.enabled!==undefined&&typeof value.enabled!=='boolean'||value.provider!==undefined&&!['ollama','openai'].includes(value.provider))throw invalid();
 for(const key of ['baseUrl','model','apiKey'] as const)if(value[key]!==undefined&&(typeof value[key]!=='string'||value[key]!.length>(key==='model'?256:2048)||/[\x00-\x1f\x7f]/.test(value[key]!)))throw invalid();
 if(value.apiKey&&/[^\x21-\x7e]/.test(value.apiKey))throw invalid();
 if(value.baseUrl){let url:URL;try{url=new URL(value.baseUrl);}catch{throw invalid();}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw invalid();}
 if(value.enabled&&(!value.baseUrl?.trim()||!value.model?.trim()))throw invalid();
}
export function createMemoryRetrieval(home:string){
 const path=join(home,'memory-retrieval.json');
 let cache:Promise<Saved>|undefined,writing:Promise<unknown>=Promise.resolve(),controller=new AbortController();
 function read(){return cache??=(async()=>{try{const value=JSON.parse(await readFile(path,'utf8')) as Saved;validate(value);return value;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){const {hasApiKey,...settings}=defaultMemoryRetrievalSettings;return {...settings,apiKey:''};}throw new DomainError('memory_retrieval_config',500,'Could not read memory retrieval settings');}})();}
 const status=async():Promise<MemoryRetrievalSettings>=>{const {apiKey,...settings}=await read();return {...settings,hasApiKey:!!apiKey};};
 function configure(input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['enabled','provider','baseUrl','model','apiKey'].includes(key)))return Promise.reject(invalid());
  const patch={...input} as Partial<Saved>;
  // Validate partial fields first; enabling may use previously saved connection settings.
  try{validate({...patch,enabled:false});if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw invalid();}catch(error){return Promise.reject(error);}
  if(patch.baseUrl!==undefined)patch.baseUrl=patch.baseUrl.trim().replace(/\/+$/,'');
  if(patch.model!==undefined)patch.model=patch.model.trim();
  const operation=writing.then(async()=>{
   const previous=await read(),settings={...previous,...patch};
   if((previous.baseUrl!==settings.baseUrl||previous.provider!==settings.provider)&&patch.apiKey===undefined)settings.apiKey='';
   validate(settings);const temporary=path+'.'+randomUUID()+'.tmp';await mkdir(home,{recursive:true,mode:0o700});
   try{await writeFile(temporary,JSON.stringify(settings)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
   controller.abort();controller=new AbortController();cache=Promise.resolve(settings);return status();
  });writing=operation.catch(()=>{});return operation;
 }
 async function provider():Promise<MemoryVectorOptions|undefined>{
  const lifetime=controller.signal,settings=await read();lifetime.throwIfAborted();if(!settings.enabled)return;
  const identity=createHash('sha256').update(JSON.stringify([settings.provider,settings.baseUrl,settings.model,settings.apiKey])).digest('hex');
  const request=async(path:string,body:unknown,signal?:AbortSignal)=>{
   const combined=AbortSignal.any([lifetime,...signal?[signal]:[],AbortSignal.timeout(15000)]);combined.throwIfAborted();
   const response=await fetch(settings.baseUrl+path,{method:body?'POST':'GET',headers:{...body?{'Content-Type':'application/json'}:{},...settings.apiKey?{Authorization:'Bearer '+settings.apiKey}:{}},...body?{body:JSON.stringify(body)}:{},signal:combined,redirect:'error'});
   if(!response.ok){await response.body?.cancel();throw new Error('embedding_provider_unavailable');}
   const value=await response.json();combined.throwIfAborted();return value;
  };
  return {model:identity,signal:lifetime,
   resolveModel:settings.provider==='ollama'?async signal=>{
    const result=await request('/api/tags',undefined,signal),name=settings.model.includes(':')?settings.model:settings.model+':latest';
    const entry=result?.models?.find((item:{name?:string})=>item.name===settings.model||item.name===name);
    if(typeof entry?.digest!=='string'||!entry.digest)throw new Error('embedding_model_unavailable');return identity+'@'+entry.digest;
   }:undefined,
   embed:async(texts,signal)=>{
    const result=await request(settings.provider==='ollama'?'/api/embed':'/embeddings',{model:settings.model,input:texts,...settings.provider==='ollama'?{truncate:false}:{encoding_format:'float'}},signal);
    let values:unknown;
    if(settings.provider==='ollama')values=result?.embeddings;
    else {const data=result?.data;if(!Array.isArray(data)||data.length!==texts.length)throw new Error('invalid_embeddings');const ordered=[...data].sort((a,b)=>a.index-b.index);if(ordered.some((item,index)=>item.index!==index))throw new Error('invalid_embeddings');values=ordered.map(item=>item.embedding);}
    if(!Array.isArray(values)||values.length!==texts.length||values.some(value=>!Array.isArray(value)||!value.length||value.length>65536||!value.every(Number.isFinite)))throw new Error('invalid_embeddings');
    return values as number[][];
   },
  };
 }
 return {status,configure,provider,close(){controller.abort();}};
}
