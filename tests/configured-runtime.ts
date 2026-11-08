import {readConfig,writeConfig} from '../server/config';
import {enabledRuntimes} from '../shared/runtimes';
// These execution tests use synthetic Codex/OMP clients, not first-use defaults.
export async function readConfiguredRuntime(home:string){
 const current=await readConfig(home);
 if(current.config.runtimes!==undefined)return current;
 await writeConfig(home,{...current.config,runtimes:[...new Set([...enabledRuntimes(current.config),'codex','omp'] as const)],system:current.config.system??{cli:'codex'}},current.revision);
 return readConfig(home);
}
