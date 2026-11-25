import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

// Git's partial commit locks its index and preserves staged entries outside the named paths.
export function planHistory(root:string,paths:string[],initialize=false) {
 if(process.env.OMINO_NO_HISTORY)return null;
 const dir=join(root,'.git');
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 const run=(args:string[])=>execFileSync('git',['--git-dir='+dir,'--work-tree='+root,'--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','user.name=Project notes','-c','user.email=notes@localhost','-c','commit.gpgsign=false',...args],{cwd:root,env:{...env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','ignore'],encoding:'utf8',timeout:3000});
 try{
  if(!existsSync(dir)){if(!initialize)return null;run(['init','--quiet','--template=']);}
  if(!lstatSync(dir).isDirectory())return null;
  // Leave any pre-existing changes to the shared log or note files for their author to record.
  if(!initialize&&run(['status','--porcelain=v1','--',...paths]).trim())return null;
  return (message:string)=>{
   try{run(['add','--intent-to-add','--',...paths]);run(['commit','--quiet','--only','--no-verify','-m',message,'--',...paths]);}
   catch{/* The Markdown notes and their durable format history remain available. */}
  };
 }catch{return null;}
}
