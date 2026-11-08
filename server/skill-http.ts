import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Config,SkillDefinition,SkillSource} from '../shared/types';
import { createSkillCatalog } from './skill-catalog';
import { createSkillService } from './skill-service';
import { readConfig, writeConfig } from './config';
import type { Store } from './store';
import { DomainError } from '../shared/workspace-contracts';

// Authenticated workspace-user operations. Invocation agents use the separately bound service.
export function createSkillManagement(home:string,store:Store){
 createSkillService(home,store);
 const catalog=createSkillCatalog(home,store);
 const assertProposal=(skill:SkillDefinition,proposal:{agentId:string;source?:SkillSource},config:Config)=>catalog.assertEvidence({...skill,creatorAgentId:proposal.agentId},proposal.source,undefined,config);
 const suggestionRows=(id:string)=>store.database.prepare('SELECT data FROM skill_suggestions WHERE skill_id=? ORDER BY rowid DESC').all(id).map(row=>JSON.parse(row.data as string));
 return {
  learningStatus(){
   if(!store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_learning_jobs'").get())return {items:[]};
   return {items:store.database.prepare('SELECT data FROM skill_learning_jobs ORDER BY rowid DESC LIMIT 20').all().map(row=>{const job=JSON.parse(row.data as string);return {id:job.id,conversationId:job.conversationId,agentId:job.agentId,state:job.state,error:job.error??null,attempts:job.attempts};})};
  },
  async detail(id:string){
   const {config}=await readConfig(home),skill=config.skillLibrary?.find(item=>item.id===id);
   if(!skill)throw new DomainError('not_found',404,'Skill not found');
   return {skill,versions:skill.unavailable?[]:catalog.versions(skill),suggestions:suggestionRows(id).filter(proposal=>{try{assertProposal(skill,proposal,config);return true;}catch{return false;}})};
  },
  async decide(id:string,suggestionId:string,action:'accept'|'reject',expectedVersionId:string|null){
   const snapshot=await readConfig(home),skill=snapshot.config.skillLibrary?.find(item=>item.id===id);
   if(!skill)throw new DomainError('not_found',404,'Skill not found');
   const suggestion=suggestionRows(id).find(item=>item.id===suggestionId);
   if(!suggestion)throw new DomainError('not_found',404,'Suggestion not found');
   assertProposal(skill,suggestion,snapshot.config);
   if(suggestion.status!=='pending')return {skill,suggestion};
   if((skill.versionRef?.versionId??null)!==expectedVersionId||(suggestion.expectedVersionId??null)!==expectedVersionId)throw new DomainError('stale_revision',409,'Skill version changed; reread this suggestion');
   if(action==='accept'){
    assertProposal(skill,suggestion,snapshot.config);
    const candidate={...skill,path:'',content:suggestion.content,humanMaintained:true,...(suggestion.source?{source:suggestion.source}:{}),...(skill.path?{externalSource:skill.path}:{})};
    const next={...snapshot.config,skillLibrary:snapshot.config.skillLibrary!.map(item=>item.id===id?candidate:item)};
    await writeConfig(home,next,snapshot.revision,()=>{const current=JSON.parse(readFileSync(join(home,'config.json'),'utf8')) as Config;assertProposal(skill,suggestion,current);catalog.assertEvidence(candidate,candidate.source,undefined,current);});
   }
   suggestion.status=action==='accept'?'accepted':'rejected';store.database.prepare('UPDATE skill_suggestions SET data=? WHERE id=?').run(JSON.stringify(suggestion),suggestionId);
   return {skill:(await readConfig(home)).config.skillLibrary!.find(item=>item.id===id)!,suggestion};
  },
 };
}
