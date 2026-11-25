import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../shared/types';
import { pluginRepository, retiredBlueprintPlugin } from '../shared/data-plugins';
import { createUiExtensions } from './market-ui-extensions';
import { marketFetch } from './market-transport';
import { previewProjectPlanBindings } from './library-files';

export async function previewBlueprintMigration(home: string) {
  const snapshot = await createUiExtensions(home, marketFetch).read();
  const installed = snapshot.plugins?.some(plugin =>
    plugin.catalogId === retiredBlueprintPlugin && plugin.package.repository === pluginRepository) ?? false;
  if (!installed) return { installed, projects: [] };
  // readConfig can initialize a profile or recover its skill catalog. Preflight only reads.
  let raw: string;
  try { raw = await readFile(join(home, 'config.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed, projects: [] };
    throw error;
  }
  const config = JSON.parse(raw);
  if (!Array.isArray(config?.projects)) throw Error('Invalid project configuration');
  return { installed, projects: await previewProjectPlanBindings(config.projects as Project[]) };
}


// Only the local profile and extension registry change. Format validation is read-only.
export async function migrateLegacyBlueprint(home:string) {
  const extensions=createUiExtensions(home,marketFetch);
  const installed=await extensions.read();
  if(!installed.plugins?.some(p=>p.catalogId===retiredBlueprintPlugin&&p.package.repository===pluginRepository))return;
  const {readConfig,writeBlueprintConfig}=await import('./config');
  const {loadPlan,planDirectory}=await import('./blueprint-format');
  const {blueprintBindingMatchesRepositories}=await import('./blueprint');
  const {config,revision}=await readConfig(home);
  const projects=await previewProjectPlanBindings(config.projects);
  let pending=false,changed=false;
  for(const binding of projects){
    const project=config.projects.find(p=>p.id===binding.projectId)!;
    if(!project.planId&&binding.status==='unbound')continue;
    let id=project.planId??binding.planId;
    if(id&&!project.planId&&!await blueprintBindingMatchesRepositories(project,id,binding.evidence.filter(e=>e.planId===id).map(e=>e.workspaceId)))id=null;
    if(id){
      try{loadPlan(planDirectory(id));}
      catch{pending=true;continue;}
    }else pending=true;
    const alreadyBound=!!project.planId;
    if(id&&!alreadyBound){project.planId=id;changed=true;}
    if(project.blueprintEnabled===undefined){
      project.blueprintEnabled=true;changed=true;
    }
  }
  if(changed)await writeBlueprintConfig(home,config,revision);
  if(!pending)await extensions.uninstall(retiredBlueprintPlugin,installed.revision);
}
