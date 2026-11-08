import {constants,accessSync,closeSync,fstatSync,fchmodSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,statSync,writeFileSync,linkSync,unlinkSync,renameSync,readlinkSync,symlinkSync,type Stats} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import type {DesktopCliStatus} from '../shared/desktop-cli';
type Options={runtime:string;home:string;userHome?:string;platform?:NodeJS.Platform;path?:string};
const marker='# Mandala desktop command v1 ';
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
function launcher(runtime:string,home:string){return '#!/bin/sh\n'+marker+JSON.stringify({runtime,home})+'\nunset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE\nexec '+quote(join(runtime,'bin','node'))+' '+quote(join(runtime,'scripts','desktop-cli.mjs'))+' '+quote(home)+' "$@"\n';}
function managed(raw:string){try{const line=raw.split('\n')[1];if(!line?.startsWith(marker))return false;const value=JSON.parse(line.slice(marker.length));return typeof value.runtime==='string'&&typeof value.home==='string'&&raw===launcher(value.runtime,value.home);}catch{return false;}}
function legacy(raw:string,runtime:string){return !/["`$\\\n\r]/.test(runtime)&&raw==='#!/bin/sh\nexec "'+join(runtime,'bin','node')+'" "'+join(runtime,'cli','mandala.mjs')+'" "$@"\n';}
function owned(stat:Stats){return typeof process.getuid!=='function'||stat.uid===process.getuid();}
function directory(userHome:string,create=false){for(const path of [userHome,join(userHome,'.local'),join(userHome,'.local','bin')]){let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(!create)continue;mkdirSync(path,{mode:0o755});stat=lstatSync(path);}if(!stat.isDirectory()||!owned(stat)||stat.mode&0o022)throw Error('Command directory must be an owned directory without group or public write access.');}}
function readLauncher(path:string){let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||!owned(stat)||stat.nlink!==1||!!(stat.mode&0o022)||stat.size>65536)return {raw:'',managed:false,executable:false,stat};const raw=readFileSync(fd,'utf8');return{raw,managed:managed(raw),executable:!!(stat.mode&0o111),stat};}finally{if(fd!==undefined)closeSync(fd);}}
function ready(runtime:string){try{for(const path of [join(runtime,'bin','node'),join(runtime,'scripts','desktop-cli.mjs'),join(runtime,'cli','mandala.mjs')])if(!lstatSync(path).isFile())return false;accessSync(join(runtime,'bin','node'),constants.X_OK);return true;}catch{return false;}}
export function desktopCliStatus({runtime,home,userHome=homedir(),platform=process.platform,path=process.env.PATH??''}:Options):DesktopCliStatus{
 const launcherPath=join(userHome,'.local','bin','mandala'),supported=platform!=='win32',runtimeReady=supported&&ready(runtime),paths=path.split(':').filter(Boolean).slice(0,512),inPath=paths.some(value=>resolve(value)===resolve(userHome,'.local','bin'));
 let existingCommand:string|null=null;for(const value of paths){const candidate=join(value,'mandala');try{if(statSync(candidate).isFile()){accessSync(candidate,constants.X_OK);existingCommand=candidate;break;}}catch{}}
 let installed=false,conflict=false,updateAvailable=false;
 if(supported)try{directory(userHome);const current=readLauncher(launcherPath),recognized=current.managed||legacy(current.raw,runtime);conflict=!recognized;installed=current.managed&&current.executable&&current.raw===launcher(runtime,home);updateAvailable=recognized&&!installed;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')conflict=true;}
 return{supported,installed,runtimeReady,launcherPath,command:quote(launcherPath),inPath:supported&&inPath,shadowed:!!existingCommand&&resolve(existingCommand)!==resolve(launcherPath),existingCommand,conflict,updateAvailable};
}
export function installDesktopCli(options:Options):DesktopCliStatus{
 const userHome=options.userHome??homedir(),status=desktopCliStatus(options);
 if(!status.supported)throw Error('Command registration is not supported on this platform.');
 if(!status.runtimeReady)throw Error('Bundled command runtime is unavailable.');
 directory(userHome,true);
 if(status.installed)return status;
 if(status.conflict)throw Error('An existing command was preserved. Choose a different command manually.');
 const temporary=join(userHome,'.local','bin','.mandala-'+randomUUID()+'.tmp');
 let fd:number|undefined,identity:Stats|undefined,backupPath:string|undefined;
 try{
  fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o755);
  identity=fstatSync(fd);
  writeFileSync(fd,launcher(options.runtime,options.home));
  fchmodSync(fd,0o755);fsyncSync(fd);
  try{
   if(status.updateAvailable){
    const current=readLauncher(status.launcherPath);
    if(!current.managed&&!legacy(current.raw,options.runtime))throw Error('The existing command changed. Check registration again.');
    const backup=status.launcherPath+'.backup-'+randomUUID();
    renameSync(status.launcherPath,backup);backupPath=backup;
    const moved=readLauncher(backup);
    if(moved.stat.dev!==current.stat.dev||moved.stat.ino!==current.stat.ino||moved.raw!==current.raw)throw Error('The existing command changed. Check registration again.');
   }
   // Exclusive publication also protects recovery from overwriting a concurrent command.
   linkSync(temporary,status.launcherPath);
  }catch(error){
   if(backupPath){try{if(lstatSync(backupPath).isSymbolicLink())symlinkSync(readlinkSync(backupPath),status.launcherPath);else linkSync(backupPath,status.launcherPath);unlinkSync(backupPath);}catch{throw Error('Command registration failed. The previous entry is preserved at '+backupPath);}}
   throw error;
  }
 }finally{
  if(fd!==undefined)closeSync(fd);
  if(identity){let current;try{current=lstatSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(current?.dev===identity.dev&&current?.ino===identity.ino)unlinkSync(temporary);}
 }
 const result=desktopCliStatus(options);
 if(!result.installed)throw Error('Command registration could not be verified.');
 return {...result,...(backupPath?{backupPath}:{})};
}
