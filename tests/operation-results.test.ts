import {expect,it} from 'vitest';
import {projectOperationOutcome} from '../server/operation-results';
import {managedValueText} from '../shared/mandala-coordination';
it('keeps a saved paused schedule distinct from enabled execution and copies no credentials',()=>{
 const outcome=projectOperationOutcome('automation_create',{}, {id:'rule',name:'Review',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'},nextRunAt:null,instructions:'private',token:'secret'});
 expect(outcome).toMatchObject({kind:'automation',name:'Review',facts:{enabled:'false',schedule:'09:00',timeZone:'Asia/Singapore'}});
 expect(JSON.stringify(outcome)).not.toContain('secret');expect(JSON.stringify(outcome)).not.toContain('private');
});
it('uses supported outcome identities and never renders arbitrary read responses as cards',()=>{
 expect(projectOperationOutcome('mandala_delegate',{}, {id:'run',taskId:'task',state:'queued'})).toMatchObject({kind:'task',facts:{runState:'queued'},path:'/tasks/task'});
 expect(projectOperationOutcome('task_read',{}, {id:'task',goal:'Private detail'})).toBeUndefined();
 expect(projectOperationOutcome('artifact_publish',{}, {assetId:'asset',versionId:'version'})).toMatchObject({kind:'content',facts:{version:'version'}});
});
it('summarizes capability bindings without exposing connection environment values',()=>{
 expect(managedValueText('mcp',[{name:'Warehouse',env:{TOKEN:'secret'},url:'https://secret.example'}])).toBe('Warehouse');
 expect(managedValueText('runtime',{codex:{env:{TOKEN:'secret'}}})).not.toContain('secret');
});
it('projects pending content work and exact automation, Wiki and Skill destinations',()=>{
 expect(projectOperationOutcome('automation_run',{automationId:'rule'}, {id:'run',automationId:'rule',status:'queued'})).toMatchObject({path:'/schedules?schedule=rule',facts:{runState:'queued'}});
 expect(projectOperationOutcome('wiki_restore',{baseId:'wiki'}, {id:'wiki',headVersionId:'version',lastJob:{state:'queued'}})).toMatchObject({path:'/library/wiki',facts:{version:'version',workState:'queued'}});
 expect(projectOperationOutcome('wiki_add_source',{baseId:'wiki'}, {id:'source',baseId:'wiki'})).toMatchObject({path:'/library/wiki'});
 expect(projectOperationOutcome('skill_update',{skillId:'skill'}, {suggestion:{skillId:'skill',status:'pending'}})).toMatchObject({path:'/settings/skills?skill=skill',facts:{workState:'pending'}});
});
it('retains discovery incompleteness from actual source status and truncation notices',()=>{
 expect(projectOperationOutcome('mandala_discover_capabilities',{}, {items:[],sources:[{scope:'user',kind:'skill',status:'ok',truncated:false}]})).toMatchObject({facts:{sources:'user: ok'}});
 expect(projectOperationOutcome('mandala_discover_work',{}, {candidates:[],sources:[{runtime:'codex',status:'ok',truncated:true},{runtime:'claude',status:'unsupported',truncated:false}],notices:[]})).toMatchObject({facts:{truncated:'true',unavailableSources:'1',sources:'codex: ok · claude: unsupported'}});
 expect(projectOperationOutcome('mandala_discover_work',{}, {candidates:[],sources:[{runtime:'codex',status:'ok',truncated:false}],notices:['candidate_limit: showing 10 of 20 resolved candidates.']})).toMatchObject({facts:{truncated:'true'}});
});
it.each(['automation_update','task_update','skill_update'])('preserves unchanged results for %s without presenting them as a change',command=>{
 expect(projectOperationOutcome(command,{}, {id:'item',unchanged:true})).toMatchObject({facts:{unchanged:'true'}});
});
it('does not infer no change from a task stop status that may revoke continuation',()=>{
 expect(projectOperationOutcome('task_stop',{}, {taskId:'finished-task',status:'already_finished'})).not.toMatchObject({facts:{unchanged:'true'}});
});
