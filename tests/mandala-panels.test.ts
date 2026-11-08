import {expect,it} from 'vitest';
import {goalTaskIds,maintainedTeams} from '../src/MandalaPanels';
import {agentActivity,matchesAgentFilter} from '../src/MandalaTeamsTab';
import {relativeTime} from '../src/mandala-panel-time';
import {runningConversationCount,type ConversationProgress} from '../shared/conversation-progress';
import type {Config} from '../shared/types';
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
