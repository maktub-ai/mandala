import { parseArgs } from 'node:util';
import { migrateHome } from '../server/home-migration';
try{
 const {values}=parseArgs({options:{from:{type:'string'},to:{type:'string'},backup:{type:'string'},'nested-home':{type:'string',multiple:true},help:{type:'boolean'}}});
 if(values.help)console.log('migrate-home --from <stopped .open-mana home> --to <sibling .mandala home> --backup <new directory on the same filesystem> [--nested-home <relative profile path>]\nSupports workspace, -account-service and -releases homes. Explicit nested profiles also have owned paths updated; archived snapshots remain intact. Retains the complete original under backup/home and creates a legacy directory alias. Stop all services first.');
 else{
  if(!values.from||!values.to||!values.backup)throw new Error('Use --help for the explicit offline migration arguments.');
  console.log(JSON.stringify(await migrateHome(values.from,values.to,values.backup,values['nested-home'])));
 }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
