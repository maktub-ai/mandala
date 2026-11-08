import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOutbox } from './outbox';

// Fixed completion events only; callers include this in the transcript transaction.
export function enqueueSkillCompletion(db:DatabaseSync,home:string,id:string,eventId:number,requestedForce?:boolean){
 const row=db.prepare('SELECT data FROM conversations WHERE id=?').get(id);if(!row)return;
 const chat=JSON.parse(row.data as string);if(!chat.agentId)return;
 let enabled=true;try{enabled=JSON.parse(readFileSync(join(home,'config.json'),'utf8')).system?.skillLearning!==false;}catch(error){enabled=(error as NodeJS.ErrnoException).code==='ENOENT';}
 const epoch=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_learning_policy'").get()?Number(db.prepare('SELECT epoch FROM skill_learning_policy WHERE id=1').get()?.epoch??0):0;
 const user=db.prepare("SELECT data FROM events WHERE conversationId=? AND kind='user' AND superseded=0 AND id<=? ORDER BY id DESC LIMIT 1").get(id,eventId);
 const explicit=/沉淀|整理.*技能|(?:save|register|distill).{0,30}skill/i.test(user?JSON.parse(user.data as string).text??'':'');
 const type=requestedForce===undefined?'skill.dialogue_completed':'skill.capture_requested';
 createOutbox(db).enqueueOutbox({type,aggregateId:id,aggregateRevision:eventId,causationId:type+':'+eventId+(requestedForce===undefined?'':':'+requestedForce),payload:{conversationId:id,eventId,agentId:chat.agentId,projectId:chat.projectId,epoch,enabled,force:requestedForce??explicit}});
}
