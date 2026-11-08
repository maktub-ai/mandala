import { realpathSync } from 'node:fs';
import { relative, isAbsolute, sep, posix } from 'node:path';
import type { Store } from './store';
import { DomainError } from '../shared/workspace-contracts';
import { isRemoteAbsolutePath } from '../shared/execution-machines';
export type DirectoryOwner={kind:'run'|'input'|'invocation';id:string;conversationId?:string;delegated?:boolean};
export type NativeDirectoryIdentity={invocationId:string;nativeSessionId:string;nativeTurnId:string};
const overlap=(a:string,b:string,remote:boolean)=>{const r=remote?posix.relative(a,b):relative(a,b);return !r||!(remote?posix.isAbsolute(r):isAbsolute(r))&&r!=='..'&&!r.startsWith('..'+(remote?'/':sep));};
export function createTaskResources(store:Store,hostForConversation?:(id:string)=>string|undefined){
 const db=store.database;
 db.exec(`CREATE TABLE IF NOT EXISTS task_directory_claims(kind TEXT NOT NULL,owner_id TEXT NOT NULL,conversation_id TEXT,paths TEXT NOT NULL,mode TEXT NOT NULL,submitted INTEGER NOT NULL DEFAULT 0,invocation_id TEXT,native_session_id TEXT,native_turn_id TEXT,PRIMARY KEY(kind,owner_id));`);
 if(!db.prepare('PRAGMA table_info(task_directory_claims)').all().some(r=>r.name==='delegated'))db.exec('ALTER TABLE task_directory_claims ADD COLUMN delegated INTEGER NOT NULL DEFAULT 0');
 if(!db.prepare('PRAGMA table_info(task_directory_claims)').all().some(r=>r.name==='host_id'))db.exec("ALTER TABLE task_directory_claims ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'");
 db.exec('CREATE TABLE IF NOT EXISTS task_directory_waits(kind TEXT NOT NULL,owner_id TEXT NOT NULL,PRIMARY KEY(kind,owner_id))');
 const atomic=<T>(fn:()=>T)=>db.isTransaction?fn():store.transaction(fn);
 const claim=(owner:DirectoryOwner,paths:string[],mode:'none'|'read'|'write'):'granted'|'queued'=>{
  if(!owner.id||!['none','read','write'].includes(mode))throw new DomainError('invalid_directory_claim',422,'invalid_directory_claim');
  const host=owner.conversationId?hostForConversation?.(owner.conversationId):undefined,hostId=host===undefined?'local':`ssh:${host}`;
  return atomic(()=>{
   const existing=db.prepare('SELECT * FROM task_directory_claims WHERE kind=? AND owner_id=?').get(owner.kind,owner.id);
   if(existing&&existing.host_id!==hostId)throw new DomainError('directory_claim_conflict',409,'directory_claim_conflict');
   const roots=mode==='none'?[]:[...new Set(paths.map(path=>{
    if(host===undefined)return realpathSync(path);
    if(!isRemoteAbsolutePath(path))throw new DomainError('invalid_directory_claim',422,'invalid_directory_claim');
    return posix.resolve(path);
   }))].sort();
   if(existing){if(existing.paths!==JSON.stringify(roots)||existing.mode!==mode)throw new DomainError('directory_claim_conflict',409,'directory_claim_conflict');return 'granted';}
   for(const row of db.prepare('SELECT kind,conversation_id,paths,mode,delegated FROM task_directory_claims WHERE host_id=?').all(hostId)){
    // User conversations run independently; delegated Runs retain exclusive directory scheduling.
    if(owner.kind!=='run'&&!owner.delegated&&row.kind!=='run'&&!row.delegated&&owner.conversationId&&row.conversation_id&&owner.conversationId!==row.conversation_id)continue;
    if(mode!=='write'&&row.mode!=='write')continue;
    const held=JSON.parse(row.paths as string) as string[];
    if(roots.some(path=>held.some(other=>overlap(path,other,host!==undefined)||overlap(other,path,host!==undefined)))){db.prepare('INSERT OR IGNORE INTO task_directory_waits VALUES (?,?)').run(owner.kind,owner.id);return 'queued';}
   }
   db.prepare('DELETE FROM task_directory_waits WHERE kind=? AND owner_id=?').run(owner.kind,owner.id);
   if(roots.length)db.prepare('INSERT INTO task_directory_claims(kind,owner_id,conversation_id,paths,mode,delegated,host_id) VALUES (?,?,?,?,?,?,?)').run(owner.kind,owner.id,owner.conversationId??null,JSON.stringify(roots),mode,Number(!!owner.delegated),hostId);
   return 'granted';
  });
 };
 return {
  claim,
  claimDirectory:(runId:string,path:string,mode:'none'|'read'|'write')=>claim({kind:'run',id:runId},[path],mode),
  submitted(kind:DirectoryOwner['kind'],id:string,invocationId:string,nativeSessionId:string){
   db.prepare('UPDATE task_directory_claims SET submitted=1,invocation_id=?,native_session_id=? WHERE kind=? AND owner_id=? AND submitted=0').run(invocationId,nativeSessionId,kind,id);
  },
  bindTurn(kind:DirectoryOwner['kind'],id:string,invocationId:string,nativeSessionId:string,nativeTurnId:string){
   db.prepare('UPDATE task_directory_claims SET native_turn_id=? WHERE kind=? AND owner_id=? AND invocation_id=? AND native_session_id=? AND (native_turn_id IS NULL OR native_turn_id=?)').run(nativeTurnId,kind,id,invocationId,nativeSessionId,nativeTurnId);
  },
  releaseUnsubmitted(kind:DirectoryOwner['kind'],id:string):boolean{return Number(db.prepare('DELETE FROM task_directory_claims WHERE kind=? AND owner_id=? AND submitted=0').run(kind,id).changes)>0;},
  confirmTerminal(kind:DirectoryOwner['kind'],id:string,identity:NativeDirectoryIdentity):boolean{
   return Number(db.prepare('DELETE FROM task_directory_claims WHERE kind=? AND owner_id=? AND submitted=1 AND invocation_id=? AND native_session_id=? AND native_turn_id=?').run(kind,id,identity.invocationId,identity.nativeSessionId,identity.nativeTurnId).changes)>0;
  },
 };
}
