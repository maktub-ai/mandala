import type {Task} from '../shared/tasks';
import {useLanguage} from './i18n';
import './task-progress-meter.css';

/** Discrete task states, not an inferred percentage or goal acceptance. */
export default function TaskProgressMeter({tasks}:{tasks:readonly Task[]}){
 const {text:t}=useLanguage(),completed=tasks.filter(task=>task.state==='completed').length;
 if(!tasks.length)return null;
 const label=t(`${completed}/${tasks.length} 个执行任务已完成`,`${completed}/${tasks.length} execution tasks completed`);
 return <span className="task-progress-meter" aria-label={label} title={label}>{tasks.slice(0,8).map(task=><i key={task.id} data-state={task.state} aria-hidden="true"/>)}<span>{completed}/{tasks.length}</span>{tasks.length>8&&<small>+{tasks.length-8}</small>}</span>;
}
