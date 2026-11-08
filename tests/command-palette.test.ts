import { expect, test, vi } from 'vitest';
import { paletteCommands, parsePaletteQuery, matchPaletteCommands, preselectPaletteTarget, createPaletteRequestGate, paletteKeyIntent, paletteCommandUnavailable, recentPaletteCommands } from '../shared/command-palette';

// Radix portals intentionally do not render on the server. This suite inspects
// palette row semantics; modal focus/dismissal is covered by browser tests.
vi.mock('../src/Dialog', () => ({ default: ({ children }: {children: import('react').ReactNode}) => children }));

test('command and object modes are explicit and normalized, and help never executes', () => {
 expect(parsePaletteQuery('> ＭＯＤＥＬ')).toEqual({mode:'commands',query:'model'});
 expect(parsePaletteQuery('账单')).toEqual({mode:'objects',query:'账单'});
 expect(parsePaletteQuery('?')).toEqual({mode:'help',query:''});
});
test('commands match all Chinese and English keywords without running anything', () => {
 expect(matchPaletteCommands('切换 模型').map(c=>c.id)).toContain('model');
 expect(matchPaletteCommands('NEW CHAT').map(c=>c.id)).toContain('new-chat');
 expect(matchPaletteCommands('task link').map(c=>c.id)).toContain('task-link');
 expect(matchPaletteCommands('model impossible')).toEqual([]);
 expect(new Set(paletteCommands.map(c=>c.id)).size).toBe(paletteCommands.length);
});
test('preselection only chooses the current object when it is in the authorized returned pool', () => {
 const items=[{id:'other'},{id:'current'}];
 expect(preselectPaletteTarget(items,'current')).toBe(1);
 expect(preselectPaletteTarget(items,'denied')).toBe(0);
 expect(preselectPaletteTarget([],'current')).toBe(-1);
});
test('late asynchronous responses and invalidated picker responses cannot become active', async () => {
 const gate=createPaletteRequestGate(),old=gate.next(),current=gate.next(),apply=vi.fn();
 await Promise.resolve();if(gate.isCurrent(old))apply('old');if(gate.isCurrent(current))apply('current');
 expect(apply.mock.calls).toEqual([['current']]);
 gate.next();expect(gate.isCurrent(current)).toBe(false);
});
test('IME composition, legacy keyCode 229, modifiers and text editing do not execute rows', () => {
 expect(paletteKeyIntent({key:'Enter',isComposing:true})).toBe(null);
 expect(paletteKeyIntent({key:'Enter',keyCode:229})).toBe(null);
 expect(paletteKeyIntent({key:'Enter',metaKey:true})).toBe(null);
 expect(paletteKeyIntent({key:'Tab'})).toBe(null);
 expect(paletteKeyIntent({key:'ArrowDown'})).toBe('next');
 expect(paletteKeyIntent({key:'Enter'})).toBe('execute');
 expect(paletteKeyIntent({key:'Escape'})).toBe('back');
});
test('unavailable commands explain actual context and edit locks', () => {
 expect(paletteCommandUnavailable('model',{})).toBe('conversation');
 expect(paletteCommandUnavailable('stop',{})).toBe(null);
 expect(paletteCommandUnavailable('model',{conversation:{id:'c',status:'approval'} as any})).toBe('running');
 expect(paletteCommandUnavailable('new-chat',{navigationLocked:true})).toBe('locked');
 expect(paletteCommandUnavailable('theme',{navigationLocked:true})).toBe(null);
});
test('recent history accepts known command IDs only and cannot store titles or object payloads', () => {
 expect(recentPaletteCommands(['model','secret transcript','theme','model',{}])).toEqual(['model','theme']);
});

test('link flow reads fresh task revision, sends a stable idempotency key, and propagates conflict without blind replay', async()=>{
 const {linkPaletteConversation}=await import('../src/CommandPalette');
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({task:{id:'task',revision:8,conversationIds:[]}}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({error:'revision_conflict'}),{status:409}));
 await expect(linkPaletteConversation('task','chat','stable-key')).rejects.toThrow('revision_conflict');
 expect(fetchMock).toHaveBeenCalledTimes(2);
 const [path,options]=fetchMock.mock.calls[1];expect(path).toBe('/api/v2/tasks/task/executions');
 expect(options?.headers).toMatchObject({'Idempotency-Key':'stable-key'});expect(JSON.parse(options?.body as string)).toEqual({conversationId:'chat',expectedRevision:8});
 fetchMock.mockRestore();
});
test('link flow treats an existing relation as already done, and read denial never sends a mutation',async()=>{
 const {linkPaletteConversation}=await import('../src/CommandPalette');
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({task:{revision:4,conversationIds:['chat']}}),{status:200}));
 await linkPaletteConversation('task','chat','key');expect(fetchMock).toHaveBeenCalledTimes(1);
 fetchMock.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({error:'forbidden'}),{status:403}));
 await expect(linkPaletteConversation('task','chat','key')).rejects.toThrow('forbidden');expect(fetchMock).toHaveBeenCalledTimes(1);fetchMock.mockRestore();
});

test('stop targets filter authorized real executions before limiting and deduplicate conversation projections',async()=>{
 const {stoppablePaletteTargets}=await import('../shared/command-palette');
 const execution=(id:string,state='running',accessible=true)=>({id,conversationId:id,taskId:null,projectId:null,agentId:null,kind:'conversation',state,accessible,title:id,href:'/?conversation='+id,time:''});
 const snapshot={agents:[{executions:[...Array.from({length:65},(_,i)=>execution('idle-'+i,'queued')),execution('Old target'),execution('Old target'),execution('approval target','approval'),execution('secret target','running',false),execution('unknown target','unknown')]}]} as any;
 const config={version:2,projects:[],agents:[]} as any;
 expect(stoppablePaletteTargets(snapshot,config,'').map(hit=>hit.id)).toEqual(['Old target','approval target']);
 expect(stoppablePaletteTargets(snapshot,config,'ＯＬＤ TARGET').map(hit=>hit.id)).toEqual(['Old target']);
 expect(stoppablePaletteTargets(snapshot,config,'secret')).toEqual([]);
 const many={agents:[{executions:Array.from({length:70},(_,i)=>execution('running-'+i))}]} as any;
 expect(stoppablePaletteTargets(many,config,'')).toHaveLength(60);
 expect(stoppablePaletteTargets(many,config,'running-69').map(hit=>hit.id)).toEqual(['running-69']);
});

test('command mode never marks command rows as the current object when context has no target',async()=>{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{default:CommandPalette}=await import('../src/CommandPalette');
 const markup=renderToStaticMarkup(createElement(CommandPalette,{config:{version:2,projects:[],agents:[]},context:{},onNavigate:()=>{},onAction:()=>{},onClose:()=>{}}));
 expect(markup).toContain('role="option"');expect(markup).not.toContain('<em>');
});

test('palette names the unified execution relationship',()=>{expect(paletteCommands.find(command=>command.id==='task-link')?.label).toEqual(['设为执行对话','Set execution Chat']);});
