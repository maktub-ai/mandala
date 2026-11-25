import {createElement} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import TaskWorkCard from '../src/TaskWorkCard';
import type {Task,TaskExecution} from '../shared/tasks';
import {renderChineseMarkup} from './helpers/render-ui';
afterEach(()=>vi.unstubAllGlobals());
it.each([false,true])('shows direct execution chats without progress data in selection mode %s',selectionOnly=>{
 vi.stubGlobal('location',{pathname:'/'});
 const execution={id:'execution',conversationId:'chat',agentId:'agent',projectId:null,title:'Billing collection check',latestRun:{state:'succeeded'},createdAt:'2026-11-04T00:00:00Z'} as TaskExecution;
 const task={id:'task',goal:'Check collection',state:'completed',assigneeAgentId:null,executions:[execution]} as Task;
 const html=renderChineseMarkup(createElement(TaskWorkCard,{task,tasks:[task],config:{version:2,agents:[],projects:[]},href:'/tasks/task',selectionOnly}));
 expect(html).toContain('Billing collection check');expect(html).toContain('href="/?conversation=chat"');expect(html).toContain('已回报');expect(html).toContain('href="/tasks/task"');expect(html).not.toContain('子任务');
});

it.each([false,true])('navigates to every attributed project, including in selection mode %s',selectionOnly=>{
 vi.stubGlobal('location',{pathname:'/'});
 const projects=['route','p','q'].map(id=>({id,name:id+' project',cwd:'',agentIds:[],skills:[],resources:[],mcp:[]}));
 const config={version:2 as const,agents:[],projects};
 const base={id:'t',goal:'Delivery',state:'running',assigneeAgentId:null,executions:[],projectId:'route'} as unknown as Task;
 for(const [ids,expected] of [[['p','q'],['p','q']],[[],[]],[undefined,['route']]] as const){
  const task={...base,...(ids?{projectIds:[...ids]}:{})},html=renderChineseMarkup(createElement(TaskWorkCard,{task,tasks:[task],config,href:'/tasks/t',selectionOnly}));
  for(const p of projects)expect(html.includes('href="/projects/'+p.id+'/overview"')).toBe(expected.some(id=>id===p.id));
 }
});
