const {createPublicKey} = require('node:crypto');
const {verifyWindowsInstallerBytes} = require('../scripts/windows-release-receipt.mjs');

const hex256 = /^[a-f0-9]{64}$/;
const stable = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const reject = () => Object.assign(new Error('Could not verify the signed Windows update.'),{name:'PublicUpdateVerificationError'});

function validTrust(trust) {
  if (!trust || typeof trust.publisherSpkiSha256 !== 'string' || !hex256.test(trust.publisherSpkiSha256) ||
      typeof trust.publicKey !== 'string' || trust.publicKey.length !== 60) return false;
  try {
    const bytes=Buffer.from(trust.publicKey,'base64');
    return bytes.toString('base64')===trust.publicKey &&
      createPublicKey({key:bytes,format:'der',type:'spki'}).asymmetricKeyType==='ed25519';
  } catch { return false; }
}

// Do not construct this from renderer arguments or environment configuration.
// The production application has no caller until a bundled and reviewed native
// verifier can honor the locked-handle contract. This is not a path-based spawn.
function createWindowsUpdateGate({version,arch,trust,native}) {
  if (arch!=='x64' || typeof version!=='string' || !stable.test(version) ||
      !validTrust(trust) || typeof native?.withLockedInstaller!=='function') return null;
  const {publicKey,publisherSpkiSha256}=trust;
  const withLockedInstaller=native.withLockedInstaller.bind(native);
  let pending=false;
  let launchAttempted=false;
  return Object.freeze({
    async install(input, authorize) {
      if(pending||launchAttempted) return 'busy';
      pending=true;
      try {
        const {path,receipt,signature,version:offered}=input??{};
        if (!Buffer.isBuffer(receipt)||receipt.length>4096||!Buffer.isBuffer(signature)||
            signature.length>89||typeof authorize!=='function') throw reject();
        const exactReceipt=Buffer.from(receipt), exactSignature=Buffer.from(signature);
        const expected=JSON.parse(exactReceipt.toString('utf8'));
        if (expected?.version!==offered||expected?.arch!==arch||expected?.publisherSpkiSha256!==publisherSpkiSha256) throw reject();
        const metadata=await verifyWindowsInstallerBytes(path,exactReceipt,exactSignature,expected,publicKey,version);
        let result, entered=false, accepting=true;
        // The native backend must recompute SHA-256 and check architecture and
        // trust on its own already locked file handle before calling 'use',
        // and maintain that same binding through launch or until 'use' exits.
        try {
          await withLockedInstaller(path,metadata,async (proof, start)=>{
            if(!accepting||entered) throw reject();
            entered=true;
            if (proof?.status!=='valid'||proof.revocation!=='verified'||proof.source!=='embedded'||
                proof.platform!==metadata.platform||proof.arch!==metadata.arch||proof.size!==metadata.size||
                proof.sha256!==metadata.sha256||proof.publisherSpkiSha256!==publisherSpkiSha256||typeof start!=='function') throw reject();
            const release=await authorize();
            if(typeof release!=='function') {result='busy';return;}
            try {
              if(!accepting) throw reject();
              // Once handed off, even unknown completion requires reconciliation;
              // this instance never resends an install command.
              launchAttempted=true;
              try { result=await start()==='started'?'started':'unknown'; }
              catch { result='unknown'; }
            } finally { await release(); }
          });
        } finally {accepting=false;}
        if (!result) throw reject();
        return result;
      } catch {
        if(launchAttempted)return 'unknown';
        throw reject();
      } finally {pending=false;}
    }
  });
}

// Shared by the signed Windows main-process install action and its synthetic QA.
// Callbacks are main-owned: no callable or path is accepted via IPC.
function createWindowsInstallAction({confirm,canUnload,inhibitInput,stopIfIdle,claimQuiescentHome,resumeUnchanged,installVerified}) {
  let pending=false, terminal=null;
  return async () => {
    if(terminal) return terminal;
    if(pending) return 'busy';
    pending=true;
    let blocked=false, drained=false, unsaved=false, entered=false, recover=false;
    try {
      if(await confirm()!==true) return 'cancelled';
      if(await canUnload()!==true) return 'unsaved';
      const result=await installVerified(async()=>{
        if(entered) return null;
        entered=true;
        inhibitInput(true);
        blocked=true;
        if(await canUnload()!==true) {unsaved=true;return null;}
        drained=await stopIfIdle()===true;
        return drained ? claimQuiescentHome() : null;
      });
      if(result==='started'||result==='unknown') return terminal=result;
      recover=drained;
      return unsaved?'unsaved':'busy';
    } catch (error) {
      // installVerified distinguishes a possibly-launched helper ('unknown')
      // from a known prelaunch failure (throw).
      recover=drained;
      throw error;
    } finally {
      try {
        if(blocked)inhibitInput(false);
        if(recover)await resumeUnchanged();
      } finally {pending=false;}
    }
  };
}

module.exports={createWindowsUpdateGate,createWindowsInstallAction};
