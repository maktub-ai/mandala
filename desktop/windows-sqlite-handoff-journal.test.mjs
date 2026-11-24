import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const adapter=fileURLToPath(new URL('./windows-sqlite-handoff-journal.cjs',import.meta.url));
const code="const {createSqliteHandoffJournal}=require(process.argv[1]);"+
  "const {DatabaseSync}=require('node:sqlite');const {join}=require('node:path');const h=process.argv[2];"+
  // This equality is only a no-escape guarantee in a newly created test directory.
  // It does not represent proof of Windows ACL or volume ownership.
  "const approve=(home,paths)=>home===h&&paths.every(p=>require('node:path').dirname(p)===h);"+
  "const j=createSqliteHandoffJournal({home:h,isPrivateLocal:approve});";
const invoke=(home,script,...args)=>spawnSync(process.execPath,['-e',code+script,adapter,home,...args],{encoding:'utf8',timeout:5000,windowsHide:true});
const scratch=()=>realpathSync.native(mkdtempSync(join(tmpdir(),'mandala-sqlite-handoff-')));
const clean=home=>{assert.equal(dirname(home),realpathSync.native(tmpdir())); assert.match(basename(home),/^mandala-sqlite-handoff-[0-9A-Za-z]+$/); rmSync(home,{recursive:true,force:true});};
const boot="const d=new DatabaseSync(join(h,'.mandala-windows-handoff.sqlite'));"+
  "d.exec(\"PRAGMA application_id=1296321621; PRAGMA user_version=1; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; CREATE TABLE windows_handoff (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('clear','pending','started','unknown'))) STRICT; INSERT INTO windows_handoff VALUES(1,'','clear');\");d.close();";
const safe=(result)=>assert.equal(result.status,0,result.stderr);

test('Windows stock VFS commits pending to a private fixture, survives writer exit, and denies duplicate or foreign settlement',()=>{
  const home=scratch();
  try {
    safe(invoke(home,boot));
    assert.equal(invoke(home,"if(!j.tryBegin())process.exit(19);process.exit(71);").status,71);
    safe(invoke(home,"if(j.read()!=='pending'||j.tryBegin()!==null||j.settle('a'.repeat(64),null)!==false)process.exit(19);"));
  } finally {clean(home);}
});

test('known no-start can clear; an uncertain or started outcome never reopens the install gate',()=>{
  for(const terminal of ['unknown','started']){
    const home=scratch();
    try{
      safe(invoke(home,boot));
      safe(invoke(home,"const t=j.tryBegin();if(!t||!j.settle(t,null)||j.read()!==null)process.exit(19);"));
      safe(invoke(home,"const t=j.tryBegin();if(!t||!j.settle(t,process.argv[3])||j.settle(t,null))process.exit(19);",terminal));
      safe(invoke(home,"if(j.read()!==process.argv[3]||j.tryBegin()!==null)process.exit(19);",terminal));
    }finally{clean(home);}
  }
});

test('exclusive cross-process reservation cannot clear or replace an in-progress owner',async()=>{
  const home=scratch();
  try {
    safe(invoke(home,boot));
    const holder=spawn(process.execPath,['-e',code+
      "const d=new DatabaseSync(join(h,'.mandala-windows-handoff.sqlite'));"+
      "d.exec('BEGIN IMMEDIATE');process.send('locked');process.once('message',()=>{d.exec('ROLLBACK');d.close();process.disconnect();});",
      adapter,home],{windowsHide:true,stdio:['ignore','ignore','inherit','ipc']});
    const finished=new Promise((resolve,reject)=>{holder.once('exit',resolve);holder.once('error',reject);});
    try{
      await new Promise((resolve,reject)=>{holder.once('message',resolve);holder.once('exit',()=>reject(Error('fixture exited early')));});
      safe(invoke(home,"if(j.tryBegin()!==null)process.exit(19);"));
    }finally{if(holder.connected)holder.send('done');else holder.kill();await finished;}
    safe(invoke(home,"if(j.read()!==null||!j.tryBegin())process.exit(19);"));
  } finally{clean(home);}
});

test('missing, corrupt, and logically malformed checkpoints fail closed without recreating a database',()=>{
  const home=scratch();
  const db=join(home,'.mandala-windows-handoff.sqlite');
  try {
    safe(invoke(home,"if(j.read()!=='unknown'||j.tryBegin()!==null)process.exit(19);"));
    assert.ok(!existsSync(db));
    writeFileSync(db,'deliberately malformed local fixture');
    safe(invoke(home,"if(j.read()!=='unknown'||j.tryBegin()!==null)process.exit(19);"));
    rmSync(db);
    safe(invoke(home,boot+"const r=new DatabaseSync(join(h,'.mandala-windows-handoff.sqlite'));r.exec(\"UPDATE windows_handoff SET owner='not-valid',phase='pending'\");r.close();"));
    safe(invoke(home,"if(j.read()!=='unknown'||j.tryBegin()!==null)process.exit(19);"));
  } finally{clean(home);}
});
