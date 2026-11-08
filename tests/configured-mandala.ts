import {ensureMandalaConfig,readConfig,writeConfig} from '../server/config';
import {enabledRuntimes} from '../shared/runtimes';
// Execution fixtures explicitly register their fake runtimes; a new product home stays unselected.
export async function ensureConfiguredMandala(home:string){
 const current=await readConfig(home);
 if(!current.config.runtimes){
  const saved=enabledRuntimes(current.config);
  await writeConfig(home,{...current.config,runtimes:[...new Set([...saved,'codex','omp'] as const)]},current.revision);
 }
 return ensureMandalaConfig(home);
}
