# System Agent and scheduled work

Approved product contract, 2026-10-31. Baseline: `b44de742ea75cbd3b4d7dbd9b76448ae89575643`.

## Product and interaction contract

Mandala is a protected system Agent, not a Project member. Its primary chat is an independent coordination entry point. Ordinary Mandala chats can select a Project and execute work. Task means a goal, Chat means context, Schedule means a trigger and execution policy, and Occurrence means one recorded trigger. Reading a task does not take responsibility for it.

The system Agent can read all owned workspace task summaries, statuses, execution records and delivery summaries through a server-verified identity. This does not grant access to raw chat history, file bytes or another Agent's memory, nor unrestricted task mutations. Project execution uses that Project's explicitly authorized context and directory. No implicit membership records are written.

Primary chat is never a task-associated or execution chat. It can create goals, delegate, and receive reports through the existing coordination ownership/receipt mechanism. Ordinary chats do not create tasks merely because the chosen Agent is Mandala. Existing task links to the primary chat are detached only when no active or uncertain execution depends on them; source events, coordination ownership, reports and history remain intact.

### Operational UI (inherits Compact C)

Agents page: a pinned system identity section above ordinary Agent search/results, with the configured name, `系统智能体`, and `了解全局任务，协调项目与智能体，也可独立执行工作。`. Actions: `打开主对话`, `新建对话`, `设置`. No empty role, memberships, archive/delete controls, or ordinary-member count for this identity. Search matches the system name and capability copy. Project member displays/counts/editors omit system Agents. Execution selectors expose a system group in every Project. Actual executors and chat identities remain visible.

Settings open directly without navigating to the primary chat. Keep name, personality/collaboration preferences, runtime, model and background concurrency. System role is read-only. New execution chats use current defaults; existing execution settings remain stable. Primary-chat settings continue to apply next turn.

Schedules list: name, human recurrence, next due time, latest outcome. Detail: work instructions, executor, delivery mode, latest run and history. Editor: work, optional Project, executor, recurrence (daily/workdays/custom weekdays/once/interval), execution mode, optional existing matching chat; advanced policies collapsed. Empty project/directory metadata is omitted. Preserve shared controls, theme preferences, keyboard focus and responsive list/detail layout.

### Scheduling semantics

Product references: [Todoist recurring dates](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV) treats weekdays as one Monday–Friday recurrence; [Zapier run history](https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history) separates automation configuration from individual execution status and history. We adopt those interaction principles while keeping Mandala's explicit task/chat continuity modes and approval semantics.

`weekly` gains multiple weekdays, backward-compatible with the old single weekday. Workdays means Monday–Friday, not holiday calendars. CLI and Agent schemas must represent this in one rule.

New `executionMode`: `continuous` reuses a task and execution chat; `independent` creates both per occurrence. A task-origin rule defaults to continuous; a standalone rule defaults to independent. Continuous chat is selected explicitly or created once at first dispatch. Primary chat cannot be selected. Continuous completion/cancellation pauses future triggers; independent occurrence completion does not stop the schedule. Goal-linked rules retain report routing to their coordinating source; primary chat is a report destination only. Busy conversations serialize through existing occupancy rules.

New rules default to `missedPolicy: latest`, `overlapPolicy: coalesce`. Missed windows produce the latest pending occurrence; an active occurrence is not cancelled and later scheduled triggers merge into at most one pending occurrence. Manual clicks are idempotent and do not silently alter recurrence. Advanced manual/each and queue policies remain available.

Old rules missing executionMode retain old task/chat behavior and policies. UI describes this legacy behavior accurately; explicit mode changes affect future occurrences only. Do not silently rewrite existing execution snapshots or active work.

### Feedback and recovery

Run request: submitting → accepted/queued → starting → running → approval/input → settled success/failure/interruption. Native completion is not automatically task acceptance. Unknown request results retain the same idempotency key and offer verification; a refresh failure after acceptance does not turn acceptance into an unknown submission. Running, stopping and polling never lock global navigation. Save protects only the local editor. Stop current occurrence and pause future schedule are different actions.

Requests are bounded. Service unavailable, timeout, invalid response and render failure show contextual recovery while other navigation remains usable. White-screen diagnosis is independent of the reproduced navigation lock and requires evidence; error containment is not proof that the original crash was fixed.

Existing five-rule briefings are only merge candidates after matching actual instructions, executor, Project, runtime, time zone/time, mode and policies, with no active work. Preview exact IDs and changes before applying any merge; preserve original history and receipts. No name-based auto-merge.

## Implementation sequence and acceptance

### Task 1: System identity backend

Implement server-verified global task reads, Project execution without member insertion, primary-chat link/route guards and safe legacy unlinking. Update coordinator instructions and ordinary-chat creation. Tests must prove cross-project execution, task read versus mutation separation, unchanged memory/file/chat authorization, primary chat cannot execute/link, and historical coordination reports survive unlinking. Own server identity/context/tasks/coordination/session changes and associated tests.

### Task 2: System identity UI

Implement the pinned system section, direct settings, role copy, ordinary counts and Project member filtering; enable system Agent selection in ordinary Chat/task forms across Projects. Keep runtime defaults for new chats and actual execution attribution. Verify empty/long-name/loading/error, keyboard and dark/light/narrow layouts. Own identity UI and its tests; schedule UI belongs to Task 4.

### Task 3: Schedule engine and interfaces

Implement multi-weekday schedules, explicit execution modes, new defaults, legacy compatibility and stable context binding. Update API/CLI tool contracts and instructions. Add strict merge-preview/apply capability only if it can preserve history and reject changed/active sources; otherwise produce a read-only candidate report for exact authorized migration. Test weekends, time zones/DST, restart, concurrency, completion semantics, frozen occurrences and idempotency. Own shared/automations, server/automations, automation HTTP/CLI and related tests; coordinate edits to sessions with Task 1 completed.

### Task 4: Schedule UI and responsiveness

Implement the agreed editor/list/detail/state feedback; remove network-operation global navigation locks, bound requests, preserve accepted receipts and uncertain command keys, and add recoverable render containment. Diagnose white screen against captured evidence without touching live data. Test slow/failed GET/POST and independent navigation, mode selection, weekday presets, keyboard and narrow layout. Own schedule UI, request recovery and associated tests.

### Task 5: Integration and installed acceptance

Review each phase before moving to its dependent phase. Run focused regressions, typecheck, build, security checks, rendered UI and independent branch review. Test real flows using isolated HOME/runtime fixtures, not the user's active schedules. Run the Impeccable detector once on finished targets and finish review using captured screenshots.

Fetch and integrate current main, commit, merge and push under repository authorization. Build App/DMG only from clean main synchronized to remote. Verify no active work, back up App and real HOME, verify embedded commit, then install and inspect actual UI, task/chat/memory and appearance preservation. Do not stop active work or merge live schedules without the applicable explicit authorization. Record start/final/remote SHA, tests, failures, package version, backup and acceptance paths; never commit private runtime evidence.

## Reviewed implementation rulings

- System-wide task observation is a separate safe projection, never a widened mutation ACL. Detailed run snapshots/manifests and raw history retain existing authorization.
- `goalId` remains an optional coordination parent/report source; it does not choose execution mode. Reports return to the actual ownership source conversation. System executors retain the selected Project.
- Independent mode rejects an existing-chat binding. Mode/executor/Project changes while queued or active work exists are rejected if frozen routing cannot be preserved; edit errors retain input.
- Weekly weekday numbering remains Sunday=0 through Saturday=6. A new weekdays list is nonempty and unique; supplying inconsistent old/new forms is rejected.
- Old rules without mode retain their actual behavior: goal-linked rules create a child task per occurrence; task-linked rules reuse their task. Chats are new per occurrence unless explicitly bound. Describe these branches as legacy rather than mislabelling all of them continuous.

### Interaction sketches

Agents: `[Mandala · 系统智能体] [打开主对话] [新建对话] [设置]`, then one capability sentence; below it `智能体 · N` with search and ordinary identity rows. Narrow layouts wrap the action group beneath the capability text. No nested cards or decorative metrics.

Schedule list row: `每日待办简报` / `工作日 09:00 · 下次 周一 09:00`, with `已启用` and latest outcome aligned at the trailing edge. Selecting the row opens the existing list/detail composition; narrow view uses the detail with a back action.

Schedule detail: title + enabled state → recurrence + next due → work instructions → executor + execution mode → `[运行一次] [编辑] [暂停计划]` → current run (status, elapsed/latest activity where observed, `[查看对话] [停止本次]`) → past runs. Advanced missed/overlap policy is shown in the editor only.

Editor sequence: name/instructions → optional Project/executor → recurrence and time zone → `持续推进` or `每次独立执行` with one-line consequences → continuous chat destination (`首次运行时创建` or matching existing chat) → collapsed advanced policies → save paused rule. Enabling remains an explicit action; a user-authorized Agent can create then enable through the CLI.
