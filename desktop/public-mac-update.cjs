const {createHash, createPublicKey, verify: verifySignature} = require('node:crypto');
const {execFile} = require('node:child_process');
const {lstatSync, readFileSync, constants} = require('node:fs');
const {access, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile} = require('node:fs/promises');
const {basename, dirname, join} = require('node:path');
const {promisify} = require('node:util');

const run = promisify(execFile);
const REPO = 'https://github.com/maktub-ai/mandala-releases';
const BUNDLE = 'com.maktubcn.mandala';
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const TEAM = /^[A-Z0-9]{10}$/;
const MAX_ARCHIVE = 2 * 1024 ** 3;
const limit = message => { throw Error(message); };
class PublicUpdateVerificationError extends Error {
  constructor(){super('Could not verify the signed update. Try again later.');this.name='PublicUpdateVerificationError';}
}
const versionParts = value => typeof value === 'string' && VERSION.test(value) ? value.split('.').map(Number) : null;
function newer(value, current) {
  const a=versionParts(value),b=versionParts(current);
  if (!a || !b) return false;
  for (let i=0;i<a.length;i++) if (a[i]!==b[i]) return a[i]>b[i];
  return false;
}
function parseTrust(value) {
  if (!value || Object.keys(value).length!==3 || value.schema!==1 || typeof value.teamId!=='string' || !TEAM.test(value.teamId) ||
      typeof value.publicKey!=='string' || !/^[A-Za-z0-9+/]{59}=$/.test(value.publicKey)) return null;
  const bytes=Buffer.from(value.publicKey,'base64');
  if (bytes.toString('base64')!==value.publicKey) return null;
  try {
    const key=createPublicKey({key:bytes,format:'der',type:'spki'});
    return key.asymmetricKeyType==='ed25519'?{teamId:value.teamId,key}:null;
  } catch { return null; }
}
function names(version,arch) {
  const stem=`Mandala-${version}-mac-${arch}`;
  return {zip:stem+'.zip', manifest:stem+'.update.json', signature:stem+'.update.sig'};
}
const release = version => REPO+'/releases/tag/v'+version;
const artifact = (version,name) => REPO+'/releases/download/v'+version+'/'+name;
const immutableCommit = build => Boolean(build && /^[0-9a-f]{40}$/.test(build.commit));
function verifiedManifest(bytes,signature,trust,version,current,arch) {
  if (!newer(version,current)||bytes.length>8192||signature.length>100) return limit('Invalid signed update metadata.');
  const encoded=signature.toString('ascii').replace(/\n$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) return limit('Invalid update signature.');
  const proof=Buffer.from(encoded,'base64');
  if (proof.toString('base64')!==encoded || !verifySignature(null,bytes,trust.key,proof)) return limit('Invalid update signature.');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const fields=['schema','version','platform','arch','name','size','sha256','bundleId','teamId'];
  if (!value || Object.keys(value).length!==fields.length || fields.some(field=>!Object.hasOwn(value,field)) ||
      value.schema!==1 || value.version!==version || value.platform!=='darwin' || value.arch!==arch ||
      value.name!==names(version,arch).zip || value.bundleId!==BUNDLE || value.teamId!==trust.teamId ||
      !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size<1 || value.size>MAX_ARCHIVE)
    return limit('Invalid signed update metadata.');
  const canonical=Object.fromEntries(fields.map(field=>[field,value[field]]));
  if (!bytes.equals(Buffer.from(JSON.stringify(canonical)+'\n'))) return limit('Invalid signed update metadata.');
  return value;
}
function ownDirectory(path, privateOnly=false) {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  return stat?.isDirectory()&&stat.uid===process.getuid()&&(!privateOnly||(stat.mode&0o077)===0) ? stat : null;
}
function ownFile(path,max) {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if (!stat?.isFile()||stat.uid!==process.getuid()||stat.size>max) return limit('Invalid update staging file.');
  return readFileSync(path);
}
function validateBundleShape(bundle,version,arch) {
  if (!ownDirectory(bundle)) return limit('Update bundle is not an owned directory.');
  const filename=join(bundle,'Contents','Resources','runtime','build.json');
  const build=JSON.parse(ownFile(filename,8192).toString('utf8'));
  if (build.version!==version||build.platform!=='darwin'||build.arch!==arch||build.signingRequested!==true||build.sourceDirty!==false||!immutableCommit(build))
    return limit('Update bundle identity does not match.');
  return build;
}
async function verifyMacBundle(bundle,{version,arch,teamId,publicKey}) {
  const build=validateBundleShape(bundle,version,arch);
  const requirement=`anchor apple generic and identifier "${BUNDLE}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
  const opts={timeout:30000,maxBuffer:2**20,env:{...process.env,LC_ALL:'C'}};
  await run('/usr/bin/codesign',['--verify','--deep','--strict','-R='+requirement,bundle],opts);
  const verdict=await run('/usr/sbin/spctl',['--assess','--type','execute','--ignore-cache','--no-cache','--verbose=4',bundle],opts);
  if (!/^(?:source=Notarized Developer ID)$/m.test(verdict.stderr+'\n'+verdict.stdout)) return limit('Apple notarization could not be confirmed.');
  const runtime=join(bundle,'Contents','Resources','runtime');
  const nextTrust=JSON.parse(ownFile(join(runtime,'public-update.json'),8192).toString('utf8'));
  const swap=lstatSync(join(runtime,'bin','swap-app'),{throwIfNoEntry:false});
  if (!parseTrust(nextTrust) || nextTrust.publicKey!==publicKey || nextTrust.teamId!==teamId ||
      !swap?.isFile() || !(swap.mode&0o111)) return limit('Update trust configuration does not match.');
  const plist=join(bundle,'Contents','Info.plist');
  const plistValue=async key=>(await run('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist],opts)).stdout.trim();
  if(await plistValue('CFBundleIdentifier')!==BUNDLE || await plistValue('CFBundleShortVersionString')!==version ||
     await plistValue('CFBundleExecutable')!=='Mandala') return limit('Update app identity does not match.');
  const executable=join(bundle,'Contents','MacOS','Mandala');
  const cpu=arch==='arm64'?'arm64':'x86_64';
  const format=(await run('/usr/bin/file',['-b',executable],opts)).stdout.trim();
  if (!new RegExp('^Mach-O 64-bit executable '+cpu+'(?:\\s|$)').test(format)) return limit('Update architecture does not match.');
  const display=await run('/usr/bin/codesign',['-d','--verbose=4',bundle],opts);
  const cdHash=/^CDHash=([a-f0-9]{40})$/m.exec(display.stderr+'\n'+display.stdout)?.[1];
  if (!cdHash) return limit('Apple code identity could not be confirmed.');
  return {...build,cdHash};
}
async function constrainExtractedApp(dest) {
  const entries=await readdir(dest);
  if(entries.length!==1||entries[0]!=='Mandala.app') return limit('Update ZIP extracted an unexpected layout.');
  const root=join(dest,'Mandala.app');
  if(!ownDirectory(root))return limit('Update did not contain a physical app bundle.');
  const physicalRoot=await realpath(root);
  let count=0;
  async function inspect(dir){
    for(const item of await readdir(dir,{withFileTypes:true})){
      if(++count>50000)return limit('Update ZIP has too many entries.');
      const path=join(dir,item.name);
      if(item.isDirectory())await inspect(path);
      else if(item.isSymbolicLink()){
        const target=await realpath(path);
        if(!target.startsWith(physicalRoot+'/'))return limit('Update ZIP contains a link outside the app.');
      }else if(!item.isFile())return limit('Update ZIP contains an unexpected entry.');
    }
  }
  await inspect(root);
}
async function extractMacZip(zip,dest) {
  // The whole archive must already have matched the release-metadata signature and
  // SHA-256. Additionally reject surprising layouts/expansion before asking macOS
  // to unpack a release archive; preserve the framework symlinks in a signed App.
  const opts={timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,LC_ALL:'C'}};
  const {stdout:listed}=await run('/usr/bin/unzip',['-Z1',zip],opts);
  const {stdout:totals}=await run('/usr/bin/unzip',['-Z','-t',zip],opts);
  const summary=/(\d+) files?, (\d+) bytes? uncompressed[, ]/.exec(totals);
  const entries=listed.trimEnd().split('\n'), normalized=new Set();
  if(!summary || +summary[1]!==entries.length || entries.length>50000 || +summary[2]>8*1024**3 ||
     entries.some(path=>{
       const clean=path.endsWith('/')?path.slice(0,-1):path;
       const equivalent=clean.normalize('NFD').toLowerCase();
       if(normalized.has(equivalent))return true;
       normalized.add(equivalent);
       const app=clean==='Mandala.app'||clean.startsWith('Mandala.app/');
       // macOS ZIPs can include the resource-fork namespace for the same bundle.
       const metadata=clean==='__MACOSX' || clean==='__MACOSX/._Mandala.app' ||
         clean==='__MACOSX/Mandala.app' ||
         (clean.startsWith('__MACOSX/Mandala.app/') && (path.endsWith('/') || basename(clean).startsWith('._')));
       return !(app||metadata) || clean.length>4096 || /[\\\x00-\x1f\x7f]/.test(clean) ||
         clean.split('/').some(piece=>!piece||piece==='.'||piece==='..');
     })) return limit('Update ZIP has an unexpected layout.');
  await run('/usr/bin/ditto',['-x','-k',zip,dest],opts);
  await constrainExtractedApp(dest);
}
async function getArtifact(fetch,url,signal) {
  let current=url;
  for(let redirects=0;redirects<=3;redirects++){
    const response=await fetch(current,{redirect:'manual',signal});
    if(![301,302,303,307,308].includes(response.status))return response;
    await response.body?.cancel().catch(()=>{});
    const location=response.headers.get('location');
    if (!location) return limit('Invalid update redirect.');
    const next=new URL(location,current);
    // GitHub release attachments are hosted on these first-party origins.
    if(next.protocol!=='https:'||next.username||next.password||next.port||next.hash||
       !['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))
      return limit('Invalid update redirect.');
    current=next.href;
  }
  return limit('Too many update redirects.');
}
async function readLimited(response,max) {
  if(!response.ok||!response.body) return limit('Update asset is unavailable.');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){
    bytes+=chunk.byteLength;
    if(bytes>max)return limit('Update metadata is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function streamZip(response,path,manifest) {
  if(!response.ok||!response.body) return limit('Update ZIP is unavailable.');
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const sha=createHash('sha256');let bytes=0;
  try{
    for await(const chunk of response.body){
      bytes+=chunk.byteLength;
      if(bytes>manifest.size)return limit('Update size did not match.');
      sha.update(chunk);
      await file.writeFile(chunk);
    }
    if(bytes!==manifest.size||sha.digest('hex')!==manifest.sha256) return limit('Update checksum did not match.');
    await file.sync();
  }finally{await file.close();}
}

function createPublicMacUpdate({
  installed,swap,version,arch,trust:config,fetch=globalThis.fetch,
  verifyBundle=verifyMacBundle,extract=extractMacZip,exchange=(from,to)=>run(swap,[from,to],{timeout:10000}),
}) {
  const trust=parseTrust(config);
  if(!trust||!versionParts(version)||!['arm64','x64'].includes(arch))return null;
  const cache=join(dirname(installed),'.'+basename(installed)+'-public-update'), readyPath=join(cache,'ready'),previousPath=join(cache,'previous');
  const installedOptions={version,arch,teamId:trust.teamId,publicKey:config.publicKey};
  let offered, inFlight;
  const signed = (bytes,signature,next)=>verifiedManifest(bytes,signature,trust,next,version,arch);
  function staged() {
    try{
      if(!ownDirectory(cache,true)||!ownDirectory(readyPath,true))return null;
      const bytes=ownFile(join(readyPath,'manifest.json'),8192),signature=ownFile(join(readyPath,'manifest.sig'),100);
      const next=JSON.parse(bytes.toString('utf8'))?.version;
      const manifest=signed(bytes,signature,next),zip=join(readyPath,'update.zip');
      const stat=lstatSync(zip,{throwIfNoEntry:false});
      return stat?.isFile() && stat.uid===process.getuid() && stat.size===manifest.size ? {manifest,zip} : null;
    }catch{return null;}
  }
  const describe = manifest=>({version:manifest.version,size:manifest.size,notes:release(manifest.version),publicMac:true});
  return {
    ready(){const candidate=staged();return candidate?describe(candidate.manifest):null;},
    async check(manual){
      offered=undefined;
      if(!manual||!newer(manual.version,version)||manual.notes!==release(manual.version))return null;
      try{await access(dirname(installed),constants.W_OK);await verifyBundle(installed,installedOptions);}
      catch{return null;} // Untrusted current baseline is manual-only.
      try{
        const {manifest,signature}=names(manual.version,arch),signal=AbortSignal.timeout(10000);
        const responses=await Promise.all([
          getArtifact(fetch,artifact(manual.version,manifest),signal),
          getArtifact(fetch,artifact(manual.version,signature),signal),
        ]);
        // An older release deliberately published with neither signed asset is
        // manual-only. A partial or bad signed publication must not downgrade.
        if(responses.every(r=>r.status===404)){
          await Promise.allSettled(responses.map(r=>r.body?.cancel()));
          return null;
        }
        const [bytes,proof]=await Promise.all([readLimited(responses[0],8192),readLimited(responses[1],100)]);
        const value=signed(bytes,proof,manual.version);
        offered={value,bytes,proof};
        return describe(value);
      }catch{throw new PublicUpdateVerificationError();}
    },
    async download(candidate){
      const selected=offered;
      if(inFlight||!selected||candidate.version!==selected.value.version)return limit('Check for updates again.');
      inFlight=true;
      try{
        await verifyBundle(installed,installedOptions);
        await mkdir(cache,{recursive:true,mode:0o700});
        if(!ownDirectory(cache,true))return limit('Update cache is not a private directory.');
        if(staged())return limit('A verified update is already staged.');
        if(lstatSync(readyPath,{throwIfNoEntry:false})){
          if(!ownDirectory(readyPath,true))return limit('Update staging is not private.');
          await rm(readyPath,{recursive:true,force:true});
        }
        const temporary=await mkdtemp(join(cache,'download-'));
        try{
          const zip=join(temporary,'update.zip'),value=selected.value;
          const response=await getArtifact(fetch,artifact(value.version,value.name),AbortSignal.timeout(10*60*1000));
          await streamZip(response,zip,value);
          const expansion=join(temporary,'verified');
          await mkdir(expansion,{mode:0o700});
          await extract(zip,expansion);
          await verifyBundle(join(expansion,'Mandala.app'),{...installedOptions,version:value.version});
          await rm(expansion,{recursive:true});
          await writeFile(join(temporary,'manifest.json'),selected.bytes,{flag:'wx',mode:0o600});
          await writeFile(join(temporary,'manifest.sig'),selected.proof,{flag:'wx',mode:0o600});
          await rename(temporary,readyPath);
        }finally{await rm(temporary,{recursive:true,force:true});}
      }finally{inFlight=false;}
    },
    async install(stopIfIdle,acquireLease=()=>({release(){}})){
      if(inFlight)return 'busy';
      const candidate=staged();
      if(!candidate)return 'none';
      inFlight=true;
      let temporary,lease,retainPrevious=false;
      try{
        const options={...installedOptions,version:candidate.manifest.version};
        const current=await verifyBundle(installed,installedOptions);
        temporary=await mkdtemp(join(cache,'install-'));
        const verifiedZip=join(temporary,'verified.zip'), expansion=join(temporary,'verified');
        let next;
        try{
          const source=await open(candidate.zip,constants.O_RDONLY|constants.O_NOFOLLOW);
          try{
            const pieces=(async function*(){
              const buffer=Buffer.alloc(256*1024);
              for(;;){const {bytesRead}=await source.read(buffer);if(!bytesRead)return;yield buffer.subarray(0,bytesRead);}
            })();
            await streamZip({ok:true,body:pieces},verifiedZip,candidate.manifest);
          }finally{await source.close();}
          await mkdir(expansion,{mode:0o700});
          await extract(verifiedZip,expansion);
          next=await verifyBundle(join(expansion,'Mandala.app'),options);
          await rm(verifiedZip);
        }catch{
          // Do not leave someone unable to redownload a corrupted queued package.
          await rm(readyPath,{recursive:true,force:true});
          throw new PublicUpdateVerificationError();
        }
        const bundle=join(expansion,'Mandala.app');
        if(ownDirectory(installed)?.dev!==ownDirectory(bundle)?.dev)return limit('Update is not on the same volume.');
        if(!await stopIfIdle())return 'busy';
        lease=acquireLease();
        if(!lease)return 'busy';
        // This lease excludes existing gateway startups during final proofs
        // and the one atomic exchange. Previous app remains, even on crash.
        const currentNow=await verifyBundle(installed,installedOptions),nextNow=await verifyBundle(bundle,options);
        if(staged()?.manifest.sha256!==candidate.manifest.sha256 ||
           currentNow.cdHash!==current.cdHash || nextNow.cdHash!==next.cdHash ||
           currentNow.commit!==current.commit || nextNow.commit!==next.commit ||
           ownDirectory(installed)?.dev!==ownDirectory(bundle)?.dev)
          return limit('Update changed while waiting to install.');
        await exchange(installed,bundle);
        retainPrevious=true;
        try {
          if(ownDirectory(previousPath,true))await rm(previousPath,{recursive:true,force:true});
          await rename(expansion,previousPath);
          retainPrevious=false;
        } catch { /* The previous app remains in the unique private install directory. */ }
        try {await rm(readyPath,{recursive:true,force:true});} catch { /* Obsolete signed candidate cannot downgrade. */ }
        return 'installed';
      }finally{
        try{lease?.release();}
        finally{inFlight=false;if(temporary&&!retainPrevious)await rm(temporary,{recursive:true,force:true}).catch(()=>{});}
      }
    },
  };
}
module.exports={createPublicMacUpdate,parseTrust,extractMacZip};
