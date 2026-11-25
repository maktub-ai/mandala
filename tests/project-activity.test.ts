import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import ProjectActivity from '../src/ProjectActivity';

it('keeps the five latest task links visible and the sixth available in a closed disclosure',()=>{
 const tasks=Array.from({length:6},(_,index)=>({
  id:'task-'+index,goal:'Work '+index,createdAt:'2026-11-01',activityAt:'2026-11-0'+(index+1),
  assigneeAgentId:null,participantAgentIds:[],executions:[]
 }));
 const html=renderToStaticMarkup(createElement(ProjectActivity,{
  id:'app',agents:[],tasks,chats:[],tasksError:false,chatsError:false,disabled:false,onNavigate:()=>{}
 }));
 const disclosure=html.match(/<details([^>]*)>(.*?)<\/details>/s);
 expect(disclosure).not.toBeNull();
 expect(disclosure![1]).not.toMatch(/\bopen\b/);
 expect(disclosure![2]).toContain('More tasks (1)');
 expect(disclosure![2]).toContain('/tasks/task-0?project=app');
 const preview=html.slice(0,disclosure!.index);
 expect(preview).not.toContain('/tasks/task-0?');
 expect(preview.match(/href="\/tasks\/task-/g)).toHaveLength(5);
 expect(preview).toContain('/tasks?project=app&amp;type=tasks&amp;scope=all&amp;state=all');
});
