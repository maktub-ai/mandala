import type {Automation,AutomationRun,Schedule} from '../shared/automations';
export function weekdayText(schedule:Extract<Schedule,{kind:'weekly'}>,english:boolean){
 const days=schedule.weekdays??[schedule.weekday!];
 if(days.length===5&&[1,2,3,4,5].every(day=>days.includes(day)))return english?'Weekdays':'工作日';
 const labels=english?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:['周日','周一','周二','周三','周四','周五','周六'];
 return days.map(day=>labels[day]).join(english?', ':'、');
}
export function executionModeText(rule:Pick<Automation,'executionMode'|'goalId'|'conversationId'>,english:boolean){
 if(rule.executionMode==='continuous')return english?'Continuous · same Task and Chat':'持续执行 · 沿用同一任务与会话';
 if(rule.executionMode==='independent')return english?'Independent · new Task and Chat each run':'独立执行 · 每次新建任务与会话';
 const task=rule.goalId?(english?'New child Task each run':'每次新建子任务'):(english?'Shared Task':'共用任务');
 return (english?'Legacy · ':'旧规则 · ')+task+(rule.conversationId?(english?' · bound Chat':' · 沿用绑定会话'):(english?' · fresh Chat each run':' · 每次新建会话'));
}
export function awaitingReview(run:AutomationRun){return run.taskState==='review';}
