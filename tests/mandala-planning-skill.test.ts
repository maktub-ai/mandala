import {ensureConfiguredMandala} from './configured-mandala';
import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mandalaPlanningSkill} from '../server/mandala-planning-skill';
import {readConfig} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createMandalaCoordination} from '../server/mandala-coordination';
import {mandalaDirectory} from '../server/mandala-directory';
import {createTasks} from '../server/tasks';
import {openStore} from '../server/store';
import {linkedCapabilities} from '../shared/catalog';
import {prepareCapabilityRuntime} from '../server/omp';
import type {ManagedChange} from '../shared/mandala-coordination';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

it.each([false,true])('executes the Skill cold-start recipe with complete config and resources (resume=%s)',async resume=>{
 const examples=[...mandalaPlanningSkill.content.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match=>JSON.parse(match[1].replaceAll('<selected-runtime>','codex')) as {change:ManagedChange;mode:'direct'});
 expect(examples).toHaveLength(2);
 const home=await mkdtemp(join(tmpdir(),'mandala-cold-start-')),store=openStore(home);
 cleanup.push(async()=>{store.close();await rm(home,{recursive:true,force:true});});
 const {config:initial}=await ensureConfiguredMandala(home),chat=ensureMandalaConversation(store,initial);
 expect(initial.projects).toHaveLength(0);expect(initial.agents.filter(a=>!a.systemRole)).toHaveLength(0);
 const skill=join(home,'skills','example-skill');await mkdir(join(skill,'references'),{recursive:true});
 await writeFile(join(skill,'SKILL.md'),'---\nname: example-skill\ndescription: Example workflow\n---\nRead references/check.md');
 await writeFile(join(skill,'references/check.md'),'Check the output against the input.');
 const [agent,project]=JSON.parse(JSON.stringify(examples).replaceAll('/example/skills/example-skill',skill).replaceAll('/example/work',home)) as typeof examples;
 const tasks=createTasks(store);let service=createMandalaCoordination({home,store,tasks});
 const sourceFor=(invocationId:string,text:string)=>{const event=store.appendEvent(chat.id,'user',{invocationId,text});return {agentId:chat.agentId,conversationId:chat.id,invocationId,humanEventId:event.id};};
 let source=sourceFor('confirmed','Create the Projects, introductions, icons, module Agents and Skill assignments in the draft.');
 await service.configure(source,agent.change,agent.mode,'cold-start-agent',()=>{});
 if(resume){
  // The first object was saved before interruption; a new human turn continues the same plan.
  service=createMandalaCoordination({home,store,tasks});source=sourceFor('continued','Continue the confirmed setup.');
  const directory=mandalaDirectory((await readConfig(home)).config);
  expect(directory.agents.map(a=>a.id)).toContain(agent.change.values!.id);expect(directory.projects).toHaveLength(0);
 }
 await service.configure(source,project.change,project.mode,'cold-start-project',()=>{});
 const config=(await readConfig(home)).config,directory=mandalaDirectory(config),saved=config.agents.find(a=>!a.systemRole)!;
 expect(directory.projects).toHaveLength(1);expect(directory.agents).toHaveLength(1);
 expect(directory.projects[0]).toMatchObject({icon:project.change.values!.icon,backgroundConfigured:true,agentIds:[saved.id]});
 expect(config.projects[0].background).toBe(project.change.values!.background);expect(saved.instructions).toBe(agent.change.values!.instructions);
 expect(directory.agents[0]).toMatchObject({instructionsConfigured:true,skillIds:expect.any(Array)});
 expect(directory.bindings.find(b=>b.projectId===config.projects[0].id)?.skills).toEqual([{name:'example-skill',source:'agent',status:'unverified'}]);
 const runtime=await prepareCapabilityRuntime(home,'verification',[],linkedCapabilities(config,saved).skills);
 expect(await readFile(join(runtime,'skills/example-skill/references/check.md'),'utf8')).toBe('Check the output against the input.');
 expect(config.agents.find(a=>a.systemRole)).toEqual(initial.agents.find(a=>a.systemRole));
 expect(config.mandala).toEqual(initial.mandala);
});
