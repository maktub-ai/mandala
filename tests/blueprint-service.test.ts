import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readConfig,writeConfig} from '../server/config';
import {createBlueprintService} from '../server/blueprint';
import type {Project} from '../shared/types';

let root:string,home:string,repo:string,plans:string;
const draft=vi.fn(async()=>['Rendering','Storage']);
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'blueprint-service-'));home=join(root,'profile');repo=join(root,'repo');plans=join(root,'plans');
 vi.stubEnv('OMINO_HOME',plans);await mkdir(repo);await mkdir(home);
 const {config,revision}=await readConfig(home);
 config.projects.push({id:'internal-project-111',name:'Sample project',cwd:repo,agentIds:[],mcp:[],skills:[],resources:[]});
 await writeConfig(home,config,revision);
});
afterEach(async()=>{vi.unstubAllEnvs();draft.mockClear();await rm(root,{recursive:true,force:true});});
const project='internal-project-111';
it('requires a separately confirmed observer draft, writes a compatible record once and preserves it on disable',async()=>{
 const service=createBlueprintService(home,{draft});
 expect((await service.state(project)).status).toBe('disabled');
 expect((await service.enable(project)).status).toBe('uninitialized');
 const proposal=await service.draft(project);
 await expect(readdir(join(plans,'projects'))).rejects.toThrow();
 const ready=await service.confirm(project,proposal.draftId,['Rendering','Data']);
 expect(ready.summary?.modules.map(m=>m.lane)).toEqual(['Rendering','Data']);
 const legacy=await readConfig(home);delete legacy.config.projects[0].planId;delete legacy.config.projects[0].blueprintEnabled;
 await writeConfig(home,legacy.config,legacy.revision);
 expect((await readConfig(home)).config.projects[0]).toMatchObject({planId:ready.planId,blueprintEnabled:true});
 const result={result:'Improved rendering',decisions:['Use the new format'],lanes:['Rendering','Data']};
 const records=await Promise.all([service.writeRecord(project,result,'mandala-task-internal-abc',ready.planId!),service.writeRecord(project,result,'mandala-task-internal-abc')]);
 expect(records[0]).toEqual(records[1]);
 expect((await service.queryModule(project,'Data')).records).toContainEqual(records[0]);
 await expect(service.writeRecord(project,{...result,result:'Different'},'mandala-task-internal-abc')).rejects.toThrow();
 const directory=join(plans,'projects',ready.planId!);
 const change=await readFile(join(directory,'changes.jsonl'),'utf8');
 expect(change).not.toContain('mandala-task-internal-abc');expect(change).not.toContain(project);
 expect((await service.disable(project)).status).toBe('disabled');
 await expect(service.writeRecord(project,result,'later')).rejects.toThrow();
 expect((await service.enable(project)).summary?.records).toContainEqual(records[0]);
});
it('adopts a uniquely bound external plan, reads outside records and never regenerates its notes',async()=>{
 const directory=join(plans,'projects','public-plan');await mkdir(join(directory,'work'),{recursive:true});
 await mkdir(join(directory,'stages'));await writeFile(join(directory,'stages','s1.md'),'---\nid: s1\nkind: stage\ntitle: Project work\nlevel: 1\nstatus: active\n---\n');
 await writeFile(join(repo,'.omino.json'),JSON.stringify({project:'public-plan'}));
 const intent='---\nid: project\nkind: intent\ntitle: External plan\n---\n\n## Purpose\nKeep this text.\n';
 await writeFile(join(directory,'project.md'),intent);await writeFile(join(directory,'work','existing.md'),'---\nid: existing\nkind: work\ntitle: Existing work\nstage: s1\nstatus: done\nlane: Storage\n---\n\n## Progress\nExternally recorded result.\n');
 await writeFile(join(directory,'changes.jsonl'),JSON.stringify({ts:'2025-01-01T00:00:00Z',source:'tool',summary:'Measured the earlier implementation',notes:[{id:'existing',op:'modified'}]})+'\n');
 const service=createBlueprintService(home,{draft});
 expect((await service.enable(project)).planId).toBe('public-plan');
 expect((await service.queryModule(project,'Storage')).records.map(r=>r.result)).toEqual(expect.arrayContaining(['Externally recorded result.','Measured the earlier implementation']));
 expect(await readFile(join(directory,'project.md'),'utf8')).toBe(intent);expect(draft).not.toHaveBeenCalled();
});

it('preserves unrelated edits, staged work and earlier history when writing a portable decision',async()=>{
 const git=(dir:string,...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
 git(repo,'init','--quiet');
 git(repo,'remote','add','origin','https://account:synthetic@git.example/sample/notes.git');
 const service=createBlueprintService(home,{draft});await service.enable(project);
 const d=await service.draft(project),ready=await service.confirm(project,d.draftId,d.modules);
 const directory=join(plans,'projects',ready.planId!);
 expect(JSON.parse(await readFile(join(directory,'omino.json'),'utf8')).repos).toEqual(['git.example/sample/notes']);
 expect(await readFile(join(repo,'.git','omino-project'),'utf8')).toBe(ready.planId+'\n');
 expect(await readdir(repo)).toEqual(['.git']);
 const before=JSON.parse(await readFile(join(directory,'state.json'),'utf8')).notes.project;
 const intent=(await readFile(join(directory,'project.md'),'utf8'))+'Unrecorded external edit.\n';
 await writeFile(join(directory,'project.md'),intent);await writeFile(join(directory,'draft.txt'),'external');git(directory,'add','draft.txt');
 const input={result:'## Outcome\nRendered a frame.',decisions:['Keep caches local.\n## Reason\nFor offline use.'],lanes:['Storage','Rendering']};
 const record=await service.writeRecord(project,input,'stable-private-command');
 expect(record).toMatchObject(input);
 expect(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).notes.project).toEqual(before);
 expect(await readFile(join(directory,'project.md'),'utf8')).toBe(intent);
 expect(git(directory,'diff','--cached','--name-only')).toBe('draft.txt');
 expect(git(directory,'show','--format=','--name-only','HEAD').split('\n').sort()).toEqual(['changes.jsonl','decisions/'+record.id+'-decision-1.md','state.json','work/'+record.id+'.md'].sort());
 const {notes}=JSON.parse((await readFile(join(directory,'changes.jsonl'),'utf8')).trimEnd().split('\n').at(-1)!);
 expect(notes.map((n:{id:string})=>n.id)).toEqual([record.id,record.id+'-decision-1']);
 const closed=join(directory,'omino.json');await writeFile(closed,JSON.stringify({id:ready.planId,status:'closed'}));
 expect((await service.state(project)).status).toBe('unavailable');
 await expect(service.writeRecord(project,input,'new-key')).rejects.toThrow('closed');
});

it('recovers an interrupted note and never generates or publishes a replacement binding during a conflict',async()=>{
 const service=createBlueprintService(home,{draft});await service.enable(project);
 const d=await service.draft(project),ready=await service.confirm(project,d.draftId,d.modules);
 const directory=join(plans,'projects',ready.planId!),state=await readFile(join(directory,'state.json'),'utf8'),history=await readFile(join(directory,'changes.jsonl'),'utf8');
 const input={result:'Retained output.',decisions:['Keep the archive.'],lanes:['Storage']};
 await expect(service.writeRecord(project,input,'revoked',ready.planId!,()=>{throw Error('Permission revoked');})).rejects.toThrow('Permission revoked');
 expect(await readFile(join(directory,'changes.jsonl'),'utf8')).toBe(history);
 const entry=await service.writeRecord(project,input,'interrupted');
 await writeFile(join(directory,'changes.jsonl'),history);await writeFile(join(directory,'state.json'),state);
 await rm(join(directory,'decisions',entry.id+'-decision-1.md'));
 expect((await service.writeRecord(project,input,'interrupted')).id).toBe(entry.id);
 expect((await readFile(join(directory,'changes.jsonl'),'utf8')).trimEnd().split('\n')).toHaveLength(2);
 expect(await service.writeRecord(project,input,'interrupted')).toMatchObject({id:entry.id});
 await expect(service.writeRecord(project,input,'new','other-plan')).rejects.toThrow('changed');
});
it('uses changes in the global default only for new projects and protects plan IDs from general configuration writes',async()=>{
 const {config,revision}=await readConfig(home);config.blueprintDefaultEnabled=true;
 await writeConfig(home,config,revision);const next=await readConfig(home);
 expect(next.config.projects[0].blueprintEnabled).toBe(false);
 next.config.projects.push({...next.config.projects[0],id:'future',blueprintEnabled:undefined} as Project);
 await writeConfig(home,next.config,next.revision);const current=await readConfig(home);
 expect(current.config.projects[1].blueprintEnabled).toBe(true);
 current.config.projects[0].planId='arbitrary';await expect(writeConfig(home,current.config,current.revision)).rejects.toThrow();
});

it('permits a blueprint-only setting change when an unrelated existing workspace is offline',async()=>{
 const offline=join(root,'other-volume');await mkdir(offline);
 const s=await readConfig(home);s.config.projects.push({...s.config.projects[0],id:'offline',cwd:offline,workspaces:undefined});
 await writeConfig(home,s.config,s.revision);await rm(offline,{recursive:true});
 const service=createBlueprintService(home,{draft});
 expect((await service.enable(project)).status).toBe('uninitialized');
 const current=await readConfig(home);
 await expect(writeConfig(home,current.config,current.revision)).rejects.toThrow();
});

it('requires a choice between conflicting external plans and preserves their binding files',async()=>{
 const alt=join(root,'other');await mkdir(alt);
 const s=await readConfig(home);s.config.projects[0].workspaces!.push({id:'also',name:'Other',cwd:alt,resources:[]});await writeConfig(home,s.config,s.revision);
 for(const [folder,id] of [[repo,'first'],[alt,'second']]){
  await mkdir(join(plans,'projects',id),{recursive:true});await writeFile(join(folder,'.omino.json'),JSON.stringify({project:id}));
  await writeFile(join(plans,'projects',id,'project.md'),'---\nid: project\nkind: intent\ntitle: '+id+'\n---\n');
 }
 const service=createBlueprintService(home,{draft});
 expect(await service.enable(project)).toMatchObject({status:'conflict',candidates:['first','second']});
 await expect(service.draft(project)).rejects.toThrow();await expect(service.bind(project,'other')).rejects.toThrow();
 expect((await service.bind(project,'second')).summary?.title).toBe('second');
 expect(JSON.parse(await readFile(join(repo,'.omino.json'),'utf8')).project).toBe('first');
 expect(draft).not.toHaveBeenCalled();
});

it('keeps a malformed external plan untouched and permits no records while its stage is missing',async()=>{
 const directory=join(plans,'projects','incomplete-plan');await mkdir(join(directory,'work'),{recursive:true});
 await writeFile(join(repo,'.omino.json'),'{"project":"incomplete-plan"}');
 await writeFile(join(directory,'project.md'),'---\nid: project\nkind: intent\ntitle: Incomplete plan\n---\n');
 await writeFile(join(directory,'work','example.md'),'---\nid: example\nkind: work\ntitle: Example\nstage: absent\nstatus: doing\n---\n');
 const service=createBlueprintService(home,{draft});
 expect((await service.enable(project)).status).toBe('unavailable');
 await expect(service.writeRecord(project,{result:'Done',decisions:[],lanes:[]},'key')).rejects.toThrow();
 expect(await readdir(directory)).toEqual(['project.md','work']);
});

it('surfaces an unavailable observer and leaves the plan directory untouched',async()=>{
 const service=createBlueprintService(home);await service.enable(project);
 await expect(service.draft(project)).rejects.toMatchObject({code:'blueprint_observer_unavailable'});
 expect((await service.state(project)).status).toBe('uninitialized');
 await expect(readdir(join(plans,'projects'))).rejects.toThrow();
});
