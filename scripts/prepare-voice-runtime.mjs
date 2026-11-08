import {readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

/** Ship only this machine's prebuild, with relocatable macOS library references. */
export async function prepareVoiceRuntime(runtime){
 const dist=join(runtime,'node_modules/@kutalia/whisper-node-addon/dist');
 const target=`${process.platform==='darwin'?'mac':process.platform}-${process.arch}`;
 const directory=join(dist,target),files=await readdir(directory);
 for(const entry of await readdir(dist))if(entry!=='js'&&entry!==target)await rm(join(dist,entry),{recursive:true,force:true});
 if(process.platform!=='darwin')return;
 for(const name of files.filter(file=>file.endsWith('.node')||file.endsWith('.dylib'))){
  const path=join(directory,name),libraries=execFileSync('otool',['-L',path],{encoding:'utf8'});
  const args=[];
  if(name.endsWith('.dylib'))args.push('-id','@loader_path/'+name);
  for(const match of libraries.matchAll(/\s(@rpath\/([^\s]+))\s/g))if(files.includes(match[2]))args.push('-change',match[1],'@loader_path/'+match[2]);
  if(args.length)execFileSync('install_name_tool',[...args,path]);
  execFileSync('codesign',['--force','--sign','-',path],{stdio:'pipe'});
 }
}
