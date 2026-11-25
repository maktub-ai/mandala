import {lstat, readdir, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type {UploadSource} from '../shared/assets';
import {DomainError} from '../shared/workspace-contracts';

// Market packages contain up to 200 files plus the repository license.
export const SKILL_PACKAGE_FILE_LIMIT = 201;

export async function skillPackageSources(directory:string):Promise<UploadSource[]> {
 const invalid=(message:string)=>new DomainError('invalid_skill_package',422,message);
 const info=await lstat(directory);
 if(info.isSymbolicLink())throw invalid('Skill package symlinks are forbidden');
 if(!info.isDirectory())throw invalid('Expected a Skill package directory');
 const root=await realpath(directory),files:UploadSource[]=[];
 let directories=0;
 const walk=async(path:string,depth:number)=>{
  if(depth>32||++directories>1000)throw invalid('Skill package directory limit exceeded');
  for(const entry of (await readdir(join(root,path))).sort()){
   const relative=path?path+'/'+entry:entry,stat=await lstat(join(root,relative));
   if(stat.isSymbolicLink())throw invalid('Skill package symlinks are forbidden');
   if(stat.isDirectory())await walk(relative,depth+1);
   else {
    if(!stat.isFile())throw invalid('Skill packages require regular files');
    files.push({allowedRoot:root,relativePath:relative,manifestPath:relative});
    if(files.length>SKILL_PACKAGE_FILE_LIMIT)throw invalid('Skill package file limit exceeded');
   }
  }
 };
 await walk('',0);
 if(!files.some(file=>file.manifestPath==='SKILL.md'))throw invalid('Missing SKILL.md');
 return files;
}
