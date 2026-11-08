import { expect, it, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ComposerDraftNotice from '../src/ComposerDraftNotice';
import QueuedMessages from '../src/QueuedMessages';
import ComposerActions from '../src/ComposerActions';
import NativeQuestions from '../src/NativeQuestions';
import {LanguageProvider} from '../src/i18n';
afterEach(()=>vi.unstubAllGlobals());
for(const reason of ['directory','concurrency'])it(`shows ${reason} queueing instead of runtime startup`,async()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'zh-CN'});
 const {default:TurnProcess}=await import('../src/TurnProcess');
 const {groupChatTurns}=await import('../src/chatTurns');
 const {presentRun}=await import('../src/runView');
 const turn=groupChatTurns([
  {id:1,conversationId:'c',kind:'user',data:{text:'Continue',runId:'r'},createdAt:'2026-11-02T02:00:00Z'},
  {id:2,conversationId:'c',kind:'metadata',data:{queuedInputId:'input',state:'queued',reason,nativeTurnSubmitted:false,runId:'r'},createdAt:'2026-11-02T02:00:01Z'},
 ])[0];
 const markup=renderToStaticMarkup(createElement(LanguageProvider,null,createElement(TurnProcess,{turn,onInspect(){}})));
 expect(markup).toContain(reason==='directory'?'等待目录释放':'等待执行名额');
 expect(markup).not.toContain('正在启动执行端');
 expect(markup).not.toContain('未收到新事件');
 expect(presentRun(turn).status).toBe('queued');
 turn.events.push({id:3,conversationId:'c',kind:'status',data:{status:'running'},createdAt:'2026-11-02T02:00:02Z'});
 expect(presentRun(turn).status).toBe('running');
});
for(const language of ['zh-CN','en'])it(`renders queue and native questions in ${language} without pre-submitting a choice`,()=>{
 vi.stubGlobal('localStorage',{getItem:()=>language});
 const render=(component:any)=>renderToStaticMarkup(createElement(LanguageProvider,null,component));
 const queue=render(createElement(QueuedMessages,{inputs:[{id:'a',conversationId:'c',text:'',attachments:['image'],state:'queued',createdAt:''}],onCopy(){}, onReuse(){}, onCancel(){}}));
 expect(queue).toContain(language==='en'?'Attachment message':'附件消息');
 expect(queue).toContain(language==='en'?'Cancel queued message':'取消排队');
 expect(render(createElement(QueuedMessages,{inputs:[],onCopy(){}, onReuse(){}, onCancel(){}}))).toBe('');
 const questions=render(createElement(NativeQuestions,{approval:{id:'q',conversationId:'c',nativeRequestId:42,method:'item/tool/requestUserInput',params:{questions:[{id:'where',header:'Preview',question:'Where?',options:[{label:'In app',description:'Preview here'}]}]}},pending:false,onSubmit(){}}));
 expect(questions).toContain('Where?');expect(questions).toContain('Preview here');
 expect(questions).not.toContain('checked=""');expect(questions).toMatch(/<button\b(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>/);
});
it('renders valid question ids that match Object prototype keys',()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'zh-CN'});
 for(const id of ['constructor','toString','__proto__'])expect(()=>renderToStaticMarkup(createElement(LanguageProvider,null,createElement(NativeQuestions,{approval:{id:'q',conversationId:'c',nativeRequestId:42,method:'item/tool/requestUserInput',params:{questions:[{id,header:'Preview',question:'Where?'}]}},pending:false,onSubmit(){}})))).not.toThrow();
});

it('renders the whole explicitly reported progress message rather than a 240 character excerpt', async()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'zh-CN'});
 const {default:TurnProcess}=await import('../src/TurnProcess');
 const {groupChatTurns}=await import('../src/chatTurns');
 const text='Current progress '.repeat(30)+'END OF PROGRESS';
 const events:any[]=[{id:1,conversationId:'c',kind:'user',data:{text:'request'},createdAt:'2026-10-13T01:00:00Z'},{id:2,conversationId:'c',kind:'status',data:{status:'running'},createdAt:'2026-10-13T01:00:01Z'},{id:3,conversationId:'c',kind:'progress',data:{source:'cli',runId:'r',text},createdAt:'2026-10-13T01:00:02Z'}];
 const turns=groupChatTurns(events);
 const html=renderToStaticMarkup(createElement(LanguageProvider,null,createElement(TurnProcess,{turn:turns[0],onInspect(){}})));
 expect(html).toContain(text);
});

for(const language of ['zh-CN','en'])it(`separates completed execution from a pending collaboration in ${language}`,()=>{
 vi.stubGlobal('localStorage',{getItem:()=>language});
 const props={busy:false,waiting:true,stopping:false,disabled:true,stopDisabled:false,continuing:false,onStop(){},onSend(){},onInterrupt(){}};
 const render=(busy:boolean,waiting:boolean)=>renderToStaticMarkup(createElement(LanguageProvider,null,createElement(ComposerActions,{...props,busy,waiting})));
 const paused=render(false,true);expect(paused).not.toContain(language==='en'?'Stop execution':'停止执行');expect(paused).toContain(language==='en'?'Cancel collaboration wait':'取消等待协作');
 expect(render(false,false)).not.toContain('stop-button');expect(render(true,true)).toContain(language==='en'?'Stop execution':'停止执行');
});

for(const status of ['loading','saving','saved'] as const)it(`keeps routine draft ${status} invisible while typing`,()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'zh-CN'});
 const draft={status,value:{text:'字',files:[],references:[],missingAttachments:[]}} as any;
 expect(renderToStaticMarkup(createElement(LanguageProvider,null,createElement(ComposerDraftNotice,{draft})))).toBe('');
});
