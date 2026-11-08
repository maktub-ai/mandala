# Mandala v1.0.0

The first public release of Mandala: a local workspace above the AI coding CLIs you already use. Tell it what needs doing; it splits the request into tasks, hands them to long-lived Agents on their own CLIs, and brings results, approvals and open questions back to one place.

## Highlights

- **Tasks and Agents:** one request becomes several tasks, each owned by an Agent with its own instructions, Skills, MCP connections, memory, CLI and model. 14 CLIs are supported with their existing logins; Mandala adds no model account or token markup.
- **Approvals and review:** on-demand, strict or automatic approvals on every runtime. A successful run is not the same as done: confirm results or send them back with a reason.
- **Memory and knowledge:** Agent memory with sources that survives a CLI or model switch, Project Wiki, Skills and opt-in CodeGraph.
- **Accounts and remote access:** sign in with Google, GitHub or an email code; each account has its own workspace. Pair a phone browser once to chat, approve and stop runs over an end-to-end encrypted relay.
- **Market:** themes, language packs and pets from public, reviewed catalogs; the app installs only the exact reviewed version.

## Install

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `Mandala-1.0.0-mac-arm64.dmg` (or `.zip`) |
| Windows x64 | `Mandala-1.0.0-win-x64.exe` |

Verify downloads against `SHA256SUMS.txt`.

These installers are **not code-signed** yet:

- **macOS:** the app is ad-hoc signed and not Apple-notarized. The first time, right-click Mandala.app in Applications and choose **Open**, then confirm. If macOS still refuses, open **System Settings → Privacy & Security** and choose **Open Anyway**.
- **Windows:** SmartScreen may warn about an unrecognized app. Choose **More info → Run anyway**.

## Upgrading from a preview

Choose **Stop runtime and quit…**, wait for active work to finish, and make an offline workspace backup before replacing the App. Data stays outside the App in `~/.mandala`; earlier `~/.open-mana` homes keep working and can be migrated explicitly (see `docs/desktop.md`). Native CLI logins remain where they are.

Mandala's original code is available under the Mandala Source-Available License; third-party components keep their own terms (`THIRD_PARTY_NOTICES.md`). The account and relay service is maintained separately and is not part of this release.
