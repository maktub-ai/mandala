import {createRequire} from 'node:module';
import {join} from 'node:path';
import {promisify} from 'node:util';
// One recording per process: exiting releases all model memory and native state.
try {
 const [model,wav,language,native]=process.argv.slice(2);
 const {whisper}=createRequire(import.meta.url)(join(native,'whisper.node'));
 const result=await promisify(whisper)({model,fname_inp:wav,language,use_gpu:true,flash_attn:false,no_prints:true,translate:false,no_timestamps:true,n_threads:4});
 const text=result.transcription.map(segment=>Array.isArray(segment)?segment[segment.length-1]:segment).join('').trim();
 process.send({text},()=>process.exit(0));
}catch{process.send?.({error:true},()=>process.exit(1));}
