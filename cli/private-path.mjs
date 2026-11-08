import { windowsSystemBinary } from './windows-system.mjs';
import { constants, lstatSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
// Windows mode bits/getuid do not represent NTFS authority. Check the actual ACL instead.
function windows(script, path, stdio, env = {}) {
  const code = `$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';${script}`;
  execFileSync(windowsSystemBinary('powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    timeout: 5000, windowsHide: true, stdio, env: { ...process.env, ...env, MANDALA_ACL_PATH: path },
  });
}

// Codex's Windows sandbox can restrict PowerShell to ConstrainedLanguage and
// reject Node's redirected child pipes. Use cmdlets and a status-only subprocess.
const checkAcl = String.raw`
$ProgressPreference='SilentlyContinue'
$identity = @(& $env:MANDALA_ACL_WHOAMI /user /fo csv /nh | ConvertFrom-Csv -Header Account,Sid)
if ($LASTEXITCODE -ne 0 -or $identity.Count -ne 1 -or $identity[0].Sid -notmatch '^S-1-(\d+-)*\d+$') { exit 1 }
$owners = @($identity[0].Sid, 'S-1-5-18', 'S-1-5-32-544')
$acl = (ConvertFrom-SddlString -Sddl (Get-Acl -LiteralPath $env:MANDALA_ACL_PATH).Sddl).RawDescriptor
if ($acl.Owner.Value -notin $owners -or $null -eq $acl.DiscretionaryAcl) { exit 1 }
foreach ($ace in $acl.DiscretionaryAcl) {
  if ($ace.AceQualifier -eq 'AccessDenied') { continue }
  $sid = $ace.SecurityIdentifier.Value
  if ($ace.AceQualifier -ne 'AccessAllowed' -or !$sid) { exit 1 }
  if ($sid -in $owners) { continue }
  # Match Codex's write-root rights, without changing permissions or deleting children.
  if ($sid -ne $env:MANDALA_ACL_MAILBOX_SID -or ($ace.AccessMask -band (-bnot 0x001301BF))) { exit 1 }
}
exit 0
`;

export function ownedPrivatePath(path, stat, maxBytes = Infinity, mailboxSid) {
  if (stat.isSymbolicLink() || stat.size > maxBytes) return false;
  if (process.platform !== 'win32') return (stat.mode & 0o077) === 0 && stat.uid === process.getuid();
  try {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) return false;
    windows(checkAcl, path, 'ignore', {
      MANDALA_ACL_WHOAMI: windowsSystemBinary('whoami.exe'),
      MANDALA_ACL_MAILBOX_SID: mailboxSid ?? '',
    });
    return true;
  } catch { return false; }
}

// Codex adds a capability ACE to each extra writable root before launching a
// sandboxed command. Trust only the SID recorded for this exact mailbox.
export async function codexMailboxSid(capabilitiesFile, mailboxPath) {
  if (process.platform !== 'win32' || !capabilitiesFile) return;
  const limit = 8 * 1024 * 1024;
  let handle;
  try {
    const key = (await realpath(mailboxPath)).replaceAll('\\', '/').replace(/[A-Z]/g, char => char.toLowerCase());
    handle = await open(capabilitiesFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || !ownedPrivatePath(capabilitiesFile, opened, limit)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { size } = await handle.stat();
      if (size > limit) return;
      const contents = Buffer.alloc(size + 1);
      const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
      if (bytesRead === size) {
        try {
          const sid = JSON.parse(contents.subarray(0, size).toString('utf8'))?.writable_root_by_path?.[key];
          return typeof sid === 'string' && /^S-1-5-21(?:-\d{1,10}){4}$/.test(sid) ? sid : undefined;
        } catch { /* Codex rewrites the shared map in place. */ }
      }
      if (attempt === 0) await delay(50);
    }
  } catch {
    // Missing or untrusted metadata grants no extra access.
  } finally {
    await handle?.close();
  }
}
export function protectInvocationDirectory(path) {
  if (process.platform !== 'win32') return;
  windows("$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($id);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $env:MANDALA_ACL_PATH -AclObject $acl", path, ['ignore', 'pipe', 'pipe']);
}
