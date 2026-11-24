const {randomBytes}=require('node:crypto');
const {constants,openSync,closeSync,writeFileSync,readSync,fsyncSync,lstatSync,fstatSync,realpathSync,unlinkSync}=require('node:fs');
const {isAbsolute,normalize,join}=require('node:path');

const marker='.mandala-windows-handoff-v1';
const resolution='.mandala-windows-handoff-result-v1';
const tokenPattern=/^[0-9a-f]{64}$/;
const maxRecord=128;
const same=(actual,expected)=>actual.dev===expected.dev&&actual.ino===expected.ino;
const denied=()=>Error('Windows handoff journal unavailable.');

function privateUnix(stat) {
  return typeof process.getuid==='function' && stat.uid===process.getuid() && (stat.mode&0o077)===0;
}

// Only desktop main may construct this with its canonical, already protected
// home. The Windows backend must supply independently reviewed native ACL,
// non-reparse/local-volume identity and namespace-flush operations.
function createWindowsHandoffJournal({home,windows}) {
  if (typeof home!=='string'||!isAbsolute(home)||normalize(home)!==home) throw denied();
  const native=process.platform==='win32'?windows:null;
  const supported=process.platform!=='win32'||(
    typeof native?.isPrivateLocal==='function' && typeof native?.flushNamespace==='function'
  );
  if (!supported) return null;
  const privatePath=(path,st)=>native?native.isPrivateLocal(path,st)===true:privateUnix(st);
  let homeIdentity;
  const ownHome=()=>{
    const stat=lstatSync(home);
    if (!stat.isDirectory()||!privatePath(home,stat)||realpathSync.native(home)!==home||
        (homeIdentity&&!same(stat,homeIdentity))) throw denied();
    homeIdentity=stat;
  };
  const flushNamespace=()=>{
    ownHome();
    if (native) {
      if (native.flushNamespace(home)!==true) throw denied();
      return;
    }
    const fd=openSync(home,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { if(!same(fstatSync(fd),homeIdentity)) throw denied(); fsyncSync(fd); }
    finally {closeSync(fd);}
  };
  const pathFor=name=>join(home,name);
  const inspect=(name,kind)=>{
    const path=pathFor(name);
    const before=lstatSync(path,{throwIfNoEntry:false});
    if(!before)return null;
    if(!before.isFile()||before.nlink!==1||before.size>maxRecord||!privatePath(path,before)) throw denied();
    const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try {
      const opened=fstatSync(fd);
      if(!same(before,opened)||before.size!==opened.size) throw denied();
      const buffer=Buffer.alloc(maxRecord);
      const count=readSync(fd,buffer,0,maxRecord,0);
      const after=lstatSync(path);
      if(count!==before.size||!same(before,after)||before.size!==after.size||
          before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs) throw denied();
      const value=JSON.parse(buffer.subarray(0,count).toString('utf8'));
      if (typeof value?.owner!=='string'||!tokenPattern.test(value.owner)||!['pending','started','unknown'].includes(value.state)||
          (kind==='reservation')!==(value.state==='pending')||
          !buffer.subarray(0,count).equals(Buffer.from(record(value.owner,value.state)))) throw denied();
      return value;
    } finally {closeSync(fd);}
  };
  const record=(owner,state)=>JSON.stringify({owner,state})+'\n';
  const readPair=()=>{
    ownHome();
    const reservation=inspect(marker,'reservation'), result=inspect(resolution,'resolution');
    if (result&&result.owner!==reservation?.owner) throw denied();
    return {reservation,result};
  };
  const writeExclusive=(name,owner,state)=>{
    ownHome();
    const path=pathFor(name);
    const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    try {
      const original=fstatSync(fd);
      if(!same(original,lstatSync(path))||!privatePath(path,original)) throw denied();
      writeFileSync(fd,record(owner,state));
      fsyncSync(fd);
    } finally {closeSync(fd);}
    flushNamespace();
  };
  return Object.freeze({
    read(){
      try {const {reservation,result}=readPair();return result?.state??reservation?.state??null;}
      catch{return 'unknown';}
    },
    tryBegin(){
      try {
        if(readPair().reservation)return null;
        const owner=randomBytes(32).toString('hex');
        writeExclusive(marker,owner,'pending');
        return owner;
      } catch {return null;}
    },
    settle(owner,state){
      if (typeof owner!=='string'||!tokenPattern.test(owner)||![null,'unknown','started'].includes(state)) return false;
      try {
        const {reservation,result}=readPair();
        if (!reservation||reservation.owner!==owner||result)return false;
        if (state===null) {
          unlinkSync(pathFor(marker));
          flushNamespace();
        } else writeExclusive(resolution,owner,state);
        return true;
      } catch {return false;}
    }
  });
}

module.exports={createWindowsHandoffJournal};
