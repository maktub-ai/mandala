import { realpathSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import type { Cli } from '../shared/types';
import type { Store } from './store';
import { isRemoteAbsolutePath } from '../shared/execution-machines';
export type ConversationApprovalScope = { conversationId:string; agentId:string; projectId:string; cli:Cli; cwd:string; hostId?:string };
export function createConversationApprovals(store:Store) {
 const db=store.database;
 db.exec(`CREATE TABLE IF NOT EXISTS conversation_tool_approvals (
  owner_user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL, cli TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id,conversation_id))`);
 if(!db.prepare('PRAGMA table_info(conversation_tool_approvals)').all().some(row=>row.name==='host_id'))db.exec("ALTER TABLE conversation_tool_approvals ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'");
 const values=(scope:ConversationApprovalScope)=>{
  let cwd:string;
  if(scope.hostId!==undefined){
   if(!isRemoteAbsolutePath(scope.cwd))throw new Error('invalid approval directory');
   cwd=posix.resolve(scope.cwd);
  }else{try{cwd=realpathSync(scope.cwd);}catch{cwd=resolve(scope.cwd);}}
  return [store.ownerUserId,scope.conversationId,scope.agentId,scope.projectId,scope.cli,cwd,scope.hostId===undefined?'local':`ssh:${scope.hostId}`];
 };
 return {
  has(scope:ConversationApprovalScope):boolean {
   return !!db.prepare('SELECT 1 FROM conversation_tool_approvals WHERE owner_user_id=? AND conversation_id=? AND agent_id=? AND project_id=? AND cli=? AND cwd=? AND host_id=?').get(...values(scope));
  },
  allow(scope:ConversationApprovalScope) {
   db.prepare(`INSERT INTO conversation_tool_approvals(owner_user_id,conversation_id,agent_id,project_id,cli,cwd,host_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,conversation_id)
    DO UPDATE SET agent_id=excluded.agent_id,project_id=excluded.project_id,cli=excluded.cli,cwd=excluded.cwd,host_id=excluded.host_id,created_at=excluded.created_at`).run(...values(scope),new Date().toISOString());
  },
  revoke(conversationId:string) {db.prepare('DELETE FROM conversation_tool_approvals WHERE owner_user_id=? AND conversation_id=?').run(store.ownerUserId,conversationId);},
 };
}
