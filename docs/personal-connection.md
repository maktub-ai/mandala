# Personal local use and optional computer connection

Mandala runs on your computer. Packaged desktop builds require a Mandala account through Google, GitHub or email verification. A valid session permits seven days of offline use. Account profiles isolate local history; remote access remains optional. Business configuration, conversations, tasks, memory, project files, attachments, native CLI credentials and execution stay on that running computer.

Optional remote access uses a separate account/connection service. It keeps account, session, computer and browser authorization metadata in private `accounts.json`. The browser and host encrypt business requests and responses end to end using TweetNaCl's established NaCl authenticated box construction. The relay sees ciphertext and account/device/access metadata and forwards it in bounded transient streams; it has no business database, offline mailbox or automatic business-write replay. The computer must be running and online.

Official connection is the default remote choice, but it is unavailable until a real official origin is configured. No official public service is deployed by this checkout. Self-hosting uses the same service/protocol with its own configured identity providers. New verified identities create accounts automatically. Provider credentials and Resend configuration are described in [the deployment guide](account-service-deployment.md). Mobile access uses the browser application.

## Account service and desktop setup

The official server is maintained in the private [mandala-service/account-service](https://github.com/maktub-ai/mandala-service/tree/main/account-service) directory. Its README covers deployment and Google/GitHub/Resend credentials. This desktop repository has no `start:control` or `account:build` command.

Packaged desktop users sign in through the system browser, then choose **Account and connection → Link this computer**. The local execution service remains on loopback and opens outbound connections to the account service. No separate local password is required. Legacy source-only local workspaces can still be provisioned with `npm run account:admin -- --home /absolute/local/workspace --username NAME`, passing the password through stdin.

## Pair and authorize a phone/browser

1. Open the HTTPS connection-service page and sign in. Select the online computer and request browser access. The browser generates its own NaCl keypair; its private key is stored in that browser's IndexedDB, never relay metadata or localStorage.
2. From the authenticated **local computer page**, copy the pairing code directly to the phone. This pins the computer's public key without trusting a key supplied solely by the relay. Obtain it directly from the computer, not a relay notification or another person's message.
3. On the computer, review and approve the pending browser. Approval pins that browser's public key locally. Account login or a relay-side authorization decision alone cannot approve or replace a key. A different host/browser key fails closed and requires explicit pairing/approval again; do not bypass a mismatch warning.
4. The approved phone can create/read conversations, choose an Agent/model for a new chat, send input and attachments, read outputs/downloads, answer native approvals/questions, and stop conversations/tasks. Native CLI authentication and tool permissions still apply.
5. Revoke a browser on the computer to remove its local authority and close active access. Closing remote access first closes the local connector and removes its authority; online credential revocation can remain pending if the relay is unreachable. Reconnecting does not restore a revoked browser grant.

Authorization is specific to the browser installation and its key, not a hardware fingerprint. Clearing cookies or IndexedDB, changing browsers or losing the private key requires pairing/approval again. The pairing code contains public identity information, not a private key; obtain a fresh code from the authenticated host when re-pairing.

## Remote configuration and interrupted requests

The phone shows only an explicit non-sensitive summary: Agent IDs/names, default CLI and model choices; Project IDs/names and Agent membership; and indicators that execution is local and remote configuration is read-only. Configuration writes, raw configuration, instructions, filesystem paths, MCP/environment/credentials, terminal/shell, filesystem browsing, Market, automation and system-task APIs are denied by the host even if a client bypasses the UI. Execution cwd, auto-approval and CLI arguments cannot be changed remotely. Normal local configuration editing remains available.

A disconnected/offline host cannot receive requests. An already accepted local run can continue if its viewer disconnects. If a write's receipt is lost, reload local history to establish its outcome before deciding what to do next; neither connector nor client should automatically replay it or claim that it ran. The relay cannot deliver an offline queue later.

### Tasks, Chat and offline drafts

The remote workspace prioritizes Tasks and Chat. Configuration is an explicitly read-only summary loaded on entry or when needed, rather than a recurring full-configuration poll. A Task exposes only its associated Chats that the current browser may read. Multiple eligible Chats require an explicit target; opening or capturing work does not send a message. Agent and execution details remain visible on the target Chat.

The connection indicator combines the host heartbeat with actual request outcomes and labels the last successful read. A disconnected viewer may continue editing its browser-local draft. Reconnecting only refreshes reads: sending is always manual. IndexedDB retains draft text and available File bytes under the account, computer, paired-browser and Chat identity. When attachment metadata survives but its bytes are missing, a new send is blocked until the attachment is reselected or removed. Checking an existing uncertain submission retains its original identity and does not require attachment reupload or another POST.

A new send waits until the selected Chat's detail has loaded so queue versus continue follows its actual execution state. A missing Chat is shown as unavailable without declaring the entire computer offline. Authorization loss clears protected configuration, lists, messages, approvals and previews; in-flight responses and file downloads from the previous authority cannot repopulate the view. An offline or unavailable host never receives an automatic draft replay. Browser storage is not a server-side mailbox or a backup of the computer's workspace.

## Deploy the account service

Use the private service repository's deployment instructions. This checkout does not deploy official infrastructure. Keep the Node listener private behind HTTPS and never log or persist relayed business payloads.

## Verify

Use isolated temporary homes and synthetic data. Run `npm test`, `npm run typecheck`, `npm run build` and `npm run test:e2e`; inspect the actual mobile browser flows and screenshots. Validate direct local use without a connection service, first pairing/approval, wrong-key rejection, replay/tamper/truncated-response rejection, remote configuration denial, attachments/downloads, native approvals/questions, stopping, reconnect, revocation and plaintext-business denial at the relay. Check relay metadata and logs for absence of synthetic business markers, filenames and paths.

`npm run smoke:personal` is the two-process personal-connection smoke entry point; `npm run smoke:cli` validates native CLI execution independently. These use temporary homes and synthetic accounts/data. Native model calls require an existing CLI login and consume its account quota; do not copy credentials or change an existing running service for acceptance. Report which commands and flows were actually executed for the selected source version rather than treating this checklist as a result.

Source/build/loopback-browser checks, package identity, installed-app replacement and real-phone public-network use are separate evidence. This change does not establish an official deployment, external DNS/TLS readiness, installation replacement or actual phone access over a public network.

## License

Original project contributions are source-available under the repository LICENSE (Mandala Source-Available License): personal and single-organization internal self-hosting, including internal commercial use, are permitted. A hosted service for third parties needs prior written authorization from the relevant rights holder(s), whether paid or free. This is not an unrestricted or OSI-approved open-source license. Third-party materials and earlier grants retain their own terms; see THIRD_PARTY_NOTICES.md. No legal review is asserted.

## Verify selected references with native CLIs

```sh
npm run smoke:references -- --cli codex
npm run smoke:references -- --cli omp
```

Each command creates a new temporary `MANDALA_HOME` (or requires the provided directory to be empty under the system temporary directory). It uses native CLI login without copying credentials, selects a synthetic Project Skill, and requests a real model turn. A random expected marker appears only in the actual Skill body. Success requires both the exact model response and local transcript readback of the selected opaque identity, canonical Skill source path and body. The command prints JSON evidence and retains the temporary home for review. This invokes a real model and uses its native account quota; it neither restarts the existing service nor publishes a release.

Actual acceptance was verified on Codex CLI `0.160.0` and OMP `18.6.1`. `tests/composer-references.test.ts` separately checks Project > Agent > native precedence, secret-free MCP identity, disabled MCP rejection, exact task context without task execution, Agent/owner and run-content authorization, stale selections, queue preservation/cancellation, and authorization revoked during native preparation. Referencing an MCP server describes the exact configured server and preserves native tool authorization; selecting a task does not run or complete it.
