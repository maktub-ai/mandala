import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {desktopCliEnvironment} from './cli-launch';
const argv=process.argv.slice(3),home=process.argv[2];
try{
 if(!home)throw Error('Desktop command home is unavailable.');
 const env=await desktopCliEnvironment(home,argv);
 const cli=await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),'..','cli','mandala.mjs')).href);
 process.exitCode=await cli.main(argv,env);
}catch(error){process.stderr.write(JSON.stringify({ok:false,error:{code:'desktop_runtime_unavailable',message:(error as Error).message}})+'\n');process.exitCode=1;}
