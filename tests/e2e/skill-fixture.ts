import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../../server/store';
import { createSkillService } from '../../server/skill-service';
import { readConfig, writeConfig } from '../../server/config';
export async function skillFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store){
 if(req.method!=='POST'||req.url!=='/__test__/skills/seed')return false;
 const initial=await readConfig(home);
 const agents=['skill-owner','skill-reviewer'].map(id=>({id,name:id==='skill-owner'?'Skill owner':'Skill reviewer',instructions:'',defaultCli:'codex' as const,models:{},mcp:[],skills:[]}));
 await writeConfig(home,{version:2,projects:[],agents},initial.revision);
 const service=createSkillService(home,store),content='---\nname: persisted-review\ndescription: Review a persisted result\n---\nRead back the result; acceptance is separate.';
 const registered=await service('skill-owner','skill_register',{name:'persisted-review',content},'browser-seed-'+initial.revision,()=>{}) as any;
 const snapshot=await readConfig(home);snapshot.config.agents[1].skillIds=[registered.skill.id];await writeConfig(home,snapshot.config,snapshot.revision);
 const proposed=await service('skill-reviewer','skill_update',{skillId:registered.skill.id,content:content+'\nCheck related states.',expectedVersionId:registered.skill.versionRef.versionId},'browser-proposal-'+initial.revision,()=>{}) as any;
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({skill:registered.skill,suggestion:proposed.suggestion}));return true;
}
