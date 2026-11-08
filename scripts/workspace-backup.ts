import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {backupWorkspace,restoreWorkspace} from '../server/workspace-backup';
try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{home:{type:'string'},output:{type:'string'},input:{type:'string'},help:{type:'boolean'}}});
 if(values.help){
  console.log('backup --home <stopped MANDALA_HOME> --output <new snapshot directory>\nrestore --input <snapshot directory> --home <new MANDALA_HOME>\nIncludes platform state/configuration and managed files. Excludes native CLI authentication/history, external repositories, runtime grants and pending uploads. Restore never overwrites an existing directory.');
 }else{
  const mode=positionals[0];
  if(positionals.length!==1||!values.home||(mode==='backup'?(!values.output||values.input):(mode!=='restore'||!values.input||values.output)))throw new Error('Use --help for backup/restore arguments.');
  if(mode==='backup')await backupWorkspace(values.home,values.output!);else await restoreWorkspace(values.input!,values.home);
  console.log(`${mode==='backup'?'Backup created':'Workspace restored'}: ${resolve(mode==='backup'?values.output!:values.home)}`);
 }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
