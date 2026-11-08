import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {createTaskScheduler} from '../server/task-scheduler';
import {createSessionManager} from '../server/sessions';
import {readConfig,writeConfig} from '../server/config';
import {isHumanInput} from '../shared/tasks';
const clean:(()=>void)[]=[];
afterEach(()=>clean.splice(0).forEach(fn=>fn()));
it('backs up WAL coherently before replacing task schema, preserves chats/assets/memory and ordinary queued input',async()=>{
 const home=mkdtempSync(join(tmpdir(),'task-schema-upgrade-')),store=openStore(home),db=store.database,p={userId:store.ownerUserId};clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const tasks=createTasks(store),chat=store.createConversation({agentId:'a',projectId:'',cli:'codex',model:null}),task=createTaskWithExecutions(store,tasks,p,{goal:'Old task',originConversationId:chat.id},[chat.id],'old');
 const queue=createTaskScheduler(store,tasks,{principal:p});queue.enqueueUserInput(chat.id,'Keep this ordinary chat message','ordinary');
 store.appendEvent(chat.id,'user',{text:'Keep the history',taskId:task.id,runId:'old-run'});
 const report=store.appendEvent(chat.id,'user',{text:'Old execution report',source:{kind:'coordination',receiptIds:['old-receipt']}});
 const dispatch=store.appendEvent(chat.id,'user',{text:'Old dispatch',task:{id:task.id,kind:'dispatch'}});
 const ordinary=store.appendEvent(chat.id,'user',{text:'Ordinary history',runId:'ordinary-invocation'});
 store.appendEvent(chat.id,'metadata',{coordinationTaskId:task.id,sourceUserEventId:ordinary.id});
 db.exec("CREATE TABLE retained_memory(id TEXT PRIMARY KEY,value TEXT); INSERT INTO retained_memory VALUES ('memory','remembered'); CREATE TABLE retained_assets(id TEXT PRIMARY KEY,value TEXT); INSERT INTO retained_assets VALUES ('asset','retained'); CREATE TABLE automation_rules(id TEXT PRIMARY KEY,revision INTEGER,archived INTEGER,data TEXT); CREATE TABLE automation_occurrences(id TEXT PRIMARY KEY,task_id TEXT REFERENCES work_tasks(id),data TEXT)");
 db.prepare('INSERT INTO automation_rules VALUES (?,1,0,?)').run('rule',JSON.stringify({taskId:task.id,executionTaskId:task.id,goalId:task.id,goal:'Keep the schedule goal'}));
 db.prepare('INSERT INTO automation_occurrences VALUES (?,?,?)').run('occurrence',task.id,JSON.stringify({taskId:task.id,goalId:task.id,runId:'old-run'}));
 // Reproduce the structural signature of the pre-cutover database.
 db.exec('ALTER TABLE work_tasks RENAME COLUMN origin_conversation_id TO parent_task_id');
 const migrated=createTasks(store);expect(migrated.listTasks(p)).toEqual([]);expect(store.getConversation(chat.id)?.id).toBe(chat.id);expect(store.listEvents(chat.id,0)[0].data).toEqual({text:'Keep the history'});
 expect(db.prepare('SELECT text FROM task_user_inputs').get()?.text).toBe('Keep this ordinary chat message');expect(db.prepare('SELECT value FROM retained_memory').get()?.value).toBe('remembered');expect(db.prepare('SELECT value FROM retained_assets').get()?.value).toBe('retained');
 expect(JSON.parse(db.prepare('SELECT data FROM automation_rules').get()!.data as string)).toEqual({goal:'Keep the schedule goal'});expect(db.prepare('SELECT task_id FROM automation_occurrences').get()?.task_id).toBeNull();expect(JSON.parse(db.prepare('SELECT data FROM automation_occurrences').get()!.data as string)).toEqual({});
 const backups=readdirSync(join(home,'backups'));expect(backups).toHaveLength(1);const snapshot=new DatabaseSync(join(home,'backups',backups[0]));try{expect(snapshot.prepare('SELECT goal FROM work_tasks').get()?.goal).toBe('Old task');expect(snapshot.prepare('SELECT text FROM task_user_inputs').get()?.text).toBe('Keep this ordinary chat message');expect(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');}finally{snapshot.close();}
 expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 const events=store.listEvents(chat.id,0);
 for(const eventId of [report.id,dispatch.id]){const data=events.find(event=>event.id===eventId)!.data as any;expect(data.source).toEqual({kind:'coordination',receiptIds:[]});expect(isHumanInput(data)).toBe(false);}
 expect(events.find(event=>event.id===ordinary.id)?.data).toMatchObject({runId:'ordinary-invocation'});
 const initial=await readConfig(home);await writeConfig(home,{...initial.config,system:{cli:'codex',memoryCapture:false},agents:[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]},initial.revision);
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'session',resumeThread:async()=>{},startTurn:async()=> 'turn',interrupt:async()=>{},replyApproval(){},close(){}}),undefined,home);
 try{expect(()=>manager.authorizeConversationRead(chat.id)).not.toThrow();await expect(manager.send(chat.id,'Continue after task migration')).resolves.toBeUndefined();}finally{await manager.close();}
 createTasks(store);expect(readdirSync(join(home,'backups'))).toEqual(backups);
});

it('leaves the old database intact when a backup cannot be created',()=>{
 const home=mkdtempSync(join(tmpdir(),'task-schema-backup-failure-')),store=openStore(home),p={userId:store.ownerUserId};clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const task=createTasks(store).createTask(p,{goal:'Do not lose this'},'old');
 store.database.exec('ALTER TABLE work_tasks RENAME COLUMN origin_conversation_id TO parent_task_id');writeFileSync(join(home,'backups'),'occupied');
 expect(()=>createTasks(store)).toThrow();expect(store.database.prepare('SELECT goal FROM work_tasks WHERE id=?').get(task.id)?.goal).toBe('Do not lose this');expect(store.database.prepare('PRAGMA table_info(work_tasks)').all().some(row=>row.name==='parent_task_id')).toBe(true);
});
