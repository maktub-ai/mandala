import React from 'react';
import {renderChineseMarkup} from './helpers/render-ui';
import {expect,it} from 'vitest';
import ExplicitProgressView from '../src/ExplicitProgressView';
const report={text:'检查中文进展',source:'cli' as const,runId:'r',sourceEventId:3,updatedAt:'2026-10-30T00:00:00Z',historical:true};
it('renders historical provenance and server time without inventing expandable steps',()=>{
 const html=renderChineseMarkup(React.createElement(ExplicitProgressView,{progress:report}));
 expect(html).toContain('检查中文进展');expect(html).toContain('历史进展');expect(html).toContain('2026-10-30T00:00:00Z');expect(html).not.toContain('<details');
});
it.each([false,true])('keeps compact output readable without a visible label (historical: %s)',historical=>{
 const label=historical?'历史输出':'最近输出';
 const html=renderChineseMarkup(React.createElement(ExplicitProgressView,{progress:{...report,source:'output',historical},compact:true,hideOutputLabel:true}));
 expect(html).toContain('检查中文进展');expect(html).toContain('2026-10-30T00:00:00Z');
 expect(html).toContain('aria-label="'+label+'"');expect(html).not.toContain('>'+label+'<');
});
it('exposes only explicitly reported steps with their statuses',()=>{
 const html=renderChineseMarkup(React.createElement(ExplicitProgressView,{progress:{...report,historical:false,steps:[{text:'检查运行',status:'running'},{text:'验证结果',status:'pending'}]}}));
 expect(html).toContain('<details');expect(html).toContain('检查运行');expect(html).toContain('验证结果');expect(html).toContain('执行中');expect(html).toContain('待处理');
});

import {TaskConversationProgress,latestTaskProgress} from '../src/TaskConversationProgress';
import type {ConversationProgress} from '../shared/conversation-progress';
const chat=(id:string,progress:typeof report|null,state:ConversationProgress['state']='running'):ConversationProgress=>({id,title:id,agentId:'',projectId:'',cli:'codex',executionStatus:state==='running'?'running':'idle',state,reopenState:state==='completed'?'recent':state,active:true,live:state==='running',withinWindow:true,activityAt:report.updatedAt,completedAt:null,requestPreview:null,hasNewActivity:false,taskIds:['t'],relatedConversationIds:[],latestProgress:progress});
it('chooses current explicit reports over later historical reports and labels their conversation',()=>{
 const rows=[chat('旧对话',{...report,updatedAt:'2026-10-30T10:00:00Z'}),chat('当前对话',{...report,historical:false})];
 expect(latestTaskProgress(rows)?.id).toBe('当前对话');
 const html=renderChineseMarkup(React.createElement(TaskConversationProgress,{rows}));
 expect(html).toContain('2 个运行对话');expect(html).toContain('当前对话');expect(html).toContain('旧对话');
});
it('shows status alone for a conversation without an explicit report',()=>{
 const html=renderChineseMarkup(React.createElement(TaskConversationProgress,{rows:[chat('无上报',null)]}));
 expect(html).toContain('执行中');expect(html).not.toContain('检查中文进展');expect(html).not.toContain('Reported steps');
});

import TurnProcess from '../src/TurnProcess';
import {groupChatTurns} from '../src/chatTurns';
import type {DisplayEvent} from '../shared/types';
it('shows only the active explicit report in the collapsed process preview',()=>{
 const events:DisplayEvent[]=[{id:1,kind:'user',conversationId:'c',data:{text:'Inspect',runId:'r'},createdAt:report.updatedAt},{id:2,kind:'status',conversationId:'c',data:{status:'running'},createdAt:report.updatedAt},{id:3,kind:'progress',conversationId:'c',data:{text:'检查中文进展',source:'cli',runId:'r'},createdAt:report.updatedAt}];
 const html=renderChineseMarkup(React.createElement(TurnProcess,{turn:groupChatTurns(events)[0],onInspect:()=>{}}));
 expect(html).toContain('检查中文进展');expect(html.match(/data-progress-event-id/g)).toHaveLength(1);
 const ended=renderChineseMarkup(React.createElement(TurnProcess,{turn:groupChatTurns([...events,{id:4,kind:'status',conversationId:'c',data:{status:'idle'},createdAt:report.updatedAt}])[0],onInspect:()=>{}}));
 expect(ended).not.toContain('检查中文进展');
});
it('keeps visible native commentary and command output separate from explicit progress',()=>{
 const events:DisplayEvent[]=[{id:1,kind:'user',conversationId:'c',data:{text:'Inspect'},createdAt:report.updatedAt},{id:2,kind:'status',conversationId:'c',data:{status:'running'},createdAt:report.updatedAt},{id:3,kind:'tool',conversationId:'c',data:{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Native commentary'}}},createdAt:report.updatedAt},{id:4,kind:'tool',conversationId:'c',data:{method:'item/started',params:{item:{id:'tool',type:'commandExecution',command:'inspect',aggregatedOutput:'Arbitrary tool output',status:'inProgress'}}},createdAt:report.updatedAt}];
 const html=renderChineseMarkup(React.createElement(TurnProcess,{turn:groupChatTurns(events)[0],onInspect:()=>{}}));
 expect(html).toContain('Native commentary');expect(html).not.toContain('class="operation-content"');expect(html).toContain('data-progress-source="commentary"');
});
it('keeps runtime errors visible while the process is collapsed',()=>{
 const events:DisplayEvent[]=[{id:1,kind:'user',conversationId:'c',data:{text:'Inspect'},createdAt:report.updatedAt},{id:2,kind:'error',conversationId:'c',data:{message:'Synthetic runtime failure'},createdAt:report.updatedAt},{id:3,kind:'status',conversationId:'c',data:{status:'error'},createdAt:report.updatedAt}];
 const html=renderChineseMarkup(React.createElement(TurnProcess,{turn:groupChatTurns(events)[0],onInspect:()=>{}}));
 expect(html).toContain('Synthetic runtime failure');expect(html.match(/role="alert"/g)).toHaveLength(1);
});
it('counts resumed execution independently of a retained completed presentation marker',()=>{
 const rows=[{...chat('已标完成但恢复执行',null,'completed'),executionStatus:'running' as const,live:true,reopenState:'running' as const,completedAt:report.updatedAt},{...chat('仅已完成',null,'completed'),live:false,reopenState:'recent' as const,completedAt:report.updatedAt}];
 const html=renderChineseMarkup(React.createElement(TaskConversationProgress,{rows}));
 expect(html).toContain('1 个运行对话');
});
it('selects the newest report by received event rather than an earlier tool anchor',()=>{
 const e=(id:number,kind:DisplayEvent['kind'],data:unknown):DisplayEvent=>({id,kind,data,conversationId:'c',createdAt:report.updatedAt});
 const tool=(id:string,receipt?:number)=>({method:receipt?'item/completed':'item/started',params:{item:{id,type:'commandExecution',status:receipt?'completed':'inProgress',...(receipt?{aggregatedOutput:JSON.stringify({kind:'progress',id:receipt})}:{})}}});
 const events=[e(1,'user',{text:'Inspect'}),e(2,'tool',tool('first')),e(3,'tool',tool('second')),e(4,'progress',{text:'Older report',source:'cli',runId:'r'}),e(5,'tool',tool('second',4)),e(6,'progress',{text:'Newest report',source:'cli',runId:'r'}),e(7,'tool',tool('first',6)),e(8,'status',{status:'running'})];
 const html=renderChineseMarkup(React.createElement(TurnProcess,{turn:groupChatTurns(events)[0],onInspect:()=>{}}));
 expect(html).toContain('Newest report');expect(html).not.toContain('Older report');
 expect(html).toMatch(/data-progress-event-id="6"/);expect(html.match(/data-progress-event-id/g)).toHaveLength(1);
});

it('does not count failed parents with live children or legacy display state as running; approval remains separate',()=>{
 const rows=[{...chat('失败且子任务运行',null),executionStatus:'error' as const,live:true,reopenState:'attention' as const},{...chat('等待审批',null),executionStatus:'approval' as const},{...chat('历史字段',null),executionStatus:undefined}];
 const html=renderChineseMarkup(React.createElement(TaskConversationProgress,{rows}));
 expect(html).not.toContain('个运行对话');expect(html).toContain('执行失败');expect(html).toContain('等待审批');expect(html).toContain('执行状态未知');
});
it('labels the actual executor, explicit Agentless runtime and unknown identities beside each conversation',()=>{
 const rows=[{...chat('具名对话',null),agentId:'executor'},{...chat('缺失配置',null),agentId:'removed'},{...chat('无 Agent 对话',null),agentId:''},{...chat('旧身份缺失',null),agentId:undefined} as unknown as ConversationProgress];
 const html=renderChineseMarkup(React.createElement(TaskConversationProgress,{rows,agents:[{id:'executor',name:'真实执行者'}]}));
 expect(html).toContain('具名对话 · 真实执行者 · 执行中');
 expect(html).toContain('缺失配置 · 执行者未知 · 执行中');
 expect(html).toContain('无 Agent 对话 · 无 Agent（Codex） · 执行中');
 expect(html).toContain('旧身份缺失 · 执行者未知 · 执行中');
});

it('presents native commentary and unphased output as distinct latest sources on Task summaries',()=>{
 for(const [source,label] of [['commentary','过程说明'],['output','最近输出']] as const){
  const rows=[{...chat('当前对话',null),latestProgress:{...report,source,historical:false,text:'Checking source'}}];
  const html=renderChineseMarkup(React.createElement(TaskConversationProgress,{rows}));
  expect(html).toContain(label);expect(html).toContain('Checking source');expect(html).toContain('data-progress-source="'+source+'"');expect(html).toContain('执行中');
 }
});
