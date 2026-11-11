import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {groupChatTurns} from '../shared/chat-turns';
import {presentRun} from '../src/runView';

const home=mkdtempSync(join(tmpdir(),'mandala-replay-')),store=openStore(home);
afterEach(()=>{store.close();rmSync(home,{recursive:true,force:true});});
it('replays final reasoning snapshots instead of thousands of replaced deltas, preserving unfinished work and raw history',()=>{
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const append=(method:string,params:unknown,runId:string|null='run-1')=>store.appendEvent(chat.id,'tool',{method,params,...runId?{runId}:{}});
 store.appendEvent(chat.id,'user',{text:'Request',runId:'run-1'});
 for(let i=0;i<2000;i++)append('item/reasoning/textDelta',{itemId:'thought',delta:'thinking '});
 const snapshot=append('item/completed',{item:{id:'thought',type:'reasoning',summary:[],content:['thinking '.repeat(2000)]}});
 append('item/reasoning/textDelta',{itemId:'unfinished',delta:'Keep unfinished reasoning'});
 append('item/reasoning/textDelta',{itemId:'thought',delta:'A later delta is still live'});
 append('item/reasoning/textDelta',{itemId:'thought',delta:'A different run is independent'},'run-2');
 append('item/reasoning/textDelta',{itemId:'thought',delta:'Legacy events without run identity stay'},null);
 append('item/reasoning/textDelta',{itemId:'empty',delta:'An empty snapshot cannot replace this'});
 append('item/completed',{item:{id:'empty',type:'reasoning',summary:[],content:[]}});
 store.appendEvent(chat.id,'text',{text:'Final answer',runId:'run-1'});
 store.appendEvent(chat.id,'status',{status:'idle',runId:'run-1'});
 const full=store.listEvents(chat.id,0),compact=store.listEvents(chat.id,0,undefined,true);
 expect(compact).toHaveLength(full.length-1999);
 expect(compact[1]).toEqual(full[1]); // First-output timing stays anchored to the original delta.
 expect(presentRun(groupChatTurns(compact)[0])).toEqual(presentRun(groupChatTurns(full)[0]));
 expect(store.listEarlierEvents(chat.id,0,snapshot.id,true)).toHaveLength(2001);
 expect(store.listEarlierEvents(chat.id,0,snapshot.id+1,true).map(e=>e.id)).toEqual([full[0].id,full[1].id,snapshot.id]);
 expect(store.listEvents(chat.id,0)).toEqual(full);
 store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(snapshot.id);
 expect(store.listEvents(chat.id,0,undefined,true)).toHaveLength(full.length-1);
});
