import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import TurnProcess from '../src/TurnProcess';
import ApprovalRequest from '../src/ApprovalRequest';
import {groupChatTurns} from '../src/chatTurns';
import type {DisplayEvent} from '../shared/types';
import {LanguageProvider} from '../src/i18n';

beforeEach(()=>vi.stubGlobal('localStorage',{getItem:()=> 'zh-CN'}));
afterEach(()=>vi.unstubAllGlobals());
const renderMarkup=(component:React.ReactNode)=>renderToStaticMarkup(React.createElement(LanguageProvider,null,component));

const event=(id:number,kind:DisplayEvent['kind'],data:unknown):DisplayEvent=>({id,kind,data,conversationId:'c',createdAt:'2026-10-30T08:00:00Z'});
const render=(events:DisplayEvent[])=>renderMarkup(React.createElement(TurnProcess,{turn:groupChatTurns([event(1,'user',{text:'Inspect'}),...events])[0],onInspect:()=>{}}));
it('defaults to a folded process with only the latest public explanation',()=>{
 const html=render([event(2,'status',{status:'running'}),event(3,'progress',{text:'Explicit progress',source:'cli',runId:'r'}),event(4,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Native commentary'}}})]);
 expect(html).toContain('Native commentary');expect(html).not.toContain('Explicit progress');expect(html).not.toContain('>过程说明<');
 expect(html).toContain('aria-expanded="false"');
});
it('keeps completed adjacent reads behind the process disclosure',()=>{
 const html=render([event(2,'status',{status:'running'}),...[3,4].map(id=>event(id,'tool',{method:'item/completed',params:{item:{id:String(id),type:'mcpToolCall',server:'OMP',tool:'read',arguments:{path:'docs/'+id+'.md'},status:'completed',result:'Large body '+id}}}))]);
 expect(html).not.toContain('读取 2 个文件');expect(html).not.toContain('Large body');expect(html).not.toContain('OMP / read');
});
it.each(['running','idle'])('folds failed commands with successful commands while the turn is %s',status=>{
 const html=render([event(2,'tool',{method:'item/completed',params:{item:{id:'success',type:'commandExecution',command:'inspect-success',status:'completed',exitCode:0}}}),event(3,'tool',{method:'item/completed',params:{item:{id:'failure',type:'commandExecution',command:'inspect-failure',status:'failed',exitCode:127,aggregatedOutput:'Command exited with code 127'}}}),event(4,'status',{status})]);
 expect(html).toContain('2 次操作');expect(html).toContain('aria-expanded="false"');expect(html).not.toContain('operation-card');expect(html).not.toContain('Command exited with code 127');
});
it('keeps received partial output discoverable after stop instead of hiding all incomplete activity',()=>{
 const html=render([event(2,'tool',{method:'item/started',params:{item:{id:'command',type:'commandExecution',command:'inspect',aggregatedOutput:'Reading 1/3',status:'inProgress'}}}),event(3,'status',{status:'interrupted'})]);
 expect(html).toContain('执行命令');expect(html).toContain('已中断');expect(html).not.toContain('class="operation-content"');expect(html).toContain('aria-expanded="false"');
});
it('folds successful history without mounting tool output and keeps the final answer outside the process',()=>{
 const html=render([event(2,'tool',{method:'item/completed',params:{item:{id:'command',type:'commandExecution',command:'inspect',aggregatedOutput:'Huge log',status:'completed'}}}),event(3,'text',{text:'Final answer'}),event(4,'status',{status:'idle'})]);
 expect(html).toContain('aria-expanded="false"');expect(html).not.toContain('Huge log');expect(html).not.toContain('Final answer');
});
it('does not present an unresolved historical request as a currently actionable approval without live confirmation',()=>{
 const html=render([event(2,'approval',{id:'old',nativeRequestId:9,conversationId:'c',method:'omp/confirm',params:{message:'Old request'}})]);
 expect(html).toContain('aria-expanded="false"');expect(html).not.toContain('等待审批');
});
it('labels a known project search without claiming it searched the web',()=>{
 const html=render([event(2,'status',{status:'running'}),event(3,'tool',{method:'item/completed',params:{item:{id:'search',type:'mcpToolCall',server:'OMP',tool:'grep',arguments:{pattern:'encoding'},status:'completed'}}})]);
 expect(html).not.toContain('encoding');expect(html).not.toContain('网页搜索');
});
it('preserves the explicit conversation authorization scope offered by the current policy',()=>{
 const html=renderMarkup(React.createElement(ApprovalRequest,{approval:{id:'a',nativeRequestId:9,conversationId:'c',conversationApproval:true,method:'item/commandExecution/requestApproval',params:{command:'inspect',availableDecisions:['accept','decline']}},events:[],pending:false,onDecision:()=>{},onAnswer:()=>{}}));
 expect(html).toContain('授权本对话后续工具');expect(html).toContain('范围不限于当前命令');
});

it('shows a single ACP decision heading while retaining native operation context and choices',()=>{
 const html=renderMarkup(React.createElement(ApprovalRequest,{approval:{id:'acp',nativeRequestId:9,conversationId:'c',method:'acp/permission',params:{title:'Inspect export',message:'Confirm source access',toolCall:{rawInput:{path:'src/export.ts'}},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'always'}]}},events:[],pending:false,onDecision:()=>{},onAnswer:()=>{}}));
 expect(html.match(/需要你的审批/g)).toHaveLength(2); // Accessible section name and one visible heading.
 expect(html).toContain('Inspect export');expect(html).toContain('Confirm source access');expect(html).toContain('src/export.ts');expect(html).toContain('始终允许（原生范围）');
});

it('keeps unphased active text in the process without a heavy label or exposing it as a final answer',()=>{
 const html=render([event(2,'status',{status:'running'}),event(3,'text',{itemId:'reply',text:'Checking the sample'})]);
 expect(html).toContain('Checking the sample');expect(html).toContain('data-progress-source="output"');expect(html).not.toContain('>最近输出<');
});

it.each(['inProgress','failed','interrupted','blocked'])('does not mount %s tool input or output until inspected',status=>{
 const html=render([event(2,'status',{status:'running'}),event(3,'tool',{method:'item/started',params:{item:{id:'call',type:'mcpToolCall',server:'OMP',tool:'bash',arguments:{command:'inspect-private-argument'},result:'Verbose private tool output\nLatest summary',status}}})]);
 expect(html).toContain('aria-expanded="false"');expect(html).not.toContain('operation-content');expect(html).not.toContain('Verbose private tool output');expect(html).not.toContain('<details class="operation-card" open');
});
