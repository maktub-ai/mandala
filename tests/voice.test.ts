import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVoiceService,downloadVoiceModel,validateVoiceWav} from '../server/voice';
import {encodeVoiceWav,appendVoiceText} from '../shared/voice';

const homes:string[]=[];
async function home(){const path=await mkdtemp(join(tmpdir(),'mandala-voice-'));homes.push(path);return path;}
afterEach(async()=>{await Promise.all(homes.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const wav=()=>Buffer.from(encodeVoiceWav(new Float32Array(16000).fill(.1)));
it('starts disabled, keeps credentials private across saves and can remove them',async()=>{
 const root=await home(),service=createVoiceService(root);
 expect((await service.status()).settings).toMatchObject({enabled:false,provider:'local',hasApiKey:false});
 await service.configure({enabled:true,provider:'openai',apiKey:'test-secret'});
 expect(JSON.stringify(await service.status())).not.toContain('test-secret');
 await service.configure({language:'zh'});
 expect((await createVoiceService(root).status()).settings).toMatchObject({hasApiKey:true,language:'zh'});
 expect((await stat(join(root,'voice.json'))).mode&0o777).toBe(0o600);
 await service.configure({apiKey:''});
 expect((await service.status()).settings.hasApiKey).toBe(false);
 await expect(service.configure({localModel:'../../bad'})).rejects.toThrow();
 await expect(service.configure({apiKey:'bad\nheader'})).rejects.toThrow();
});
it('never sends disabled or local-mode audio to a cloud provider',async()=>{
 const fetcher=vi.fn(),service=createVoiceService(await home(),{fetcher});
 await expect(service.transcribe(wav(),new AbortController().signal)).rejects.toThrow('disabled');
 await service.configure({enabled:true});
 await expect(service.transcribe(wav(),new AbortController().signal)).rejects.toThrow('Download');
 expect(fetcher).not.toHaveBeenCalled();
});
it('sends WAV and key only to the fixed OpenAI endpoint and hides provider error bodies',async()=>{
 const fetcher=vi.fn(async()=>Response.json({text:' 中文 API '})),service=createVoiceService(await home(),{fetcher});
 await service.configure({enabled:true,provider:'openai',apiKey:'test-key',language:'zh'});
 expect(await service.transcribe(wav(),new AbortController().signal)).toBe('中文 API');
 const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
 expect(options.redirect).toBe('error');
 expect(options.headers).toEqual({Authorization:'Bearer test-key'});
 const form=options.body as FormData;
 expect(form.get('model')).toBe('gpt-transcribe');
 expect(form.get('languages[]')).toBe('zh');
 expect((form.get('file') as File).type).toBe('audio/wav');
 fetcher.mockImplementation(async()=>new Response('test-key provider detail',{status:401}));
 await expect(service.transcribe(wav(),new AbortController().signal)).rejects.toThrow('401');
 await expect(service.transcribe(wav(),new AbortController().signal)).rejects.not.toThrow('test-key');
});
it('rejects corrupt audio and bounds the recording without clearing existing text',()=>{
 expect(validateVoiceWav(wav())).toBe(1);
 const bad=wav();bad.writeUInt32LE(48000,24);expect(()=>validateVoiceWav(bad)).toThrow();
 expect(()=>validateVoiceWav(Buffer.from('not audio'))).toThrow();
 expect(()=>encodeVoiceWav(new Float32Array(16000*121))).toThrow();
 expect(appendVoiceText('原有要求','新增说明')).toBe('原有要求\n新增说明');
 expect(appendVoiceText('原有要求','  ')).toBe('原有要求');
});
it('rejects a stale local recording after settings switch to cloud, and cancels in-flight requests',async()=>{
 let started!:()=>void;const pending=new Promise<void>(resolve=>{started=resolve;});
 const fetcher=vi.fn(async(_url:any,init?:RequestInit)=>{started();await new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return Response.json({text:'late'});});
 const service=createVoiceService(await home(),{fetcher});await service.configure({enabled:true,provider:'openai',apiKey:'key'});
 await expect(service.transcribe(wav(),new AbortController().signal,'local')).rejects.toThrow('changed');expect(fetcher).not.toHaveBeenCalled();
 const result=service.transcribe(wav(),new AbortController().signal,'openai');const rejected=expect(result).rejects.toThrow();await pending;
 await expect(service.transcribe(wav(),new AbortController().signal,'openai')).rejects.toThrow('running');
 await service.configure({enabled:false});await rejected;
});
it('publishes only complete checksum-verified downloads; cancelled downloads leave no model',async()=>{
 const root=await home(),bytes=Buffer.from('model'),model={id:'test',file:'test.bin',url:'https://example.com/model',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 await downloadVoiceModel(root,model,new AbortController().signal,()=>{},async()=>new Response(bytes));
 expect(await readFile(join(root,'test.bin'))).toEqual(bytes);
 await expect(downloadVoiceModel(root,{...model,file:'bad.bin',sha256:'0'.repeat(64)},new AbortController().signal,()=>{},async()=>new Response(bytes))).rejects.toThrow('checksum');
 await expect(stat(join(root,'bad.bin'))).rejects.toThrow();
 const controller=new AbortController();controller.abort();
 await expect(downloadVoiceModel(root,{...model,file:'cancel.bin'},controller.signal,()=>{},async()=>new Response(bytes))).rejects.toThrow();
 await expect(stat(join(root,'cancel.bin'))).rejects.toThrow();
});
