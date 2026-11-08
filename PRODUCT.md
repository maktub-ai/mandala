# Mandala
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users and Purpose
Mandala is a local-first workspace for people working with CLI-backed agents and optional projects. Agent is a durable identity; CLI is the execution endpoint for a conversation. Local identity and native CLI authentication suffice; an official account is not required for local use.

## Projects and Agents

A Project is a business work scope grouping related working paths, potentially across multiple repositories and workspaces. Its Wiki holds authorized shared business facts, conventions and decisions. An Agent represents a relatively independent business module whose knowledge is reusable across tasks; it executes work and accumulates module-specific experience and scoped memory. Multiple module Agents can collaborate within a Project. Membership does not transfer private memory or grant access to every source.

Mandala plans business scope → Project/workspaces → modules and knowledge boundaries → Agents and capabilities. Module coherence and knowledge reuse determine the split, not minimum team size, one owner per Project, repository count or temporary job titles. Temporary workers execute concrete tasks and return explicit authorized results; they do not replace module continuity or automatically transfer their memory.

## Operating Context
React and Vite provide the UI inside a browser or Electron. Changes are reviewed in an isolated local frontend before merging; source preview does not replace the installed application.

## Capabilities and Constraints
Usage reports Mandala-observed calls only. Preserve the existing API, project/agent scope, daily aggregation, coverage, and source links. Null is unknown, never zero. Cache and reasoning are subsets, not additional totals. Do not invent cost, quota, hourly data, or historical coverage.

## Confirmed Design Commitments
The current approved direction is Compact C with visual language v2 (2026-11-05): an open, monochrome six-petal mark, cool-neutral white/gray and charcoal surfaces, one indigo accent reserved for interaction (primary actions, focus, selection, links), Geist typography, compact navigation and carefully scaled content. This supersedes the earlier Graphite Vermilion and black-coral accent directions. Yellow, cream and warm-gray default grounds are not acceptable. Explicit saved appearance preferences remain authoritative. The usage surface retains its approved summary/trend, user-selected breakdown and on-demand exact details. Preserve real workflows and immediate automatic saving of preferences; inspect rendered product pages separately from functional tests. DESIGN.md and docs/brand-c.md define the current visual authority.

Tasks, Chat and sustained Agent collaboration are the core. Projects and Agents have separate navigation and identities: project membership associates an Agent without moving its memory. Project Library contains Wiki and associated resources; the global Library and Schedules are available through More and can be pinned. Files, documents and code changes must make the content used by Agents inspectable by people. The implementation sequence and backend boundaries are recorded in docs/ui-rebuild.md.

## Evidence
Existing source: src/UsagePanel.tsx, shared/usage.ts, server/usage.ts, src/themes.ts, src/ui/tokens.css and src/ui/brand-mark.css. Current implementation contracts: DESIGN.md, docs/brand-c.md, docs/ui-components.md and docs/ui-rebuild.md. Historical audit material is evidence of earlier states, not the current design authority. Test values are synthetic and must not be represented as the user's usage.

## Optional Remote Access
The official connection option is the default choice but must remain unavailable until a real official origin is configured; no official deployment is claimed. Advanced self-hosting uses the same protocol with independent administrator-created accounts. Execution and business storage remain on the running computer. The relay retains account/device/access metadata and forwards bounded transient ciphertext, with no business mailbox, offline delivery or automatic mutation replay.

Use TweetNaCl's NaCl authenticated box construction. Pair directly from the authenticated local host to pin its public key; approving a browser pins its generated public key on that host. Reject key mismatches. Browser private keys remain in IndexedDB. Require TLS outside loopback. E2EE does not defend against malicious browser code delivered by a compromised web origin.

The phone supports chat/history, attachments and downloads, native approvals/questions, and stopping runs. Remote configuration is read-only and limited to explicit non-sensitive Agent/model/Project summaries. Deny raw configuration, instructions, paths, environment, MCP credentials, terminal, filesystem browsing and configuration/market/automation/system-task APIs at the host. New-chat Agent/model selection is allowed. Local configuration remains editable. Host-offline requests fail; an accepted local run can continue after a viewer disconnects. Missing mutation receipts require history readback, never an automatic retry or an assumed success.

## Source Availability
Project-owned contributions use the Mandala Source-Available License in LICENSE: personal and single-organization internal use, including internal commercial use, is permitted. Third-party hosted services require prior written authorization even when free. This is not an unrestricted or OSI-approved open-source license. Third-party terms and prior grants remain intact; see THIRD_PARTY_NOTICES.md. No legal review, public deployment, installation replacement or real-phone public-network acceptance is asserted by this document.

## Tasks and task closure

Tasks replaces the Progress label and presents durable work with associated Chats; independent Chats remain visible. Activity windows must not hide actual execution, queues or pending user decisions. History restores visibility without changing completion. Capture creates a todo without starting execution. A task reply names its target Chat and Agent; multiple targets require a choice and reuse the Chat submission contract. Offline drafts remain local and require manual sending after reconnection. Authorized Agents can perform Task operations, including explicit completion and reopening, within the same resource access boundaries as other Task commands. A successful native turn alone does not establish goal completion. Resolved dedicated inquiry chats settle without adding a new chat category or sidebar filter.

## Project Wiki and Agent Memory

Wiki belongs to Project; Memory belongs to Agent. A Project Chat without an Agent can create and use shared Project Wiki. Maintenance Agent is an optional executor, never an ownership proxy. No Project means the user must select ownership before creating Wiki. Project knowledge exists independently of background maintenance. Legacy Agent Wiki keeps its existing identity and permissions until an explicit reviewed migration; Project association alone never shares historical data. See docs/library.md for source and reception boundaries.

## 2026-11-01 UI direction

The user rejected colored default chrome and red logos. The mark stays text-colored and surfaces stay neutral. (Updated 2026-11-05: the user approved one indigo interaction accent and an indigo focus ring; chrome itself remains neutral. See DESIGN.md.) Refine typography and rounded workspace framing following the supplied Linear/Cursor screenshots; preserve business behavior and saved user appearance preferences.
