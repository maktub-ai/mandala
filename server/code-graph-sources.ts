import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import { DomainError } from '../shared/workspace-contracts';
const exec = promisify(execFile);
export const inside = (root:string,path:string) => { const rel=relative(root,path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep); };
export const digest = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
export const codeFile = (path:string) => /\.(?:[cm]?[jt]sx?)$/i.test(path);
const inputFile = (path:string) => codeFile(path)||/(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|pnpm-workspace\.yaml)$/.test(path);
const excluded = new Set(['.git','.codegraph','node_modules','dist','build','coverage','.next','.nuxt','.cache','.turbo','vendor','.runtime','.ssh','.aws','.gnupg','.codex','.agents']);
export async function canonical(path:string) { try { const root=await realpath(path);return (await lstat(root)).isDirectory()?root:null; } catch { return null; } }
export async function repositoryRoot(root:string) { try { const {stdout}=await exec('git',['-C',root,'rev-parse','--show-toplevel'],{maxBuffer:1024*1024,windowsHide:true});return await canonical(stdout.trim()); } catch { return null; } }
export type SourceFile = { hash:string; bytes:Buffer };
export type SourceSnapshot = Map<string,SourceFile>;
// Every component is checked; O_NOFOLLOW also closes the final-file symlink race.
export async function sourceBytes(root:string,path:string) {
 const full=resolve(root,path);if(!inside(root,full)||full===root)throw new DomainError('code_graph_stale',409,'Source path changed');
 let cursor=root;for(const part of relative(root,full).split(sep)){cursor=join(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw new DomainError('code_graph_stale',409,'Source symlink excluded');}
 if(await realpath(full)!==full)throw new DomainError('code_graph_stale',409,'Source path changed');
 const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
 try { const before=await handle.stat();if(!before.isFile()||before.size>2*1024*1024)throw new DomainError('code_graph_unsupported',422,'Source file exceeds 2 MiB limit');const bytes=await handle.readFile();const after=await handle.stat(),entry=await lstat(full);if(entry.isSymbolicLink()||entry.ino!==after.ino||entry.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||await realpath(full)!==full)throw new DomainError('code_graph_stale',409,'Source changed while reading');return bytes; }finally{await handle.close();}
}
export async function scanSources(root:string,home:string):Promise<SourceSnapshot> {
 home=await canonical(home)??resolve(home);
 const managedRoots=await Promise.all(['code-graph','runtime','outputs'].map(async name=>await canonical(join(home,name))??join(home,name)));
 const result:SourceSnapshot=new Map();let gitFiles:Set<string>|undefined;const gitDirectories=new Set<string>();let totalBytes=0;
 if(await repositoryRoot(root)){const {stdout}=await exec('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z','--','.'],{maxBuffer:16*1024*1024,windowsHide:true});gitFiles=new Set(stdout.split('\0').filter(Boolean));for(const path of gitFiles){const parts=path.split('/');parts.pop();while(parts.length){gitDirectories.add(parts.join('/'));parts.pop();}}}
 const walk=async(dir:string,rules:{base:string;matcher:ReturnType<typeof ignore>}[])=>{
  if(await realpath(dir)!==dir||(await lstat(dir)).isSymbolicLink())throw new DomainError('code_graph_stale',409,'Source directory changed');
  const ignorePath=join(dir,'.gitignore');const ignoreStat=await lstat(ignorePath).catch(()=>null);
  if(!gitFiles&&ignoreStat?.isFile()&&!ignoreStat.isSymbolicLink())rules=[...rules,{base:dir,matcher:ignore().add(await readFile(ignorePath,'utf8'))}];
  for(const entry of await readdir(dir,{withFileTypes:true})){
   const full=join(dir,entry.name),rel=relative(root,full).split(sep).join('/');
   if(entry.isSymbolicLink()||managedRoots.some(managed=>inside(managed,full))||excluded.has(entry.name))continue;
   if(!gitFiles&&rules.some(rule=>rule.matcher.ignores(relative(rule.base,full).split(sep).join('/')+(entry.isDirectory()?'/':''))))continue;
   if(entry.isDirectory()){if(!gitFiles||gitDirectories.has(rel))await walk(full,rules);}
   else if(entry.isFile()&&inputFile(rel)&&(!gitFiles||gitFiles.has(rel))){const bytes=await sourceBytes(root,rel);totalBytes+=bytes.length;if(totalBytes>128*1024*1024)throw new DomainError('code_graph_unsupported',422,'Source exceeds 128 MiB snapshot limit');result.set(rel,{bytes,hash:digest(bytes)});if(result.size>20000)throw new DomainError('code_graph_unsupported',422,'Source exceeds 20,000 input files');}
  }
 };
 if(managedRoots.some(managed=>inside(managed,root)))throw new DomainError('code_graph_unsupported',422,'Managed application directories cannot be indexed');
 await walk(root,[]);return result;
}
export const manifest = (snapshot:SourceSnapshot) => Object.fromEntries([...snapshot].map(([path,file])=>[path,file.hash]).sort(([a],[b])=>a.localeCompare(b)));
