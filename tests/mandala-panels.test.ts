import {expect,it} from 'vitest';
import {groupTasksByIdentity} from '../src/TaskIdentityGroups';
import {goalTaskIds,maintainedTeams} from '../src/MandalaPanels';
import {agentActivity,matchesAgentFilter} from '../src/MandalaTeamsTab';
import {relativeTime} from '../src/mandala-panel-time';
import {runningConversationCount,type ConversationProgress} from '../shared/conversation-progress';
import type {Config} from '../shared/types';
import type {Task} from '../shared/tasks';
it('uses Project membership without duplicating identity and omits temporary or archived maintained Agents',()=>{
 const agent=(id:string)=>({id,name:id,instructions:'',defaultCli:'codex' as const,models:{},mcp:[],skills:[]});
 const config:Config={version:2,agents:[agent('shared'),agent('independent'),{...agent('temp'),temporary:true},{...agent('archived'),archivedAt:'today'},{...agent('main'),systemRole:'mandala'}],projects:['p','q'].map(id=>({id,name:id,cwd:'',agentIds:['shared','temp'],resources:[],mcp:[],skills:[]}))};
 const teams=maintainedTeams(config);
 expect(teams.agents.map(agent=>agent.id)).toEqual(['shared','independent']);
 expect(teams.groups.map(group=>group.agents.map(agent=>agent.id))).toEqual([['shared'],['shared'],['independent']]);
 expect(teams.groups[0].agents[0]).toBe(teams.groups[1].agents[0]);
});
it('counts raw running only, never closed markers, live children, approval or missing history status',()=>{
 const rows=[{executionStatus:'running',state:'completed'},{executionStatus:'error',live:true,state:'attention'},{executionStatus:'approval',live:true},{state:'running',live:true},{executionStatus:null,state:'running'}] as ConversationProgress[];
 expect(runningConversationCount(rows)).toBe(1);
});
it('keeps ownership on the task itself instead of expanding other tasks',()=>{
 expect([...goalTaskIds('goal')]).toEqual(['goal']);
});
it('splits Agents into working, recently active and idle from raw execution status',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z'),row=(agentId:string,executionStatus:string|null,activityAt:string)=>({id:agentId+activityAt,agentId,executionStatus,activityAt,active:false} as unknown as ConversationProgress);
 const rows=[row('a','running','2026-11-08T11:59:00Z'),row('a','idle','2026-11-01T00:00:00Z'),row('b','approval','2026-11-05T00:00:00Z'),row('c','idle','2026-11-08T09:00:00Z'),row('d','idle','2026-11-01T00:00:00Z')];
 const [a,b,c,d]=['a','b','c','d'].map(id=>agentActivity(id,rows,now));
 expect([a.running,a.chats.length,a.working]).toEqual([1,1,true]);
 expect([b.approvals,b.working,b.recent]).toEqual([1,true,true]);
 expect([c.working,c.recent,matchesAgentFilter(c,'recent'),matchesAgentFilter(c,'working')]).toEqual([false,true,true,false]);
 expect([d.recent,d.chats.length,matchesAgentFilter(d,'all')]).toEqual([false,0,true]);
 expect([a,b,c,d].map(item=>item.rank)).toEqual([0,1,3,4]);
});
it('formats short relative times both ways',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z');
 expect(relativeTime('2026-11-08T09:00:00Z',false,now)).toBe('3 小时前');
 expect(relativeTime('2026-11-08T12:20:00Z',true,now)).toBe('in 20 min');
 expect(relativeTime(null,false,now)).toBe('');
});

it('groups the same unique tasks by assigned Agent or every current project including unassigned tasks',()=>{
 const task=(id:string,assigneeAgentId:string|null,projectIds:string[]|undefined,projectId:string|null=null)=>({id,assigneeAgentId,projectIds,projectId} as Task);
 const shared=task('shared','a',['p','q','q']),unassigned=task('solo',null,[],'legacy-route'),legacy=task('legacy','a',undefined,'p');
 const tasks=[unassigned,shared,legacy,shared];
 const byAgent=groupTasksByIdentity(tasks,'agent'),byProject=groupTasksByIdentity(tasks,'project');
 expect([...byAgent.keys()]).toEqual(['a',null]);
 expect([...byProject.keys()]).toEqual(['p','q',null]);
 expect(byAgent.get('a')?.map(t=>t.id)).toEqual(['shared','legacy']);
 expect(byAgent.get(null)?.map(t=>t.id)).toEqual(['solo']);
 expect(byProject.get('p')?.map(t=>t.id)).toEqual(['shared','legacy']);
 expect(byProject.get('q')?.map(t=>t.id)).toEqual(['shared']);
 expect(byProject.get(null)?.map(t=>t.id)).toEqual(['solo']);
 expect(new Set([...byAgent.values()].flat()).size).toBe(3);
 expect(new Set([...byProject.values()].flat()).size).toBe(3);
});

import {collabChatStatus,collabSections} from '../src/mandala-collab';
import type {MandalaGoal} from '../shared/mandala-coordination';
import type {AutomationRun} from '../shared/automations';
const progress=(id:string,extra:Partial<ConversationProgress>={})=>({id,title:id,agentId:'a',projectId:'',cli:'codex',executionStatus:'idle',state:'recent',reopenState:'recent',active:true,live:false,withinWindow:true,activityAt:'2026-11-20T10:00:00Z',completedAt:null,requestPreview:null,hasNewActivity:false,taskIds:[],relatedConversationIds:[],handoff:null,directUserAt:null,...extra}) as ConversationProgress;
const handoff=(state:'queued'|'running'|'succeeded'|'failed'|'unknown',replyState:'pending'|'queued'|'consumed'|'parked'='pending',source='main')=>({sourceConversationId:source,state,replyState,createdAt:'2026-11-20T09:00:00Z'});
it('tells a reply Mandala has followed up apart from one still waiting, and lets a direct follow-up speak for itself',()=>{
 expect(collabChatStatus(progress('c',{handoff:handoff('succeeded','consumed')}),[])).toBe('summarized');
 expect(collabChatStatus(progress('c',{handoff:handoff('succeeded','parked')}),[])).toBe('replied');
 expect(collabChatStatus(progress('c',{handoff:handoff('running')}),[])).toBe('running');
 expect(collabChatStatus(progress('c',{handoff:handoff('failed')}),[])).toBe('failed');
 expect(collabChatStatus(progress('c',{handoff:handoff('succeeded','consumed'),executionStatus:'approval'}),[])).toBe('approval');
 // The user then asks again in the chat itself.
 const direct={handoff:handoff('succeeded','consumed'),directUserAt:'2026-11-20T09:30:00Z'};
 expect(collabChatStatus(progress('c',{...direct,executionStatus:'running'}),[])).toBe('running');
 expect(collabChatStatus(progress('c',{...direct,activityAt:'2026-11-20T09:40:00Z'}),[])).toBe('replied');
 expect(collabChatStatus(progress('c',{...direct,activityAt:'2026-11-20T09:30:00Z'}),[])).toBe('idle');
});
it('puts Chats first-class beside Tasks: needs you, then activity by latest change, then wrapped up',()=>{
 const task=(id:string,state:Task['state'],conversationIds:string[]=[],activityAt='2026-11-20T08:00:00Z')=>({id,goal:id+'\nmore',state,waitingReason:null,assigneeAgentId:'a',projectIds:[],conversationIds,executions:conversationIds.map(conversationId=>({id:'e-'+conversationId,conversationId,agentId:'a',title:conversationId,createdAt:activityAt})),activityAt,createdAt:activityAt}) as unknown as Task;
 const goal=(taskId:string,conversationId='main')=>({taskId,conversationId,blockedReason:null}) as MandalaGoal;
 const tasks=[task('review','review'),task('working','running',['w1','w2']),task('quiet','running',['q1'],'2026-11-20T11:00:00Z'),task('done','completed'),task('elsewhere','running')];
 const goals=[goal('review'),goal('working'),goal('quiet'),goal('done'),goal('elsewhere','other')];
 const rows=[
  progress('w1',{executionStatus:'running',taskIds:['working'],activityAt:'2026-11-20T10:30:00Z'}),progress('w2',{taskIds:['working']}),progress('q1',{taskIds:['quiet']}),
  progress('test',{handoff:handoff('succeeded','consumed'),activityAt:'2026-11-20T10:45:00Z'}),
  progress('broken',{handoff:handoff('failed')}),
  progress('old',{handoff:handoff('succeeded','consumed'),active:false}),
  progress('other-main',{handoff:handoff('succeeded','consumed','other')}),
  progress('plain'),
 ];
 const runs=[{id:'r',automationId:'rule',name:'Weekly report',taskState:'review',reportConversationId:'main',createdAt:'2026-11-20T07:00:00Z'} as AutomationRun];
 const sections=collabSections({conversationId:'main',scope:'conversation',goals,tasks,rows,runs});
 const ids=(items:typeof sections.needs)=>items.map(item=>item.kind+':'+item.id);
 expect(ids(sections.needs)).toEqual(['chat:broken','task:review','run:r']);
 expect(ids(sections.active)).toEqual(['task:quiet','chat:test','task:working']);
 expect(ids(sections.done)).toEqual(['chat:old','task:done']);
 const working=sections.active.find(item=>item.id==='working');
 expect(working?.kind==='task'&&[working.defaultOpen,working.chats.map(chat=>chat.status)]).toEqual([true,['running','idle']]);
 const quiet=sections.active.find(item=>item.id==='quiet');
 expect(quiet?.kind==='task'&&quiet.defaultOpen).toBe(false);
 const all=collabSections({conversationId:'main',scope:'all',goals,tasks,rows,runs});
 expect([...all.needs,...all.active,...all.done].map(item=>item.id)).toEqual(expect.arrayContaining(['elsewhere','other-main']));
 expect(collabSections({conversationId:'main',scope:'conversation',goals,tasks,rows,runs,query:'W2'}).active.map(item=>item.id)).toEqual(['working']);
});
