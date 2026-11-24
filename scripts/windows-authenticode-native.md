# Windows Authenticode verification probe (not an updater)

This offline maintainer probe is not packaged with the desktop app. It does
not install, run or download its input, and it does not change trust stores
or registry settings. A successful result is evidence about an open file
during that invocation, not permission to open the same path after it exits.

Use existing x64 MSVC and Windows SDK tooling in a developer shell. Keep all
generated files in a disposable directory. The inputs are the canonical local
path, the size and SHA-256 just verified against the canonical signed Windows
release receipt, and the expected SHA-256 of the DER SubjectPublicKeyInfo of
the leaf Authenticode publisher. That publisher is determined independently
by the release policy; never infer the expected pin from the input executable.
Do not use this probe as a substitute for authenticating the signed receipt.

See the source Result enum for exit codes: 0 verifies the exact bytes and
embedded publisher; 10–13 deny malformed arguments, unsafe paths, size or
digest mismatches; 20–23 deny missing/failed OS trust, ambiguous signatures,
wrong publisher or unavailable verification. Cache-only whole-chain
revocation failures are not retried with weakened settings. No public
installation or signing claim follows from synthetic rejection tests.

With the absolute path to the freshly compiled probe in
MANDALA_WINDOWS_TRUST_HELPER, run:
```sh
node --test scripts/windows-authenticode-native.test.mjs scripts/windows-release-receipt.test.mjs
```

Neither test executes the input file. Native successful acceptance of a
signed release fixture, installed payload architecture independent of the
NSIS bootstrap stub, and an at-use binding that keeps the same protected
installer until the operating system opens it are still required before any
automatic installation work.

## Dormant desktop handoff contract

Windows desktop builds still use the manual installer channel. No update
feed, renderer input, environment override, or verification-probe result
enables automatic installation. The controller can exercise a signed
Windows source in synthetic tests; no packaged source is supplied. See
`desktop/public-windows-update.cjs` and
`node --test desktop/public-windows-update.test.mjs`.

A packaged source needs a first-party Ed25519 release signing key and
pinned Authenticode publisher SPKI, obtained independently of the offered
installer. It must authenticate the version, architecture, commit,
exact size and hash before handoff. The native verifier must independently
hash and authenticate the open file, keep reparse-free ancestor and
deny-write/delete file handles through the OS handoff, and fail closed
when signer or revocation status is uncertain. The existing verification-only
executable closes those handles and cannot perform this handoff.

Before starting the installer, the normal app must obtain explicit consent,
prevent new input, recheck unsaved changes, drain only when idle and acquire
a fresh runtime home lease without taking over a competing runtime. The
candidate exercises this ordering and recovery of the unchanged runtime on
a known prelaunch failure. An uncertain handoff is not retried. Neither
restart, installed build verification, nor rollback after the installer
starts is proven. Keep the production feature disabled until a trusted
release fixture, the exact native handoff and durable recovery are verified.

A Windows signed source is only selectable when the desktop owner supplies
a durable handoff journal. Its `tryBegin()` contract is an atomic,
exclusive pending checkpoint; `settle(token, outcome)` must only settle
the token it owns. A new process finding pending treats it as an unknown
handoff, not as a stale lock to clear. Started and unknown retain the
current main process's input and quiescent-home barriers. A reconciler
would need to check the installed version and the native handoff's
persistent outcome before restoring workspace admission; there is no
such component bundled yet. The in-process fixture intentionally tests
the journal interface and reopening against shared state, not a
real filesystem journal surviving a reboot.

The isolated filesystem journal writes an exclusive pending checkpoint
before returning its owner token and stores the matching started/unknown
outcome in a separate exclusive record. It synchronizes file and namespace,
never clears malformed, unmatched or uncertain state, and never puts owner
tokens in the user-visible update state. Tests spawn separate processes on a
private local directory and reconstruct the controller from the checkpoint.
Windows does not expose directory synchronization through the same Node API;
the Windows constructor therefore returns unavailable unless desktop main
supplies a reviewed native NTFS ACL/identity and namespace-durability adapter.
Do not silently skip that step or claim power-loss tolerance on Windows from
these process-restart tests.

A separately maintained SQLite journal candidate uses the stock SQLite VFS
and a dedicated, preprovisioned database. It will not initialize a missing
database or use the Mandala chat database. It requires a main-owned local
private directory/ACL predicate, exact schema and identity, DELETE journaling
and EXTRA synchronous writes. Corrupt or incomplete ownership is unknown,
not eligible to retry. Pending ownership is committed before any handoff.

Run `node --test desktop/windows-sqlite-handoff-journal.test.mjs` in a
clean local fixture. Native Windows tests cover child-process conflict and
abrupt exit, not physical power loss. They provide a scratch-only path
predicate rather than evidence of packaged Windows directory ACL validation.
This optional module is not bundled, has no production caller, and cannot
enable update download, execution or recovery on its own.

Both journal candidates depend on an already protected, local, non-reparse
home and a trusted owner controlling the entire namespace and sidecars.
They coordinate cooperative main processes under that owner; the owner
token is not an OS boundary against another process running as the same
user. Neither portable Node file identity checks nor the scratch-only
test predicate stand in for Windows ACL and directory identity validation.
Do not initialize a missing or corrupt journal in the runtime updater.

The SQLite adapter passes an encoded local file URI with `mode=rw`, so
even if the database disappears after the check the underlying open
cannot create it. This was tested with the staged Windows Node v22.23.2
and standalone v24.22.3, using Unicode, literal percent and hash
characters, and a disposable database removed exactly at open.

Use a verified URI-capable Node runtime for this optional adapter; older
generic Node builds may not interpret SQLite file URI options and are not
supported. Keep the adapter out of production until the exact shipped
main-process binary and its protected-directory authorizer are verified.
