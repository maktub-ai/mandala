import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store';
import {createSessionManager} from '../server/sessions';
import {saveAttachment,loadAttachments} from '../server/attachments';
import {startCodex} from '../server/codex';
const home=await mkdtemp(join(tmpdir(),'mana-native-input-'));
const store=openStore(home),sent:unknown[]=[];
const manager=createSessionManager(store,async()=>({version:2,projects:[],agents:[]}),async options=>{
 const client=await startCodex(options);
 return {...client,async startTurn(id,text,mode,roots,turnOptions){sent.push(turnOptions);return client.startTurn(id,text,mode,roots,turnOptions);}};
},undefined,home);
const wait=async(id:string)=>{const until=Date.now()+120000;while(['running','approval'].includes(store.getConversation(id)!.status)){if(Date.now()>until)throw new Error('Native input smoke timeout');await new Promise(r=>setTimeout(r,100));}if(store.getConversation(id)?.status==='error')throw new Error('Native input failed; inspect temporary events');};
const answer=(id:string)=>store.listEvents(id,0).filter(e=>e.kind==='text').map(e=>(e.data as {text:string}).text).join('');
try{
 const models=await manager.listModels();
 const first=models.find(m=>m.id==='gpt-6.1-sol')??models[0];
 const second=models.find(m=>m.id==='gpt-6-sol')??models.find(m=>m.id!==first.id);
 if(!first||!second)throw new Error('Two native models required for acceptance');
 const effort=first.supportedReasoningEfforts?.includes('low')?'low':first.defaultReasoningEffort;
 const chat=await manager.create('','',first.id,'codex',{cwd:home,approvalMode:'auto',effort});
 const attachment=await saveAttachment(home,chat.id,'sample.txt',Buffer.from('SYNTHETIC_ATTACHMENT_READ_OK'));
 await manager.send(chat.id,'Read the attached sample.txt using a file tool. Reply with only its exact contents.',await loadAttachments(home,chat.id,[attachment.id]));
 await wait(chat.id);
 if(!answer(chat.id).includes('SYNTHETIC_ATTACHMENT_READ_OK'))throw new Error('Real attachment contents were not returned');
 const nativeId=store.getConversation(chat.id)!.nativeId;
 console.log('PASS native file read; model='+first.id+' effort='+effort);
 await manager.setModel(chat.id,second.id,second.supportedReasoningEfforts?.includes('low')?'low':second.defaultReasoningEffort);
 await manager.send(chat.id,'Do not use tools. Reply exactly: SYNTHETIC_MODEL_SWITCH_OK');await wait(chat.id);
 if(store.getConversation(chat.id)!.nativeId!==nativeId||!answer(chat.id).includes('SYNTHETIC_MODEL_SWITCH_OK'))throw new Error('Native switch failed');
 console.log('PASS second model on same native thread; model='+second.id+' sent='+JSON.stringify(sent));
}finally{await manager.close();store.close();await rm(home,{recursive:true,force:true});}
