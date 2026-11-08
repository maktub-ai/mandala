# Mandala Design System

Mandala is an operational workspace for coordinating long-lived Agents, Tasks and Chats. The interface recedes around current work: the user should always be able to tell what object they are looking at, what needs them next, and what actually happened.

This document is the single normative source for Mandala's visual language and interaction patterns. It describes the current state, not a history; superseded directions are listed only in the [change log](#change-log).

| Need | Source |
| --- | --- |
| Runtime colors, fonts, radius and density | `shared/themes.ts` (re-exported by `src/themes.ts`) |
| Pre-render fallbacks and fixed roles (type scale, page widths, scrim) | `src/ui/tokens.css` |
| Brand mark geometry and assets | [docs/brand-c.md](docs/brand-c.md) |
| shadcn/Radix component layers and adapters | [docs/ui-components.md](docs/ui-components.md) |
| Page map, integration order and acceptance gates | [docs/ui-rebuild.md](docs/ui-rebuild.md) |
| Review process and evidence rules | [docs/ui-design.md](docs/ui-design.md) |

When this document and an implementation disagree, fix one of them in the same change. Historical visual experiments are not part of the source distribution.

## 1. Principles

1. **Current work first.** Chrome is quiet so that tasks, replies and results carry the page.
2. **One meaning per signal.** Indigo means "you can act here or this is selected". Status colors mean state. A rule means "rows of one list". Nothing is decorative.
3. **Same anatomy everywhere.** Every module page has the same edge, header, toolbar and list behavior, so moving between pages never shifts the layout.
4. **Respect saved preferences.** Mode, palette, fonts, size, radius, density and backgrounds the user chose are never reset to make a screen match.
5. **Evidence over claims.** Successful execution is not acceptance; a passing test is not visual approval.

## 2. Brand

The mark is the C six-petal open-space mark (geometry in [docs/brand-c.md](docs/brand-c.md)). It is monochrome and follows heading text (`--brand-accent`) in every theme, independently of the interaction accent. Brand assets keep their authored geometry at small sizes. Do not reintroduce a red brand accent or tint the mark indigo.

## 3. Color

Surfaces are cool neutrals with a slight blue bias: light gray and white in light mode, cool charcoal in dark mode. No cream, yellow or warm-gray canvas. Indigo is the single interaction accent.

### Roles (built-in Mandala Light / Mandala Dark)

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Canvas | `--bg` | `#f7f8fa` | `#121317` |
| Sidebar / recessed panel | `--panel` | `#f0f1f4` | `#0e0f12` |
| Content / popover | `--surface` | `#ffffff` | `#18191d` |
| Hover / raised | `--raised` | `#eceef2` | `#1f2126` |
| Primary text | `--text`, `--heading` | `#1b1d22` | `#e4e6ea` |
| Secondary text | `--muted`, `--subtle` | `#5d616a` | `#989ca5` |
| Control outline | `--border` | `#d9dce2` | `#2e3138` |
| Divider | `--border-soft` | `#e7e9ed` | `#23252b` |
| Strong outline | `--border-strong` | `#9a9ea7` | `#4d515a` |
| Selected background | `--accent-bg` | `#ebedfb` | `#1f2240` |
| Interaction accent | `--accent`, `--button`, `--link` | `#4f5ae6` | `#7c86ff` |
| On accent | `--button-text` | `#ffffff` | `#000000` (computed for contrast) |
| Focus ring | `--focus` | `#5a64ea` | `#8a94ff` |
| Brand mark | `--brand-accent` | `#1b1d22` | `#e4e6ea` |
| Success | `--success`, `--status-active` | `#168a4e` | `#4ccb85` |
| Running | `--status-running` | `#285ca7` | `#91baff` |
| Pending / review | `--warning`, `--status-pending` | `#a0650b` | `#e2ac4c` |
| Danger | `--danger` | `#cf3a3a` | `#f07575` |
| Backdrop | `--scrim` | `rgb(8 9 12 / .45)` | same |

Values are the authored baseline at contrast 50. Built-in palette IDs `mandala-light` and `mandala-dark` are stable; changing their values updates everyone who uses them.

### Rules

- **Indigo** marks interaction only: primary actions, the focus ring, selected tabs, selected rows (`--accent-bg`), links and active switches. It never fills large areas, outlines ordinary structure, or colors emphasized text. Emphasized text uses `--heading` or `--text`.
- **Status colors** communicate state, never decoration, and always pair with an icon or text.
- **Content tones** are the only fixed colors outside the palette: code syntax, diff lines, and Memory layer kinds (facts, scenes, stable context). A Memory tone appears on that layer's icon, type label and filter; it never colors list borders or backgrounds.
- **Contrast.** Runtime derivation keeps semantic text at ≥ 4.5:1 against canvas, panel, content and raised surfaces. Contrast preferences adjust secondary text and control borders. Backgrounds behind content require a readable overlay.
- **Custom and imported palettes** derive surfaces and readable semantic colors from their own values. Only built-in Mandala palettes use authored chrome values.
- **Elevation.** Neutral offset shadows (`--overlay-shadow`) are for elevated overlays only; ordinary structure uses borders or surface steps.
- Selection, caret, scrollbar and focus styling follow semantic roles, and every portal inherits the document-root roles.

## 4. Typography

### Fonts

| Role | Default | Notes |
| --- | --- | --- |
| Interface | Geist, then PingFang SC (macOS) / Noto Sans SC | Inter remains selectable; saved choices are kept. |
| Code | Geist Mono | System mono, Menlo and Monaco remain selectable. |

Monospace is reserved for code, paths, identifiers and data that must align. Tabular figures apply only where digits align (counts, times, table columns), never globally. No decorative serif on operational surfaces. Chinese prefers native PingFang SC when available.

### Type roles

Sizes derive from the saved UI size (`--theme-font-size`, 13px by default) so every surface scales together.

| Role | Token | Default | Use |
| --- | --- | --- | --- |
| Metadata | `--type-meta` | 12px (UI − 1) | timestamps, counts, row context, hints |
| Interface | `--type-ui` | 13px | controls, navigation, lists, sidebar |
| Reading | `--type-body` | 14px (UI + 1), line height 22/14 | chat messages, composer, task descriptions and criteria |
| Section heading | `--section-heading-size` | 15px / 600 | sections inside a page |
| Page heading | `--page-heading-size` | 20px / 1.25 / 600, tracking −0.02em | `PageHeader` title |
| Chat entry heading | `--chat-heading-size` | 24px | new-chat start screen |

- Weights are 400 (regular), 500 (`--weight-medium`) and 600 (`--weight-heading`). No intermediate weights.
- Source documents (Library reader, previews of user files) keep their own reading scale (15px / 1.75); operational text uses the reading role above.
- Keep 8px between chat paragraphs and a reading measure of about 65–75 characters.
- Headings never crop long Chinese or English titles; they wrap.

## 5. Space, shape and density

Spacing ramp: 4 / 8 / 12 / 16 / 24 / 32px.

| Token / use | Compact (default) | Comfortable |
| --- | --- | --- |
| Control and navigation minimum height | 32px | 36px |
| Control / panel radius | 8px (saved radius) | saved radius |
| Dialog radius | ≥ 8px | ≥ 8px |
| Workspace radius | ≥ 12px (0 when the saved radius is 0) | same |
| Card padding | 16px | 24px |
| Page gutter `--page-gutter` | 20px (16px below 600px) | 24px |
| Primary / secondary action padding | 5px 10px | grows with content |
| Input padding | 5px 9px | grows with content |
| Navigation padding | 5px 8px | grows with content |
| Application chrome height | 44px | 44px |

Small marks may use fixed radii: 4px for inline code and badges, 50% for status dots and avatars. Compact density does not scale the whole application: touch targets expand to 44px on coarse pointers, and long-form content keeps its reading size.

## 6. Layout

### Shell

- Desktop main content and the inspector sit inside an 8px inset on the canvas with the workspace radius; mobile content is edge to edge.
- On macOS the content card runs to the top of the window, as on the site: the traffic lights and the sidebar toggle float over the sidebar's top band, page and chat controls stay in the content's own header, and empty chrome drags the window. With the sidebar collapsed the card keeps a 40px band for them.
- **Chat context.** A chat's context lives in one place: a top-right trigger (branch icon with `+/−` changes, or "上下文"; a glowing dot while running) opens a 320px popover that also summarizes the side panel — Workspace (folder, changes, worktrees made here), Tasks, every Source (memories with their delivery state) and Capabilities (skill/MCP counts, instructions). Section labels are `--type-meta` muted with no counts, rows `--type-ui`. The side panel holds only tools — 能力 (with instructions and available sources) / 文件 / 改动 / 终端 — stays collapsed until asked for, and opens documents in a reader with a close control rather than a tab. The account menu opens with the person (avatar, name, status; it opens the account page), then one separator, then unpinned modules and Settings.
- **Sidebar.** Destinations use primary text; the chat list beneath them uses regular-weight titles with muted context, so navigation reads above the list it contains. One footer user menu holds unpinned modules, followed by a separate Account and Settings group; there is no second More menu. Collapsing removes the sidebar from layout entirely (macOS keeps the toggle in the native titlebar; browsers show an inline expand control). Saved pin order and sidebar width are kept.
- **Chat** keeps its full workspace; the reading column grows with the window from 760px to 880px.

### Canvas tiers

`WorkspacePage.width` supports exactly three tiers:

| Tier | Maximum width | Surfaces |
| --- | --- | --- |
| `compact` | 960px | Settings (all subpages), Project / Agent details (all tabs) |
| `standard` | 1240px | Project / Agent directories, Market, Memory, Schedules, Usage |
| `fluid` | 100% | Tasks list / board / detail, Library list / detail |

A module's tabs keep the same tier. Bounded canvases center and shrink on narrow screens. Do not add another page-level width cap in a local stylesheet; dialogs, sidebars, controls and reading measures are internal constraints, not tiers.

### Page anatomy

Every module page reads the same way:

1. **One content edge.** Header, toolbar, rows and cards start at `--page-gutter` on every tier. A `standard` canvas only caps the width; it never adds a second inset.
2. **Header.** One shared `PageHeader` holds the icon, title, count or context, the page's primary action and the mobile sidebar entry. Do not repeat the module name in a separate location strip.
3. **Toolbar.** Search and filters sit directly below the header. Search fields carry their icon inside the field outline.
4. **Space, not rules.** No rule under the header or the toolbar.
5. **Rules belong to lists.** Rows of one list are separated by a `--border-soft` hairline between rows only, none above the first row or below the last. Section breaks inside a page also use `--border-soft`; `--border` is for control outlines.
6. **Cards** group only meaningful bounded content (Market items, change groups). No card nested in a card for visual separation.
7. Settings uses the shared horizontal content navigation. Object breadcrumbs carry a real source or parent relationship. Detail views keep a reachable sidebar entry and configuration save feedback.

## 7. Components

Build on the source-owned shadcn/ui Radix foundation, Tailwind CSS 4, Mandala semantic roles and the shared business components (contracts in [docs/ui-components.md](docs/ui-components.md)). Do not add component-local palette constants or a second control system.

- **Buttons** expose hover, focus, pressed, loading, disabled and destructive states. One primary action per surface.
- **Fields** have visible labels and validation; placeholders never replace labels.
- **Select, Disclosure, Dialog, Popover** use the shared components, keep focus management and Escape, and stay inside the viewport.
- **Focus** is a visible 2px outline, never a color-only change.
- **Selection.** Navigation selection (sidebar destinations, section navigation, object tabs, Market tabs) uses the neutral `--raised` surface without an underline. Panel tabs (`ui-tabs`: inspector, Mandala panel, theme variants) use a 2px `--accent` underline. `--accent-bg` marks a selected item inside a list or picker. View switches (list / board, mode) use `SegmentedControl`.
- **Status marks next to text** share the text's centre line; counts beside marks use tabular figures.
- **Icons** come from the shared Icon system: 24px grid, 1.8px stroke, normally 16px. Icon-only controls have accessible names. Icons and text align optically and do not shrink out of long rows.
- **Status** combines a mark and text. Filled status markers use cutouts: color names the state family and the cutout names the exact state (to do: ring; queued: clock; running: play; needs attention or approval: exclamation; awaiting review: clock in amber; replied: return arrow; completed: check; cancelled: dash; failed: cross).
- **Provenance and references** use concise labels with expandable detail; never stack paragraphs of implementation detail on operational pages.
- **States.** Loading, empty, error and offline states preserve drafts and name the recovery action. Use one of these forms:
  - *Loading*: `LoadingState` skeleton rows for a region that is reading; never block content that is already ready.
  - *Page or list empty*: `EmptyState` — a 20px muted icon beside a `--type-ui` / 500 title, a one-line `--type-meta` explanation and an optional action, left aligned on the content edge.
  - *Narrow panel empty* (popovers, inspectors): the same parts, centred.
  - *Section empty* (a column, a run history, an association list): one muted `--type-meta` line without an icon.
  - *Filtered empty*: one dashed box under the filters ("当前筛选下没有任务") with "清除筛选"; each active filter chip has its own ✕.
  - *Field or form error*: `--danger` text in `--type-meta` next to the control or submit action.
  - *Region error*: the message and its recovery action (重试, 重新读取) on one row; the rest of the page stays usable.
- Respect reduced motion.

## 8. Patterns

### Chat: speech and objects

Bubbles are speech; bordered cards are objects. The rule is the same in every chat; only the speech layout differs by chat kind.

- **Mandala primary chat** coordinates many Agents, so speech uses bubbles. The human message aligns right on the accent tint (`--accent-bg` with `--text`), so a custom palette's accent carries through without a saturated block; Mandala and Agent replies align left on a neutral fill. A structured reply (heading, list, code block or table) is a document: it drops the fill and reads unboxed. Bubble radius is four times the saved control radius, capped at 24px; an explicit zero radius stays square. The Mandala chat is one continuous conversation and offers neither Fork nor message editing.
- **Ordinary one-to-one chats** keep the document layout: a labelled human message card, an Agent header with avatar, and unboxed answer text.
- **Changes are objects.** Everything a turn changed (Tasks, schedules, deliverables, Wiki, Skills) appears once under the reply as one bordered group, "本轮改动 · N", one line per object: what happened (新目标, 已分派, 已取消…), its name, its live state and ›. Task lines use the Task row vocabulary and open the Task dialog; a Task appears once per chat at its first operation and later operations update that line in place. A Task the chat cannot read shows only what happened and its name, never a stale state. Agent request text never appears on the line. The group's radius is half the bubble radius (capped at 12px).
- **Receipts remain Agent speech.** A returned result is the Agent's bubble, tagged with a link back to its Task; the footer carries run state, time and the execution link. Operation receipts keep their visual header when expanded, with real Agent avatars and Project identities.
- **Folding.** A card folds only when its fold holds real content. A question awaiting the user (需要你的决定) is flat with the question visible; a pending configuration proposal starts expanded with its confirm action visible. Tool activity defaults to folded; current approvals, questions and errors stay actionable without expansion.
- Process disclosures and action bars sit outside text bubbles in the same 12px muted line style above and below the reply. Turn time reads 「1 分 18 秒」 in the UI font. Parts of one turn sit 8px apart.
- Inline code in prose is a light tint (`--text` at 6%) with a 4px radius, not a raised pill.
- Markdown uses CJK-friendly emphasis (`remark-cjk-friendly`), so `**…。**后文` renders as emphasis instead of literal asterisks.

### Tasks

- **No subtask layer.** A Task directly owns its execution Chats; the delegation brief lives in the Chat. Acceptance happens only on the Task, and goal acceptance stays distinct from Run success and message replies.
- **One row layout everywhere:** title and status, then people and Project with an `Execution chats N` disclosure on the same line. Desktop rows target 54px when content fits; wrapping and accessibility win over a fixed height. A Chat without a title shows its request preview.
- **Lanes follow what the user does next:** 需要你处理 → 待验收 → 进行中 → 待办 → 已完成. An execution Chat awaiting approval, needing a reply or failed lifts an unfinished Task into 需要你处理 with one reason line and the action that resolves it; completed and cancelled Tasks stay put. Grouped rows carry no status label (the lane says it); they end in one mark per execution Chat plus the count. The status label stays in chat cards, the detail dialog and search results.
- **Detail is one dialog.** Opening a Task from anywhere shows the same centred dialog over the current page; the page behind neither reflows nor loses its scroll. ‹ › and ←/→ step through the Task links visible behind it; Esc closes. `/tasks/:id` opens the Tasks page with the dialog; elsewhere the dialog offers "在任务页打开". Full screen below 640px. Execution chats appear directly under the title and actions, expanded, ahead of criteria and deliveries. Task text uses the reading role.
- Discrete task segments show actual Task states and completed counts; they never infer a goal percentage or acceptance.
- The execution-rules section on Tasks is absent when no rule exists and titled "执行规则 N 条" otherwise; up to 8 rules list without search or filters.

### Settings

- Language comes first, with English first in the built-in list. Fresh installations and context fallback use English; saved language choices are authoritative.
- Settings and object settings (Project, Agent) are forms: groups are unboxed sections with a section heading, separated by a `--border-soft` rule, with no card frame and no card inside a group. Overview pages keep their bounded summary cards.
- General setting groups share 16px / 600 headings and one left edge, without decorative heading icons. Display mode and Colors and background are 14px / 500 subsections of appearance. Background image lives in the theme group and is part of theme import/export.
- Routine automatic-save banners are hidden; active file reads and unsaved or error recovery stay visible.

### Library and Memory

- Library rows show kind, version, source and sharing as plain metadata; the filled sharing chip appears only in the detail header.
- Library rows show a status only when it differs from the normal readable case (missing content, source unavailable, host reference, unpublished); available resources show just their date.
- Memory layers keep one fixed tone each (see Color rules).

## 9. Domain icons

Agent uses Lucide Bot, distinct from the human account silhouette. Project uses the approved folder-with-list symbol; plain folders remain filesystem objects. Market uses Store, Memory Brain, Usage ChartColumnIncreasing and Schedules CalendarClock. Project identities offer 24 searchable symbols for code, infrastructure, knowledge, design and delivery. Saved symbols and identity colors are kept; an unset icon uses Project. Agent and Project identity colors are recognition aids, not chrome: they stay in the sidebar and lists so that people can find an Agent at a glance, and future icon or emoji identities follow the same rule.

## 10. Preferences and compatibility

- New installations: system light/dark mode, Mandala Light / Mandala Dark, Geist and Geist Mono, 13px UI and code text, 8px radius, compact density, contrast 50.
- Valid saved preferences are never migrated or reset: mode, built-in or custom palette selection, custom palettes, fonts, sizes, radius (including zero), density, contrast and backgrounds. An explicit legacy light or dark choice is kept.
- Theme export/import keeps its versioned `mandala-theme` contract.

## 11. Verification

**Automated guards** (`tests/ui-design-contract.test.ts`) fail on:

- native `select`, unmanaged `details` and arrow characters used as navigation icons;
- literal 12–14px font sizes or weights other than 400 / 500 / 600 in product stylesheets;
- hex colors outside `src/ui/tokens.css` and the content-tone stylesheets (a hex is allowed only as a `var()` fallback);
- any border on `PageHeader`.

`tests/themes.test.ts` checks the palette roles, contrast, defaults and preference round trips.

**Live reference.** `ui.html` (with `npm run dev`, open `http://127.0.0.1:4174/ui.html`) renders the color roles, type roles, status marks, selection model and state forms from the same tokens as the product, followed by the shared controls and a page composition. Update it in the same change when a foundation in this document changes; it is evidence for components, not acceptance of product pages.

**Rendered review.** `npm run review:screens` captures every main page on synthetic e2e data in light and dark (`--widths 1440,768,390` for narrow layouts, `--a11y` for axe-core WCAG 2.1 AA checks, `--only tasks,library` to narrow) and writes `output/review-screens/<time>/index.html` with console errors and failed requests per screen. Run it before and after a visual change. Known, accepted axe findings: `label-content-name-mismatch` on sidebar chat rows (the name is the title; project and state are the description) and palette miniature code samples for third-party palettes.

Review is required for each changed module, independent of tests: light and dark; 1440 / 1024 / 768 / 390px; system zoom; keyboard and Chinese input; long content; empty, loading, error, offline and permission states; portals. Verify real data and the installed desktop app separately. Screenshots name their source worktree or build, and stale screenshots are not evidence. A component catalog is evidence for components, not acceptance of untouched pages. Reopen and fix any issue found in review before delivery.

## Change log

| Date | Change |
| --- | --- |
| 2026-11-05 | Design system rewritten as one current document. Visual language v2: cool neutrals, indigo interaction accent, Geist; system mode by default. Page anatomy, type roles and stylesheet guards. |
| 2026-11-04 | Speech and objects in chat; Task lanes, one Task dialog and execution chats replace subtasks. |
| 2026-11-02 | Operation receipts and shared Task list / Kanban presentation; cutout status markers. |
| 2026-11-01 | Neutral workspace framing and inset; Memory layer tones; general settings hierarchy. |
| 2026-10-29 | Compact C direction and the C six-petal mark replace Graphite Vermilion. |
