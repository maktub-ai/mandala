import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// ACP's structured kind and locations must agree with the actual path argument.
// Unknown tool shapes and paths that cannot be resolved keep their native prompt.
export function canApproveAcpLocally(tool: {kind?:string|null;rawInput?:unknown;locations?:{path:string}[]|null},cwd:string):boolean {
 if(!['read','edit'].includes(tool.kind??''))return false;
 const input=tool.rawInput as Record<string,unknown>|undefined;
 if(!input||typeof input!=='object'||Array.isArray(input))return false;
 const paths=['path','file_path','filePath'].filter(key=>Object.hasOwn(input,key)).map(key=>input[key]);
 if(!paths.length||!tool.locations?.length||paths.some(path=>typeof path!=='string'||!isAbsolute(path)))return false;
 const locations=tool.locations.map(location=>location.path);
 if(paths.some(path=>!locations.includes(path as string))||locations.some(path=>!paths.includes(path)))return false;
 try {
  const root=realpathSync(cwd);
  return locations.every(path=>{
   if(!isAbsolute(path)||path.split(/[\\/]/).includes('..'))return false;
   let existing=resolve(path),tail:string[]=[];
   for(;;){try{existing=realpathSync(existing);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||dirname(existing)===existing)return false;tail.unshift(existing.slice(dirname(existing).length+1));existing=dirname(existing);}}
   const distance=relative(root,resolve(existing,...tail));
   return distance!==''&&distance!=='..'&&!distance.startsWith('..'+sep)&&!isAbsolute(distance);
  });
 }catch{return false;}
}
