# Mandala coordinator context and discovery

The system Mandala Agent coordinates the user's existing Projects, Agents and Tasks. Every invocation receives its role, concise product definitions, and a current bounded directory summary (up to ten active Agents and Projects, with counts and truncation). Directory labels are configuration data, not instructions. The role does not confer access to other Agents' private context.

Use the **exact invocation launcher** followed by `mandala directory` to refresh configuration. The command is restricted to an active system coordinator invocation; ordinary Agents and expired launchers cannot use it. It returns:

- Enabled runtimes (installation, login and health remain unverified), coordinator and executor runtime/model selections, parallel limits, temporary/archive availability, project membership and Project/Workspace path metadata.
- MCP and Skill catalog IDs/names, enabled/disabled binding IDs and configured effective bindings using the same Project-over-Agent precedence as execution. Native tool inventory and actual tool health are not inferred from configuration.
- Bound command names and argument fields from the real CLI command catalog, current invocation availability, and the exact Agent/Project field whitelist used by management validation.
- Project icons and allowed icon IDs, introduction/instruction presence flags, and direct capability names for completion checks. These flags do not disclose private text or prove its quality.

It does **not** return raw configuration, runtime arguments/environment, credentials, MCP URLs/commands, private instructions/background, Skill source paths/content, resource contents, memory or messages. Project/Workspace paths are discovery metadata; filesystem and memory access still require authorized bindings or delegated execution. Full directory results are fetched on demand; they are not all injected into every prompt.

## On-demand native work discovery and planning

For a current human request to discover work, organize Projects or design a team, the short system trigger loads a **host-owned Skill** with `mandala planning-guide`. It returns `{name, description, content}` with valid `SKILL.md` frontmatter. The full workflow is fetched only when needed, never installed into the mutable personal Skill library or injected into every greeting. No new UI or intent classifier is involved: the coordinator follows the guidance in normal chat.

Use the current invocation launcher exactly, including its quoting or PowerShell wrapper:

```text
<invocation-launcher> mandala planning-guide
<invocation-launcher> mandala discover-work --data '{"runtimes":["codex","omp"],"includePaths":[],"excludePaths":[],"limit":50}'
<invocation-launcher> mandala discover-work
```

Explicit user runtime selection takes precedence and is labeled `user_selected`. Without it, explain the fallback before calling: omitted `runtimes` uses the enabled registered runtimes and returns `registered_runtimes`, which is an inference, not confirmed preference. The existing absent-registration default is Codex and OMP. Only Codex and OMP metadata adapters are supported; other known runtimes return `unsupported` without falling back to unrelated histories. For unsupported, missing or unavailable sources, ask for a runtime selection or manually supplied directories.

Discovery requires an active managed coordinator invocation in the primary chat and a genuine current human event bound to that invocation. Automatic receipts, scheduled/resume sources, forged identity/host-root arguments, background chats and expired launchers cannot trigger it. User-requested continuation in a genuine active human turn is allowed. The active binding is checked again after asynchronous discovery; expired results are discarded. `planning-guide` requires the same active managed identity but does not scan. The CLI has no unbound discovery route or generic root configuration access.

The read-only result includes selected sources and their safe status/reason, observed session counts, timestamps/window bounds, candidate directories and repository/workspace groups, provenance and truncation/uncertainty notices. The window is 90 days; candidate limit defaults to 50, maximum 100. `includePaths` adds manual absolute candidates; `excludePaths` removes candidate subtrees. Paths are untrusted metadata and grant no filesystem or sharing access. The command neither registers paths nor writes configuration, memory, Skills or assets.

No native message/title/first-user-message bodies, credentials, environment values or full native configuration are returned. Codex reads bounded metadata from a private temporary DB/WAL snapshot without modifying native SQLite files; stores with rollback journals are conservatively unavailable. OMP reads bounded leading session headers, not message bodies. Header activity does not establish the last human work time. `sessionCount` means observed sessions, not messages or model calls; optional Codex token totals are cumulative for the observed sessions, not window cost. Unknown metrics remain unavailable. Skipped records and source bounds do not imply complete native-history coverage. No background, startup, scheduled or periodic scan is added.

The Skill presents evidence for the human to add/exclude candidates, then maps business scope → Project and working paths → modules and knowledge boundaries → Agents and capabilities. A Project may contain multiple repositories/workspaces; repository count and native activity do not determine Project or Agent count. Low activity, intermittent tasks or multiple human collaborators alone do not justify omitting a module Agent. Unclear module boundaries are named questions, not evidence that no Agent is needed. One-off/completed tasks are separated from reusable module knowledge. Source authorization remains a prerequisite for sharing knowledge.

A draft remains a draft until a genuine human confirms the named scope in normal chat. Then the coordinator uses existing `mandala configure` validation and approval, preserving current-human provenance and the promotion approval rule. Discovery does not rewrite soul or unrelated Agent settings.

The confirmed checklist includes Project background, a suitable supported icon, workspaces and memberships; Agent module instructions, runtime and capability assignments; and dependency gaps. Authorized external Skills bind the complete package directory, including resources. Configuration may normalize these bindings into reusable library IDs; mentioning a Skill in instructions alone is insufficient. Loading verification is separate from saving the binding and must not be used as a reason to silently omit it. Native inheritance requires same-runtime source evidence; disabled native MCPs remain unavailable.

Before reporting completion, refresh the directory and reconcile saved IDs, icons, presence flags, references and effective configured bindings against the accepted checklist. Keep exact submitted text in the apply context; the directory does not expose it. Correct omissions within the authorized scope or name the blocker. Report configured, intentionally inherited, blocked and unverified items separately. This does not make optional fields mandatory for every manual creation or authorize extra model calls, production probes, schedules or Wiki writes.

The cold-start Skill routes three entry requests separately: discover existing work, plan from a supplied business description, or start a concrete task without requiring team setup. Confirmation and continuation resume the accepted checklist instead of restarting discovery. Its draft table maps business introductions, supported icons, module instructions, execution defaults and capability dispositions to actual configuration fields; optional settings remain deliberate defaults rather than forced setup work.

After one confirmation of that named scope, the recipe creates/updates module Agents with their bindings first, then Projects with introductions, icons, workspaces and member IDs. Required proposal decisions are serialized to avoid stale revisions. Continuation reconciles accepted IDs and saved receipts instead of recreating completed objects. Synthetic JSON examples are executed by `tests/mandala-planning-skill.test.ts` from an empty product home, including an interrupted/resumed setup and complete Skill resource preparation. These are command-contract integration tests, not evidence that a live model will follow every instruction.

## Business Projects, module Agents and temporary execution

A Project is a business work scope containing related working paths, potentially across multiple repositories and workspaces. Its Wiki holds authorized shared business facts, conventions, interfaces and decisions. A maintained Agent represents a relatively independent business module with knowledge reusable across tasks. It executes module work and accumulates scoped experience and memory. Several module Agents may collaborate in one Project; the model neither minimizes team size nor assigns one owner per Project.

Mandala plans from business scope to Projects/workspaces, then module and knowledge boundaries, then Agent and capability assignments. For each Agent the draft explains its module, reusable concepts/rules/experience, related paths, inputs/outputs, collaboration, shared Wiki versus scoped memory, and required capabilities. Existing Agents are reused when their module knowledge and authorized scope fit. A module can span repositories, and one repository can contain multiple modules; neither repositories nor generic job titles dictate the split.

For example, billing ingestion, billing reconciliation and budget analysis could form distinct module Agents sharing provider definitions in a cloud-billing Project Wiki. This is illustrative, not a fixed template or a claim about the user's business. Temporary workers and runtime subagents handle concrete implementation, research, testing and review; their results need an explicit authorized report path to the relevant module Agent. Creating an Agent, membership and worker completion do not automatically transfer private memory or publish shared Wiki. Promotion retains the existing human confirmation rule.

A team draft is a proposal, not authorization to change configuration. Knowledge acquisition uses authorized conversations, explicit reports and approved monitoring; module responsibility does not enable continuous scanning, schedules or automatic trust of reports. This is host guidance delivered through the existing runtime context, not a new memory writer, scheduler, team migration or ACL policy.

## Supported actions

`mandala configure` supports ordinary Agent/Project create, update and archive, plus temporary Agent promotion. Directory `management.fields` is authoritative for writable fields; `createRequired` and `example` describe request construction. Examples use the invocation launcher, not a new unbound CLI identity:

```text
<invocation-launcher> mandala directory
<invocation-launcher> mandala configure --key rename-agent --data '{"change":{"kind":"agent","action":"update","id":"researcher","values":{"name":"Research specialist"}},"mode":"direct"}'
```

Direct changes require an explicit request in the **current human turn**. Proactive changes use `propose` and wait for the human approval card; promotion always requires approval. Deletion archives. Current provenance, managed identity/workspace protection, membership and object ACL checks remain enforced.

Other supported surfaces are discovered through the same catalog and current launcher `--help`: tasks/goals/receipts, authorized conversation references, memory search/read, Project Wiki configuration, Skill registration/versioned updates, file asset publication/update, and owned-goal automation configuration. Catalog presence alone is not authorization or current availability; the directory's invocation flags and command-specific ACLs apply.

## Settings that still require user-facing administration

The coordinator has no bound generic configuration read/write tool. Mandala identity/soul/runtime/model/concurrency, enabled runtimes/global runtime defaults, global system task and memory preferences, global response style, direct global connection editing/removal, library installation/removal, and native runtime authentication are outside `mandala configure`. These remain Settings or native administration operations. Agent-specific settings and capability assignments are supported through the whitelist; this does not expose credential values or grant arbitrary root configuration editing.

## Delivery and verification

Codex receives developer instructions on start and explicit developer-message injection on resume. OMP receives a freshly generated system instruction file on each launched/resumed process. ACP adapters include current host context in each actual prompt. No additional adapter workaround was needed for this change.

`tests/mandala-host-delivery.test.ts` covers initial, resumed and continuity-reset turns for all five runtime IDs. Adapter tests cover actual Codex RPC injection, OMP process arguments/file content, and ACP prompt delivery. Bound-directory tests exercise live configuration updates, redaction and expired/forged invocation rejection; existing coordination tests cover current-human authorization.

For opt-in native semantic acceptance, first prepare an isolated temporary native `CODEX_HOME` with authorized authentication and minimal native settings, then run:

```sh
CODEX_HOME=/absolute/temporary/native-home node --import tsx scripts/mandala-context-smoke.ts
```

The harness creates a separate temporary product home and synthetic team. Natural prompts are “你好” and “我的团队有哪些成员，分别在哪些项目？”. It verifies a coordinator greeting, an actual successful directory call, and current membership after a configuration update. Evidence remains in the temporary product home. It never submits real drafts or changes the real product home; native approvals are not auto-granted. Successful source and isolated runtime checks are distinct from installed-App acceptance.

## Automation result delivery

New rules record a host-owned `reportConversationId`, separate from the executor and execution Chat. Rules created by Mandala in a human chat report to that source chat; rules created through the automation page with Mandala as executor default to its primary chat. Goal-bound rules retain the goal's coordinating source. The field is not accepted from model/tool or HTTP input, and existing rules are not retroactively assigned a destination.

Each accepted occurrence freezes its report destination. A standalone report shares its execution Task with the receiving coordinator but does not grant access to private source/output assets. Receipt authorization, source-version checks, delivery pause and native uncertainty still apply. Same-scope explicit retries retain the accepted Run's report provenance even after the rule is archived. Normal non-automation Task routes do not gain automatic summary processing merely by naming a destination.

Terminal execution receipts reuse the durable receipt-input queue. Mandala receives the actual Run state and explicit final result and writes a short outcome/findings/decision summary in its existing response; the host does not create another summarizer or schedule. Restarts wake pending report destinations, and the receipt-to-input mapping prevents duplicate processing. Failed summary generation leaves the original result accessible.

The conversation results endpoint is an owner-only read projection of authorized receipts. The chat timeline shows their source, execution state, time, and an exact execution link, alongside the coordinator response. Before a response is available the result card keeps its original body collapsed, regardless of result length or Task acceptance state. Expanding shows the complete original Markdown without character truncation; collapsing or reloading hides the body again. Cards without result text retain their state and execution-details link without an empty expand control. These are saved results, not transient task-notification toasts. The `run` URL parameter focuses the corresponding execution turn, including when continuous rules reuse a Chat. Rule details expose the report destination, and the primary scheduled panel includes rules reporting there regardless of executor. Internal title/memory system work and unrelated Agent chats are not added to this feed.
