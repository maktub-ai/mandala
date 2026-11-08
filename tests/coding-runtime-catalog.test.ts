import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeIds,runtimeCatalog,isCli,supportsSystemTasks} from '../shared/runtimes';
import type {Cli,Config} from '../shared/types';
import {openStore} from '../server/store';
import {createChatPreferences} from '../server/chat-preferences';
import {discoverTeamCapabilities} from '../server/team-capability-discovery';

const candidates=['codebuddy','pi','cursor','kimi','dsh','antigravity','grok','hermes','openclaw'];
it('registers local coding runtimes and keeps unrelated excluded products absent',()=>{
 for(const id of candidates){expect(isCli(id),id).toBe(true);expect(runtimeCatalog[id as Cli].command).toBeTruthy();}
 for(const id of ['trae','traecode'])expect(runtimeIds).not.toContain(id);
});
it('widens the existing strict approval schema without losing any saved choices',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mandala-coding-runtimes-')),store=openStore(home);
 try{
  store.database.exec("CREATE TABLE chat_approval_preferences(owner_user_id TEXT NOT NULL,agent_id TEXT NOT NULL,cli TEXT CHECK(cli IN ('codex','omp','claude','gemini','opencode')),approval_mode TEXT CHECK(approval_mode IN ('default','strict','auto')),PRIMARY KEY(owner_user_id,agent_id,cli)); INSERT INTO chat_approval_preferences VALUES('local','a','codex','strict')");
  const preferences=createChatPreferences(store);
  const config:Config={version:2,projects:[],runtimes:['codex',...candidates as Cli[]],agents:[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]};
  expect(preferences.getApproval(config,'a','codex')).toBe('strict');
  for(const cli of candidates as Cli[]){preferences.setApproval(config,'a',cli,'strict');expect(preferences.getApproval(config,'a',cli)).toBe('strict');}
  // Reopening the preference service must not rebuild or lose the widened rows.
  expect(createChatPreferences(store).getApproval(config,'a','cursor' as Cli)).toBe('strict');
 }finally{store.close();await rm(home,{recursive:true,force:true});}
});
it('discovers metadata for every registered runtime without the old five-runtime input limit',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mandala-runtime-discovery-'));
 try{
  const result=await discoverTeamCapabilities({version:2,projects:[],agents:[],runtimes:['codex','omp','claude','gemini','opencode',...candidates] as Cli[]},{},{userHome:home,codexMcpList:async()=>[]});
  expect(result.selection.runtimes).toHaveLength(14);
 }finally{await rm(home,{recursive:true,force:true});}
});

it.each(['hermes','openclaw'] as const)('registers %s as Gateway-backed ACP without claiming restricted tools',cli=>{
 expect(runtimeCatalog[cli]).toMatchObject({command:cli,args:['acp'],protocol:'acp'});
 expect(supportsSystemTasks(cli)).toBe(false);
});
