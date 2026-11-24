const {DatabaseSync}=require('node:sqlite');
const {randomBytes}=require('node:crypto');
const {lstatSync,realpathSync}=require('node:fs');
const {isAbsolute,normalize,join}=require('node:path');
const {pathToFileURL}=require('node:url');

const applicationId=1296321621;
const schema="CREATE TABLE windows_handoff (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('clear','pending','started','unknown'))) STRICT";
const tokenPattern=/^[0-9a-f]{64}$/;
const invalid=()=>Error('Update journal unavailable.');
const idEqual=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const norm=realpathSync.native;

// Main-only alternative journal. Provisioning is deliberately not available
// here: the missing database could be a lost unresolved handoff, not first use.
function createSqliteHandoffJournal({home,isPrivateLocal}) {
  if(typeof home!=='string'||!isAbsolute(home)||normalize(home)!==home||
     typeof isPrivateLocal!=='function')return null;
  const path=join(home,'.mandala-windows-handoff.sqlite');
  const journal=path+'-journal';
  let rootIdentity, dbIdentity;
  function scope(){
    const root=lstatSync(home,{bigint:true});
    if(!root.isDirectory()||root.ino===0n||norm(home)!==home||
       (rootIdentity&&!idEqual(root,rootIdentity))||isPrivateLocal(home,[path,journal])!==true)throw invalid();
    rootIdentity=root;
    if (lstatSync(path+'-wal',{throwIfNoEntry:false})||lstatSync(path+'-shm',{throwIfNoEntry:false}))throw invalid();
    for(const candidate of [path,journal]){
      const st=lstatSync(candidate,{bigint:true,throwIfNoEntry:false});
      if(!st&&candidate===journal)continue;
      if(!st?.isFile()||st.nlink!==1n||st.ino===0n||norm(candidate)!==candidate)throw invalid();
      if(candidate===path){
        if(dbIdentity&&!idEqual(st,dbIdentity))throw invalid();
        dbIdentity=st;
      }
    }
  }
  function open(run,write=false){
    scope();
    // Pass the encoded URI string, not a filesystem path. SQLite mode=rw
    // guarantees an existing-only read/write open even if the file vanishes.
    const uri=pathToFileURL(path);
    uri.searchParams.set('mode','rw');
    const db=new DatabaseSync(uri.href,{allowExtension:false});
    try{
      scope();
      db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;');
      if(db.prepare('PRAGMA application_id').get().application_id!==applicationId||
         db.prepare('PRAGMA user_version').get().user_version!==1||
         db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')throw invalid();
      const entries=db.prepare('SELECT type,name,sql FROM sqlite_schema').all();
      if(entries.length!==1||entries[0].type!=='table'||entries[0].name!=='windows_handoff'||entries[0].sql!==schema)throw invalid();
      if(!write)return run(db);
      db.exec('PRAGMA synchronous=EXTRA;');
      if(db.prepare('PRAGMA synchronous').get().synchronous!==3)throw invalid();
      db.exec('BEGIN IMMEDIATE;');
      try{
        const value=run(db);
        scope();
        db.exec('COMMIT;');
        return value;
      }catch(e){if(db.isTransaction)db.exec('ROLLBACK;');throw e;}
    }finally{db.close();}
  }
  function state(db){
    const rows=db.prepare('SELECT id, owner, phase FROM windows_handoff LIMIT 2').all();
    const v=rows[0];
    if(rows.length!==1||v.id!==1||
       !(v.phase==='clear'?v.owner==='':['pending','started','unknown'].includes(v.phase)&&
         typeof v.owner==='string'&&tokenPattern.test(v.owner)))throw invalid();
    return v;
  }
  return Object.freeze({
    read(){
      try{return open(db=>{const s=state(db);return s.phase==='clear'?null:s.phase;});}
      catch{return 'unknown';}
    },
    tryBegin(){
      try{
        return open(db=>{
          if(state(db).phase!=='clear')return null;
          const owner=randomBytes(32).toString('hex');
          const rows=db.prepare("UPDATE windows_handoff SET phase='pending',owner=? WHERE id=1 AND phase='clear' AND owner=''").run(owner).changes;
          return rows===1?owner:null;
        },true);
      }catch{return null;}
    },
    settle(owner,phase){
      if(typeof owner!=='string'||!tokenPattern.test(owner)||![null,'unknown','started'].includes(phase))return false;
      try{
        return open(db=>{
          const current=state(db);
          if(current.phase!=='pending'||current.owner!==owner)return false;
          return db.prepare("UPDATE windows_handoff SET phase=?,owner=? WHERE id=1 AND phase='pending' AND owner=?")
            .run(phase??'clear',phase===null?'':owner,owner).changes===1;
        },true);
      }catch{return false;}
    }
  });
}

module.exports={createSqliteHandoffJournal};
