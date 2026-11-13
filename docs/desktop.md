# Mandala desktop preview

Mandala uses a small Electron shell around the existing local service and React UI. The package carries the **exact build Node 22.x binary** and its production dependencies separately from Electron, so SQLite and node-pty use the supported Node ABI. End users do not need system Node to open the App; they choose and connect a supported native CLI separately. The current adapter catalog contains Codex, Oh My Pi, Claude Code, Gemini CLI and OpenCode. Native login stays in each CLI's existing location; a successful startup probe does not establish authentication, model access or quota.

## Build and install

Build on the target OS/architecture with Node 22.23.2+ (22.x). Root and desktop lockfiles are separate:

```sh
npm ci
npm ci --prefix desktop
npm run typecheck
npm test
npm run desktop:build
```

The selected Compact C monochrome SVG is converted into committed PNG/ICNS/ICO resources; macOS and Windows packages explicitly use those icons. See [the asset contract](brand-c.md). To regenerate after an approved SVG update, run `node scripts/desktop-icons.mjs` on Mac (requires the repository Playwright Chromium and native sips/iconutil).

While the App is running, its Dock icon on macOS and window/taskbar icon on Windows follow the saved App display mode: Light uses a neutral light background and dark mark; Dark uses a charcoal background and light mark; System follows the OS appearance. The six-petal C mark has no accent inserts. Saving a theme updates the icon immediately without restarting the runtime, and the saved mode is used on cold start. Finder/Explorer and installer icons retain the static bundle icon.

The output is `release/desktop/Mandala-<version>-mac-<arch>.dmg` plus ZIP on macOS, and `Mandala-<version>-win-x64.exe` on Windows. `npm run desktop:build -- --dir` creates an unpacked app. Set `MANDALA_VERSION` to the tag's semantic version without `v`; otherwise the root package version is used. A Mac build validates that Mac architecture only; Windows builds run on a Windows runner with native dependencies. Copying Mac node-pty or the Mac Node binary into an EXE is unsupported.

On Mac, drag Mandala.app from the DMG into Applications. On Windows, run the per-user NSIS installer and select the installation directory. Mac previews use an ad-hoc signature for bundle integrity, without Developer ID or Apple notarization; Windows previews are unsigned unless a signed build is explicitly configured. OS security prompts and SmartScreen/Gatekeeper may require manual user approval. An invalid signature is a packaging failure, not an expected preview warning. Do not globally disable OS protections. Installers preserve the separate data directory; uninstall does not delete personal data.

## First run and local data

A fresh install uses `~/.mandala`. Unmigrated installations continue using `~/.open-mana` until the explicit offline migration below. After migration, both CLI and desktop select `.mandala`, and `.open-mana` remains a compatibility directory link. Independent current-name and legacy-name homes are a conflict rather than an implicit identity switch. `MANDALA_HOME` takes priority over legacy `OPEN_MANA_HOME`; explicit paths remain supported. The desktop uses a separate `account-gateway` runtime and requires Google, GitHub or email-code sign-in. Sessions permit seven days of offline use. Each account has a separate workspace and Chromium partition; the first account may explicitly claim existing local data after its old runtime is stopped. Other running services are never taken over. See [account setup and isolation boundaries](account-service-deployment.md). Configure and verify the account service before replacing a working installation.

On first sign-in, choose a Mandala username in the browser before approving the desktop. The account menu uses the Google or GitHub avatar when available, otherwise it shows the username's initial. Changing the avatar in the desktop account menu saves `account-avatar.jpg` in that account's local workspace. The image is not synchronized to the browser or other computers.

### Migrate a legacy home

Stop all services using the directory first. The command refuses live service/Store locks, existing destinations, existing backups and backups inside either data directory. The backup must be on the same filesystem because the complete original directory is retained under `backup/home`. A staged copy is validated and only structured owned paths are updated; credentials, IDs, native session references, user text, memory evidence and external repository paths remain intact. Old absolute paths continue to resolve through the compatibility link. Failed publication restores the original directory.

```sh
npm run migrate:home -- --from "$HOME/.open-mana" --to "$HOME/.mandala" --backup "$HOME/.mandala-backups/workspace-NEW"
```

The installed package includes the same command:

```sh
runtime=/Applications/Mandala.app/Contents/Resources/runtime
"$runtime/bin/node" "$runtime/scripts/migrate-home.mjs" --from "$HOME/.open-mana" --to "$HOME/.mandala" --backup "$HOME/.mandala-backups/workspace-NEW"
```

For a separate profile inside the main data directory, add `--nested-home cases/profile-name` (repeat for each operational profile). Its structured paths are also updated; unselected archived snapshots keep their original bytes. All nested services and Stores must be stopped, including profiles not selected for rewriting. Startup through a nested HOME is blocked while the parent migration runs.

Account-service and release homes use the same command with matching `-account-service` or `-releases` suffixes. Stop the account service and any release publisher before migrating them; release manifests are updated, while archived releases retain their historical contents. On macOS the command requires native filesystem cloning (`cp -cR`); other platforms use copy-on-write where supported and otherwise require enough space for the staged copy. A `migration.json` receipt identifies the original backup and canonical directory. A repeat invocation recognizes the existing alias without copying again.

If installation verification fails before work resumes, stop the runtime, retain the new directory under a separate recovery name, unlink the legacy alias, and move the original `backup/home` back to its legacy location. Never overwrite a directory that has received new work. Do not remove the compatibility alias while native CLI histories or external scripts still reference it.

The background runtime reserves a dynamic **127.0.0.1** port. Initial startup uses child IPC readiness; subsequent launches verify a challenge response using the private `.desktop-runtime.json` discovery record. A live unverified process is never taken over. The account gateway has its own private discovery record; each active workspace publishes its own record for native CLI discovery. The renderer receives HttpOnly cookies, while the gateway keeps the cloud session in owner-only local metadata. Desktop sign-out stops its workspace and remote connector; ordinary App quit leaves it running only until session expiry. Cloud accounts are created after provider or email verification; model-provider credentials remain independently managed by native CLIs.

GUI apps inherit limited PATH on macOS. Mandala reads the user's login-shell PATH (10-second timeout), adds common `.local/bin`, `.bun/bin`, Homebrew and npm locations, and prepends its bundled Node. It does not copy, log, or inspect native CLI credentials. The existing `/api/cli/status?cli=…` endpoint probes the selected adapter's startup ability; an authenticated real model turn remains a separate test. Windows adapters now use cross-spawn for npm `.cmd` lookup and argument escaping. Agent invocation uses a private PowerShell launcher, preserving argument bytes through JSON rather than a POSIX shell. NTFS credential checks read the real ACL instead of POSIX uid/mode bits; invocation directories grant only the current user. Existing data directories with broad NTFS ACLs fail closed. Use a trusted per-user parent directory; protection against replacement through a separately writable shared ancestor is not claimed. Fixed Windows system utilities use absolute SystemRoot paths, and default codex/omp programs are pre-resolved from explicit absolute PATH directories before starting in the project cwd. The workflow includes Windows-native mock protocol tests; they are skipped on this Mac and actual native-account/model acceptance still requires Windows.

For an isolated acceptance run, use a temporary HOME/data directory and set `MANDALA_ACCEPTANCE_PREVIEW=1` in the launcher environment. Local and control login pages then identify the synthetic preview and explain that everyday accounts belong to the existing installation; signed-in previews retain an environment label. This flag only labels the environment. It does not copy accounts, change authentication, select a data directory, or make personal credentials valid in test data. Omit it for normal use.

## Register the terminal command

In the desktop App, **Settings → General → Mandala command** explicitly registers `~/.local/bin/mandala` on supported Unix platforms. Installing or opening the App does not register it automatically. Registration uses the App's bundled Node and CLI bootstrap; it does not install system Node, edit PATH or shell profiles, request administrator access, or store a port, token or credential in the launcher. Windows registration is currently reported as unsupported.

The screen separately reports command registration, whether the directory is in the App's resolved PATH, whether another command takes priority, and whether the bundled runtime is available. If the directory is not in the terminal's PATH, use the displayed absolute command or add the directory yourself. A different existing file, symlink, or previous launcher with another installation/HOME location is preserved and reported as a conflict; registration never overwrites it. Resolve that path manually before registering again. An identical valid registration is idempotent. New launchers are written completely before exclusive publication, so failed writes cannot damage an existing command.

Each invocation discovers and authenticates the selected HOME's currently running desktop service using its private discovery record. Ports may change between launches. Open Mandala first for service commands; `--help` remains available without a running service. An explicit CLI base URL, HOME or Agent invocation context retains its existing precedence. This command does not introduce a second daemon or an automatic host wake-up mechanism.

## Device UI preferences

Language, sidebar layout/pins/order, Tasks and legacy Team view preferences, remembered chat/project/Agent/model choices, inspector width, market source filters and command history use the fixed HOME file `desktop-preferences.json`. Persisted legacy keys remain compatible when navigation labels change; the supported keys are defined in `shared/device-preferences.ts`. The exact trusted main frame may read a snapshot or write one key; credentials, remote pairing keys, IndexedDB identity and temporary session routes remain separate. The document is bounded to 256 KiB, saved atomically with private permissions and included in offline backup/restore.

The first successful native read migrates every missing allowed key from the current browser origin, including unopened pages. Native values win. A native storage failure retains readable cached/current choices and reports a retryable notice rather than crashing the App. A confirmed previous-origin snapshot can fill missing values during an upgrade, but must not overwrite more recent native/current-origin choices. Opening the App only reads configuration; it no longer silently changes memory-generation language. Explicit language changes in Settings still save normally.

Manual schedule verification uses a separate, bounded `mandala-schedule-command-checkpoints` preference in the same HOME file. It stores only authenticated identity, rule path and command key, survives runtime-origin changes, and imports an old origin-local checkpoint only before that identity has a native record. Unlike optional UI choices, unreadable or unwritable command checkpoints fail closed: no replacement key or POST is issued. Empty identity records prevent stale browser data from resurrecting a confirmed command. Browser-only schedule use retains its origin-scoped fallback.

## Appearance across restarts

Desktop appearance is saved in `desktop-appearance.json` under the selected data HOME. The renderer can read/write only this bounded preference document through the current trusted main frame; it receives no arbitrary filesystem or command API. Palette choices, custom colors, fonts, density and backgrounds survive a cold runtime restart that assigns a different loopback port. Browser localStorage remains a cache and the web frontend keeps its existing origin-scoped behavior. The offline workspace backup/restore includes this document.

On the first launch with no document, the App migrates the current origin's saved appearance. Preferences belonging to older ephemeral origins are left intact; an upgrade must recover the known previous live origin's choice before switching origins if it has not yet been migrated. Do not select an arbitrary historical origin or copy another profile's preferences.

The full window lifecycle smoke signs in through an isolated, locally started account service, then checks the sandboxed window, second launch, background work after normal quit, renderer-crash recovery, reopen and **Stop runtime and quit…**. Build `mandala-service/account-service` first, then run `MANDALA_ACCOUNT_SERVICE_SOURCE=/path/to/mandala-service/account-service NODE_OPTIONS='--import tsx' node scripts/desktop-window-smoke.mjs`. Without the private service, `node scripts/desktop-window-smoke.mjs --gate-only` checks only the signed-out gate (workspace APIs rejected, sandbox and context isolation) and is not a lifecycle pass.

`node scripts/desktop-appearance-smoke.mjs /absolute/path/Mandala.app` verifies UI-selected light/dark palettes and their computed colors across three real cold starts in an isolated HOME, occupying the first port to force an origin change. It does not modify personal preferences.

## Background and quit behavior

Closing the window hides it while local tasks and the outbound computer connector continue. **Quit Mandala** exits only the Electron frontend: the detached runtime and its tasks continue, and reopening the App reconnects to the same runtime. App crashes or quit during startup also do not shut down this background runtime. A second launch while the App is open brings its window forward.

The separate **Stop runtime and quit…** menu action asks for confirmation, authenticates a shutdown request, and waits for native sessions, terminals, memory workers and SQLite to close. A timeout keeps the frontend open and reports incomplete shutdown; it never force-kills a reattached PID. Use this action before upgrades, offline backups or uninstalling. It also pauses automatic startup across logins and reboots until Mandala is opened manually again.

Opening the installed App registers startup at system login for the default data home on macOS and Windows. At login, Mandala starts the background runtime without opening a window. The workspace and its scheduler start only with a valid desktop account session. The runtime does not restart automatically after a crash. Reopening after a crash starts a new runtime with saved history. Unfinished work is not automatically resubmitted.

Authenticated `/api/status` includes the actual Node version/support baseline and, in desktop mode, `{closeBehavior:"hide",quitBehavior:"disconnect",background:true}`. Renderer Node integration is disabled; sandbox/context isolation are enabled, navigation stays on the exact local origin, new windows and unsolicited permissions are blocked. A narrow preload responds only to actual user clicks on HTTP(S) links; the main process validates the sender and opens the external browser. Programmatic popups and other schemes stay blocked. No callable command/file IPC is exposed to the page.

## Versioned release and manual upgrades

Desktop builds and checks run locally by default. `npm run desktop:build` produces the local DMG and ZIP on macOS. The optional manual release workflow can build reviewed `vX.Y.Z` tags, preserve the fixed checkout SHA in `runtime/build.json`, run runtime smoke tests, and attach installers/checksums only to a **draft prerelease**; pushes, pull requests and tags do not automatically start cloud CI/CD. The integrator reviews evidence before publishing. Packaged Apps check the public `maktub-ai/mandala-releases` feed 30 seconds after startup and every six hours. The Mandala menu also offers **Check for updates…**. Checks include preview releases and only offer a newer version with an installer matching the current OS/architecture. Offline automatic checks are silent; manual checks explain failures. Each version is prompted once per App session. Only an explicit **Download update** click opens the installer; download the matching architecture, verify SHA-256, choose **Stop runtime and quit…**, then replace the App/run the newer installer. No automatic download or restart occurs during active work.

On a Mac running a `-local.main.<commit>` development build with the local updater, run `scripts/update-app-from-main.sh --stage-only` to build the synchronized main commit and make it available on that Mac. In **Settings → General → About and updates**, check for updates and download. The update is copied and verified in Mandala. Once the download completes, quit and reopen Mandala. If the runtime is busy, finish the work and quit again. The updater keeps the previous app bundle in the hidden `.Mandala.app-update` directory next to the installed app until another build is downloaded. Existing development installs need one initial upgrade to an updater-enabled build.

Before upgrading existing data, make an offline snapshot after **Stop runtime and quit…** completes, using the bundled runtime tools (example Mac installation):

```sh
RUNTIME=/Applications/Mandala.app/Contents/Resources/runtime
"$RUNTIME/bin/node" "$RUNTIME/scripts/workspace-backup.mjs" backup \
  --home "$HOME/.mandala" --output "$HOME/mandala-snapshot-NEW"
```

Use the actual selected HOME (including `.open-mana` if reused). A restore writes into a **new** directory:

```sh
"$RUNTIME/bin/node" "$RUNTIME/scripts/workspace-backup.mjs" restore \
  --input "$HOME/mandala-snapshot-NEW" --home "$HOME/.mandala-restored"
MANDALA_HOME="$HOME/.mandala-restored" /Applications/Mandala.app/Contents/MacOS/Mandala
```

On Windows the runtime is under the installation's `resources\runtime`; run `bin\node.exe` and the same `.mjs` tools. Snapshots exclude native CLI authentication/history and external repositories; preserve those separately using their native tools. If a new version fails, stop it, restore the matching snapshot into a new HOME, and run the old retained installer with that HOME. Never overwrite live SQLite or assume an old binary supports a newer migrated database.

## Signing and acceptance boundaries

Ad-hoc Mac signing and unsigned Windows builds are the defaults. The Mac packaged smoke requires strict signature verification before any service starts or release artifacts are uploaded. A release maintainer can set `MANDALA_SIGNED=1` and provide `CSC_LINK`/`CSC_KEY_PASSWORD`; Mac notarization also needs Apple's supported `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` (or supported notarization API credentials). Signed mode forces code signing and Mac notarization, so missing credentials fail the build. Certificates, Apple team membership and Windows signing credentials are not provided by this source tree. Preserve the stable appId `com.maktubcn.mandala` across versions.

Before public release verify a copied/installed Mac app, each intended architecture, Windows installation + real native CLI launch + graceful quit/restart, signed/notarized status, and upgrade from the previous real version. Building an installer is not proof of those behaviors. No enterprise service, paid model test, official domain or cloud deployment is supplied by this preview.

Implementation follows [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [electron-builder configuration](https://www.electron.build/v26/docs/configuration/).
