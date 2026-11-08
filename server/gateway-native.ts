import type {CodexOptions} from './codex';
import type {ModelChoice} from '../shared/types';
import {spawn} from './native-spawn';

// Read public metadata through the native CLI so profiles, JSON5 includes and
// environment references keep their native semantics. Never query auth fields.
async function query(options:Pick<CodexOptions,'cwd'|'env'|'signal'>,args:string[],optional=false):Promise<any>{
 return new Promise((resolve,reject)=>{
  const child=spawn('openclaw',args,{cwd:options.cwd,env:{...process.env,...options.env,OPENCLAW_HIDE_BANNER:'1',OPENCLAW_SUPPRESS_NOTES:'1'},signal:options.signal,stdio:'pipe',shell:false});
  let output='',settled=false;
  const fail=()=>{if(!settled){settled=true;reject(new Error('Cannot read OpenClaw native configuration; check installation, Node version and native profile.'));}};
  const timer=setTimeout(()=>{fail();child.kill();},20000);
  child.stdin.end();child.stderr.resume();
  child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1024*1024){fail();child.kill();}});
  child.on('error',()=>{clearTimeout(timer);fail();});
  child.on('close',code=>{clearTimeout(timer);if(settled)return;
   try{const value=JSON.parse(output);
    if(code===0){settled=true;resolve(value);return;}
    if(optional&&value?.ok===false&&/^Config path (?:is valid but unset:|not found:)/.test(value.error?.message??'')){settled=true;resolve(undefined);return;}
   }catch{}
   fail();
  });
 });
}
export async function openClawNativeSettings(options:Pick<CodexOptions,'cwd'|'env'|'signal'>):Promise<{model?:ModelChoice}>{
 const env={...process.env,...options.env};
 // A loopback override may be an SSH tunnel to a different filesystem. Require
 // the native local target; remote execution belongs to the existing SSH host.
 const remoteError=()=>new Error('OpenClaw Gateway must run on the selected execution machine. Select its host using Mandala SSH execution and use a native local Gateway profile there; remote Gateway URL overrides cannot reach this machine’s paths or business CLI.');
 if(env.OPENCLAW_GATEWAY_URL?.trim())throw remoteError();
 const remote=await query(options,['config','get','gateway.remote.url','--json'],true);
 if(remote!==undefined&&remote!==null&&remote!=='')throw remoteError();
 const catalog=await query(options,['models','list','--json']);
 if(!Array.isArray(catalog?.models))throw new Error('Invalid OpenClaw native model catalog');
 const model=catalog.models.find((item:any)=>typeof item.key==='string'&&Array.isArray(item.tags)&&item.tags.includes('default'));
 return model?{model:{id:model.key,label:typeof model.name==='string'?model.name:model.key,isDefault:true}}:{};
}
