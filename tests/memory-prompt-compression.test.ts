import { expect, test } from 'vitest';
import { buildMemoryPrompt } from '../server/memory-prompts';
import type { MemoryGeneratorInput } from '../server/memory-pipeline';
import type { MemoryProposal, MemoryRevision, MemorySource } from '../shared/memory';
const event=(id:number,kind:string,text:string)=>({id,kind,text,hash:'synthetic',createdAt:'2026-10-12T00:00:00Z'});
const source=(events:MemorySource['events']):MemorySource=>({id:'source',revision:1,collectionId:'collection',kind:'conversation',conversationId:'chat',taskId:null,taskRevision:null,runIds:[],versions:[],events,text:events.map(e=>e.text).join('\n'),observedAt:null,capturedAt:'2026-10-12T00:00:00Z',status:'ready',fingerprint:'synthetic',eventIds:events.map(e=>e.id),completionMarker:null});
const proposal=(text='Use pnpm.'):MemoryProposal=>({collectionId:'collection',layer:'L1',contentType:'constraint',text,operation:'store',replaces:[],evidence:[{sourceId:'source',sourceRevision:1}],support:[{sourceId:'source',eventId:1,quote:text}],dependencies:[],validUntil:null,certainty:'user_asserted'});
const revision=(id:string,text='Use pnpm.'):MemoryRevision=>({...proposal(text),recordId:id,revision:1,status:'active',dependencies:[],observedAt:null,effectiveFrom:'2026-10-12T00:00:00Z',extractedAt:'2026-10-12T00:00:00Z',verification:'evidence_extract',taskId:null,conversationId:'chat',contentHash:'synthetic'});
function input(sources:MemorySource[],extra:Partial<MemoryGeneratorInput>={}):MemoryGeneratorInput{return {job:{id:'job',collectionId:'collection',principal:{userId:'local'},sourceRefs:[],generation:1,state:'running',attempt:1,leaseToken:1,leaseUntil:null,workerId:'test',availableAt:'',createdAt:'',error:null,extractorVersion:'test'},stage:'extract',sources,records:[],signal:new AbortController().signal,...extra};}
const data=(prompt:string)=>JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
test('extraction serializes each event once without repeated source or context bodies',()=>{
 const text='Keep the release approval requirement.',assistant='Unverified assistant conclusion.',s=source([event(1,'user',text),event(2,'text',assistant)]);
 const d=data(buildMemoryPrompt(input([s],{context:{projectId:'p',requests:[text],assistantReplies:[assistant]}})));
 expect(d.sources[0].text).toBe('');expect(d.sources[0].events.map((e:any)=>e.text)).toEqual([text,assistant]);expect(d.context).toEqual({projectId:'p',requestRefs:[{sourceId:'source',eventId:1}],assistantReplyRefs:[{sourceId:'source',eventId:2}]});expect(s.text).toContain(text);
});
test('derived review retains every earlier user correction in full and excludes unverified assistant context',()=>{
 const early='Earlier release constraint: '+ 'approval '.repeat(350),events=[event(1,'user',early),...Array.from({length:6},(_,i)=>event(i+2,'user',`Correction ${i}: preserve workspace identity.`)),event(9,'text','ASSISTANT_UNVERIFIED_CONTEXT')],s=source(events),fact=revision('fact',events[1].text),draft={...proposal(),layer:'L2' as const,support:[],dependencies:[{recordId:'fact',revision:1}]};
 const prompt=buildMemoryPrompt(input([s],{stage:'verify',reviewStage:'scene',records:[fact],drafts:[draft],context:{projectId:'p',requests:[early],assistantReplies:['ASSISTANT_UNVERIFIED_CONTEXT']}})),d=data(prompt);
 expect(d.sources[0].events.map((e:any)=>e.text)).toEqual(events.filter(e=>e.kind==='user').map(e=>e.text));expect(prompt).not.toContain('ASSISTANT_UNVERIFIED_CONTEXT');expect(d.context.requests).toBeUndefined();
});
test('derived proof keeps complete selected exact quotes with identity but omits unrelated tool body',()=>{
 const quote='Full evidence '+ 'verbatim '.repeat(600),s=source([{...event(1,'tool',quote+'\nUNRELATED_TOOL_BODY'),origin:{cwd:'/synthetic',files:['/synthetic/source.ts']}}]),fact=revision('fact',quote),draft={...proposal(),layer:'L2' as const,support:[],dependencies:[{recordId:'fact',revision:1}]};
 const prompt=buildMemoryPrompt(input([s],{stage:'verify',reviewStage:'scene',records:[fact],drafts:[draft]})),d=data(prompt);
 expect(d.recordEvidence[0]).toMatchObject({recordId:'fact',support:[{sourceId:'source',eventId:1,quote}]});expect(prompt).not.toContain('UNRELATED_TOOL_BODY');
});
test('batch prompts carry stable identities and candidate scopes without repeating their records',()=>{
 const first=revision('candidate-1'),second=revision('candidate-2','Use npm.'),atom=proposal(),s=source([event(1,'user',atom.text)]);
 const batched={...input([s],{stage:'conflict',records:[first,second],atoms:[atom]}),batchItems:[{id:'atom-1',atom,records:[first]},{id:'atom-2',atom:proposal('Use npm.'),records:[second]}]} as MemoryGeneratorInput;
 const prompt=buildMemoryPrompt(batched),d=data(prompt);
 expect(d.atoms).toBeUndefined();expect(d.batchItems.map((i:any)=>({id:i.id,recordRefs:i.recordRefs}))).toEqual([{id:'atom-1',recordRefs:[{recordId:'candidate-1',revision:1}]},{id:'atom-2',recordRefs:[{recordId:'candidate-2',revision:1}]}]);expect(d.batchItems.every((i:any)=>i.records===undefined)).toBe(true);expect(prompt).toContain('batchItemId');expect(prompt).toContain('Do not borrow other items');
});
test('mixed reuse keeps audited source identities including empty-fact sources and forbids re-extraction',()=>{
 const s=source([event(1,'user','Use pnpm.')]),reusableSourceRefs=[{sourceId:'source',sourceRevision:1},{sourceId:'empty-fact-source',sourceRevision:2}],prompt=buildMemoryPrompt({...input([s]),reusableSourceRefs,reusableFacts:[revision('reusable')]} as MemoryGeneratorInput),d=data(prompt);
 expect(d.reusableSourceRefs).toEqual(reusableSourceRefs);expect(d.reusableFacts[0].recordId).toBe('reusable');expect(prompt).toContain('Do not re-extract');expect(prompt).toContain('all user events in this segment');
});
test('derived context preserves earlier constraints from a source outside the selected proof view',()=>{
 const s=source([event(1,'user','Current topic.')]),earlier='Earlier correction: retain the approval gate.',d=data(buildMemoryPrompt(input([s],{stage:'scene',context:{projectId:'p',requests:[earlier,'Current topic.'],assistantReplies:['Unverified claim.']}})));
 expect(d.context.requests).toContain(earlier);expect(JSON.stringify(d)).not.toContain('Unverified claim.');
});
test('batched review scopes each draft to its own verified dependency identities',()=>{
 const records=[revision('first'),revision('second')],draft=(id:string)=>({...proposal(),layer:'L2' as const,support:[],dependencies:[{recordId:id,revision:1}]}),drafts=[draft('first'),draft('second')],batchItems=drafts.map((draft,index)=>({id:`draft-${index}`,draft,records}));
 const d=data(buildMemoryPrompt({...input([source([event(1,'user','Use pnpm.')])],{stage:'verify',reviewStage:'scene',records,drafts}),batchItems} as MemoryGeneratorInput));
 expect(d.drafts).toBeUndefined();expect(d.batchItems.map((item:any)=>item.recordRefs)).toEqual([[{recordId:'first',revision:1}],[{recordId:'second',revision:1}]]);
});
test('preference audit retains original authority and exact quote for its selected user support',()=>{
 const quote='以后所有解释使用中文，并保留运行环境限定。',s=source([{...event(1,'user',quote),contextOnly:false},event(2,'user','Earlier background correction.'),{...event(3,'user','Context-only recalled material.'),contextOnly:true}]),draft={...proposal(quote),layer:'L3' as const,contentType:'preference' as const,scope:'user' as const};
 const d=data(buildMemoryPrompt(input([s],{stage:'verify',reviewStage:'profile',drafts:[draft]})));
 expect(d.sources[0].events[0]).toMatchObject({id:1,kind:'user',text:quote,contextOnly:false});expect(d.drafts[0].support[0]).toEqual({sourceId:'source',eventId:1,quote});expect(d.sources[0].events[1].contextOnly).toBe(true);expect(d.sources[0].events[2].contextOnly).toBe(true);
});
test.each(['extract','verify'] as const)('%s states the same exact user-scope eligibility gates as the authority engine',stage=>{
 const text='这个项目的阅读界面以后使用浅色主题。',s=source([event(1,'user',text)]),draft={...proposal(text),contentType:'preference' as const,scope:'user' as const},prompt=buildMemoryPrompt(input([s],{stage,...stage==='verify'?{reviewStage:'extract' as const,drafts:[draft]}:{}}));
 for(const gate of ['偏好|喜欢|以后|始终|prefer|always','本项目|这个项目|此项目|本任务|这个任务|此任务','所有项目|全部项目|跨项目','complete event.text','contentType=preference','Use scope:collection for project-local preferences'])expect(prompt).toContain(gate);
 expect(data(prompt).sources[0].events[0]).toMatchObject({id:1,text});
});
test('user-scope gates are shared once per prompt and apply to full event beyond a shortened support quote',()=>{
 const text='For this project, I always prefer light backgrounds.',quote='I always prefer light backgrounds.',s=source([event(1,'user',text)]),draft={...proposal(quote),contentType:'preference' as const,scope:'user' as const},prompt=buildMemoryPrompt(input([s],{stage:'verify',reviewStage:'extract',drafts:[draft]})),d=data(prompt);
 expect(prompt.match(/偏好\|喜欢\|以后\|始终\|prefer\|always/g)).toHaveLength(1);expect(prompt).toContain('all projects|across projects|all agents|in general|general');expect(prompt).toContain('do not modify quote or scope to bypass');expect(d.sources[0].events[0].text).toBe(text);expect(d.drafts[0].support[0].quote).toBe(quote);
});
test('verify exposes exact candidate bindings without duplicating the held draft',()=>{
 const draft={...proposal('Keep exact source evidence.'),layer:'L2' as const,support:[]},s=source([event(1,'user',draft.text)]);
 const prompt=buildMemoryPrompt(input([s],{stage:'verify',reviewStage:'scene',drafts:[draft]})),body=data(prompt);
 expect(body.drafts).toEqual([draft]);expect(body.reviewCandidates).toEqual([{id:'job:scene:0',digest:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
 expect(prompt.match(/Keep exact source evidence\./g)).toHaveLength(2); // source event and one held draft
 expect(prompt).toContain('accept');expect(prompt).toContain('revise');expect(prompt).toContain('reject');
});
test('derived prompts do not offer extraction-only empty success exits',()=>{
 const s=source([event(1,'user','New scene fact.')]);
 for(const stage of ['scene','profile','consolidate'] as const){const prompt=buildMemoryPrompt(input([s],{stage}));expect(prompt).not.toContain('When there are no relevant new facts, return proposals=[]');expect(prompt).not.toContain('return [] if there is no reusable information');}
 expect(buildMemoryPrompt(input([s],{stage:'extract'}))).toContain('When there are no relevant new facts, return proposals=[]');
});
test.each(['extract','scene'] as const)('request %s review packet permits only top-level decisions',reviewStage=>{
 const draft=proposal(),prompt=buildMemoryPrompt(input([source([event(1,'user',draft.text)])],{stage:'verify',reviewStage,drafts:[draft]}));
 const opening=prompt.split('Scope eligibility must match server validation')[0];
 expect(opening).toContain('only decisions is allowed at the top level');expect(opening).toContain('do not return top-level summary or other fields');
 expect(opening).not.toContain('summary?:');expect(opening).not.toContain('conversation extract still requires');
 expect(prompt).toContain('META.summary');
});
test('session extract review packet requires an independently checked summary',()=>{
 const draft=proposal(),base=input([source([event(1,'user',draft.text)])],{stage:'verify',reviewStage:'extract',drafts:[draft],draftSummary:'Draft summary.'});
 const prompt=buildMemoryPrompt({...base,job:{...base.job,kind:'session'}}),opening=prompt.split('Scope eligibility must match server validation')[0];
 expect(opening).toContain('summary is required');expect(opening).toContain('independently review draftSummary');
 expect(opening).not.toContain('summary?:');expect(data(prompt).draftSummary).toBe('Draft summary.');
});

test.each(['extract','conflict','scene','profile','consolidate','verify'] as const)('language policy survives %s generation and review',stage=>{
 const s=source([event(1,'user','Please use English for memory summaries. Keep /workspace/Mandala.ts intact.')]);
 const prompt=buildMemoryPrompt(input([s],{stage,reviewStage:'extract',drafts:[proposal()]}));
 expect(prompt).toContain('source conversation\'s dominant language');expect(prompt).toContain('an explicitly requested output language takes priority');
 expect(prompt).toContain('proper nouns, code, file paths');
});

for(const language of ['zh-CN','en'] as const)test.each(['extract','conflict','scene','profile','consolidate','verify'] as const)(`${language} preference controls %s output while evidence stays verbatim`,stage=>{
 const quote='Keep /workspace/Mandala.ts 原文 unchanged.',s=source([event(1,'user',quote)]);
 const prompt=buildMemoryPrompt(input([s],{language,stage,reviewStage:'extract',drafts:[proposal(quote)]}));
 expect(prompt).toContain(language==='en'?'Output language: English':'Output language: Simplified Chinese');
 expect(prompt).not.toContain('保留用户语言。');
 expect(s.events[0].text).toBe(quote);
 if(['extract','profile','verify'].includes(stage))expect(data(prompt).sources[0].events[0].text).toBe(quote);
});

test.each(['extract','conflict','scene','profile','consolidate','verify'] as const)('%s uses English instructions while keeping Chinese source data verbatim',stage=>{
 const quote='以后本项目使用 pnpm，路径 /workspace/项目.ts 保持原样。',s=source([event(1,'user',quote)]);
 const prompt=buildMemoryPrompt(input([s],{stage,reviewStage:'extract',drafts:[proposal(quote)]}));
 const start=prompt.indexOf('SOURCE_JSON:\n'),end=prompt.lastIndexOf('\nEND_SOURCE_JSON');
 const instructions=(prompt.slice(0,start)+prompt.slice(end)).replace(/\/\([^\n]*?\)\/i/g,'');
 expect(instructions).not.toMatch(/\p{Script=Han}/u);
 if(['extract','profile','verify'].includes(stage))expect(data(prompt).sources[0].events[0].text).toBe(quote);
 expect(s.events[0].text).toBe(quote);
});
