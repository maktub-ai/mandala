import { expect, it } from 'vitest';
import { submitComposerInput,restoreSubmission,type ComposerSubmission } from '../src/composer-submit';
import { composerDraftFingerprint,clearAcceptedComposerDraft } from '../src/composer-drafts';
const request=():ComposerSubmission=>({conversationId:'chat',commandKey:'fixed-key',draftFingerprint:'a'.repeat(128),text:'Original request',attachments:[],references:[],action:'queue',recovery:{}});
it('checkpoints attempted state before POST and durably clears the draft before deleting recovery',async()=>{
 const order:string[]=[],input=request();
 await submitComposerInput(async(_path,method)=>{order.push(method);return {commandKey:'fixed-key',state:'completed'};},input,async state=>{order.push(state?'save:'+state.recovery.attempted:'delete');},async()=>{order.push('clear-draft');});
 expect(order).toEqual(['save:false','save:true','POST','clear-draft','delete']);
});
it('does not issue a mutation when initial recovery persistence fails',async()=>{
 let calls=0;await expect(submitComposerInput(async()=>{calls++;},request(),async()=>{throw Error('storage unavailable');},async()=>{})).rejects.toThrow('storage unavailable');expect(calls).toBe(0);
});
it('keeps recovery when accepted-draft persistence fails',async()=>{
 const states:unknown[]=[];await expect(submitComposerInput(async()=>({commandKey:'fixed-key',state:'completed'}),request(),async state=>{states.push(state);},async()=>{throw Error('draft save failed');})).rejects.toThrow('draft save failed');expect(states.at(-1)).toMatchObject({recovery:{attempted:true}});expect(states).not.toContain(null);
});
it('a restored unknown request only reads its original command key',async()=>{
 const input=restoreSubmission({conversationId:'chat',commandKey:'original',body:{text:'old',attachments:[],references:[]},action:'queue',recovery:{attempted:true,stopAttempted:false,stopConfirmed:false}}),calls:string[]=[];
 await submitComposerInput(async(_path,method)=>{calls.push(method);return [{commandKey:'unrelated',state:'completed'},{commandKey:'original',state:'completed'}];},input,async()=>{},async()=>{});expect(calls).toEqual(['GET']);
});
it('clears a clearly rejected 4xx receipt without masking the original rejection',async()=>{
 const states:unknown[]=[];await expect(submitComposerInput(async()=>{throw Object.assign(Error('Forbidden'),{status:403});},request(),async state=>{states.push(state);},async()=>{})).rejects.toThrow('Forbidden');expect(states.at(-1)).toBe(null);
});
it('a lost interrupt acknowledgment never issues another stop',async()=>{
 const input=request();input.action='interrupt';input.recovery={stopAttempted:true};let calls=0;
 await expect(submitComposerInput(async()=>{calls++;},input,async()=>{},async()=>{})).rejects.toThrow('停止状态待确认');expect(calls).toBe(0);
});
it('a restored metadata-only attachment matches its original draft but changed input remains',()=>{
 const file=new File(['evidence'],'note.txt',{type:'text/plain',lastModified:42}),original={text:'Original',references:[],files:[file],missingAttachments:[]},fingerprint=composerDraftFingerprint(original);
 const restored={...original,files:[],missingAttachments:[{name:file.name,size:file.size,type:file.type,lastModified:file.lastModified}]};
 expect(clearAcceptedComposerDraft(restored,fingerprint)).toEqual({text:'',references:[],files:[],missingAttachments:[]});expect(clearAcceptedComposerDraft({...restored,text:'New input'},fingerprint).text).toBe('New input');
});
