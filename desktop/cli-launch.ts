import {productEnv,productHome} from '../cli/product-env.mjs';
import {controlService,readServiceRecord,serviceAlive} from './service-discovery';
// Destination discovery is local to the command process; credentials never enter the launcher or renderer.
export async function desktopCliEnvironment(defaultHome:string,argv:string[],env:NodeJS.ProcessEnv=process.env):Promise<NodeJS.ProcessEnv>{
 const selected={...env,...(productEnv('HOME',env)===undefined?{MANDALA_HOME:defaultHome}:{})};
 if(!argv.length||argv.includes('--help')||argv.includes('-h')||argv[0]==='help'||productEnv('CONTEXT',env)||productEnv('BASE_URL',env)!==undefined||argv.some(value=>value==='--base-url'||value.startsWith('--base-url=')))return selected;
 const record=readServiceRecord(productHome('workspace',selected));
 if(!record||!serviceAlive(record))throw Error('The Mandala desktop runtime is not running. Open Mandala before using this command.');
 await controlService(record,'probe');
 return{...selected,MANDALA_BASE_URL:record.origin};
}
