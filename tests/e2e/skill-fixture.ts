import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../../server/store';
import { createSkillService } from '../../server/skill-service';
import { readConfig, writeConfig } from '../../server/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function skillFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store){
 if(req.method!=='POST'||!['/__test__/skills/seed','/__test__/skills/seed-package'].includes(req.url??''))return false;
 const initial=await readConfig(home);
 const agents=['skill-owner','skill-reviewer'].map(id=>({id,name:id==='skill-owner'?'Skill owner':'Skill reviewer',instructions:'',defaultCli:'codex' as const,models:{},mcp:[],skills:[]}));
 if(req.url==='/__test__/skills/seed-package'){
  const directory=join(home,'export-package'),content='---\nname: export-review\ndescription: Review a complete package\n---\nRead references/指南.md and run scripts/check.sh.';
  await mkdir(join(directory,'references'),{recursive:true});await mkdir(join(directory,'scripts'),{recursive:true});await mkdir(join(directory,'assets'),{recursive:true});
  await writeFile(join(directory,'SKILL.md'),content);await writeFile(join(directory,'references','指南.md'),'完整技能参考资料');await writeFile(join(directory,'scripts','check.sh'),'#!/bin/sh\nprintf checked\n',{mode:0o700});await writeFile(join(directory,'assets','sample.bin'),Buffer.from([0,255,137,80,78,71,13,10]));
  await writeConfig(home,{...initial.config,skillLibrary:[...initial.config.skillLibrary?.filter(skill=>skill.id!=='export-review')??[],{id:'export-review',name:'export-review',path:'',content}]},initial.revision,undefined,undefined,new Map([['export-review',directory]]));
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({skill:(await readConfig(home)).config.skillLibrary!.find(skill=>skill.id==='export-review')}));return true;
 }
 await writeConfig(home,{version:2,projects:[],agents},initial.revision);
 const service=createSkillService(home,store),content='---\nname: persisted-review\ndescription: Review a persisted result\n---\nRead back the result; acceptance is separate.';
 const registered=await service('skill-owner','skill_register',{name:'persisted-review',content},'browser-seed-'+initial.revision,()=>{}) as any;
 const snapshot=await readConfig(home);snapshot.config.agents[1].skillIds=[registered.skill.id];await writeConfig(home,snapshot.config,snapshot.revision);
 const proposed=await service('skill-reviewer','skill_update',{skillId:registered.skill.id,content:content+'\nCheck related states.',expectedVersionId:registered.skill.versionRef.versionId},'browser-proposal-'+initial.revision,()=>{}) as any;
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({skill:registered.skill,suggestion:proposed.suggestion}));return true;
}
