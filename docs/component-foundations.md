# Shared component foundations

Historical M2 record, based on main e4ea9cc. The current component contracts are in [ui-components.md](ui-components.md); current visual authority is root DESIGN.md (Compact C). The decisions below describe the earlier native-wrapper migration and do not override the current Radix/Tailwind foundation.

## Design brief

- Operate mode: people configure Agents/projects, inspect work and write conversations. Repeated controls should keep their current meaning, placement and density, while keyboard interaction and feedback work consistently.
- Preserve ThemeProvider palette/font/density/radius preferences, automatic saving, Progress, sidebar behavior and current motion. Components consume existing semantic tokens; no new palette, layout system or form-state framework.
- Native controls remain native: ordinary actions never submit forms implicitly, explicit submissions still submit, refs and input/composition events pass through. Field links visible labels/help/errors while retaining the native label element and caller layout.
- Tabs and mutually exclusive choices support one tab stop, direction keys, Home/End, disabled-item skipping and visible focus. Dialog Escape closes only the innermost overlay and restores its opener. Select retains search by ID and custom model entry.
- Desktop and 390px long-content states, light/dark themes, disabled/busy/error/empty states and neighbouring settings/conversation/task flows form the acceptance scope. Source/tests are not visual acceptance or installed-App evidence.

## Observable cases and derivation

| Case | Condition / action | Required observation | Failure excluded |
|---|---|---|---|
| C1 | Action and submit inside a form | Action leaves submit count unchanged; submit increments once; busy action disabled | implicit submits and lost native semantics |
| C2 | Field with label/help/error and native or Select control | Label focuses control; helper/error IDs resolve; error marks invalid; existing native label layout is retained | unnamed/unrelated error and changed field layout |
| C3 | Tabs/radio group with a disabled middle option | Arrow/Home/End select and focus enabled options; only active option is a tab stop; panel labels resolve | ARIA-only controls and keyboard traps |
| C4 | Outer Dialog → nested portal Dialog → Tab/Escape | Focus stays in inner; Escape removes inner only and restores opener; second Escape returns to page | bubbled Escape and focus leakage |
| C5 | Dialog Select → search / select / Escape | Selecting restores trigger; first Escape closes Select only; next closes Dialog | portal key handling regression |
| C6 | Non-search Select → ArrowDown → Enter | Focused listbox exposes active option, selected value updates | visual-only active option |
| C7 | Select search by model ID / custom ID | ID matches remain searchable and custom ID is selected/displayed | loss of current allowCustom functionality |
| C8 | Narrow width, long labels, themes/preferences | Labels and focus remain visible; fields/buttons obey current tokens; no document overflow | clipping and theme/density regression |
| C9 | Existing settings/task/appearance/conversation flows | Save/preview/cancel, task submission, message composition and sidebar controls retain original outcomes | migration changes to product state |

## Test-agent availability

The available tools expose ordinary Playwright browser operations, not official Test Agent planner/generator/healer entry points. Cases above are requirement-derived local planning, then implemented as Playwright behavior assertions. They must not be reported as an official Agents run. An agent uninvolved in implementation will independently review the candidate; browser visual acceptance and full application regressions remain separate evidence.

## Execution record

- Added Button/Input/Textarea/Field/Tabs/SegmentedControl/Notice/EmptyState. 63 business TSX files use the native control wrappers. Native button/input/textarea tags remain only inside their shared implementations and Select. Original form submit buttons retain explicit `type="submit"`; actions default to `button`. No request/polling callbacks were changed by the component migration.
- Meaningful compositions: Settings project/Agent Tabs and panels, language/runtime segments, Theme display-mode segments, Organization view segments, Task creation-mode segments; Field in project creation and Skill registration; Notice and EmptyState in Settings/Skill feedback. Other specialized composites retain their existing behavior.
- Final implementation check: `node node_modules/typescript/bin/tsc --noEmit` passed after the last PersonalAccess migration. `git diff --check` passed. Shared-control Playwright: **7/7 passed** after current CSS correction; output is separate in `test-results-ui/` so application E2E does not erase it.
- Personally inspected `test-results-ui/shared-controls-dark-390.png`: labels, helper/error text, disabled controls and focus ring are visible; long Chinese text fits the 390px viewport. The browser test also exercises light mode and verifies viewport bounds. This is catalog evidence only, not product-page or installed-App acceptance.
- Default Button keeps current native/business styling; only explicit variants add layout. Existing theme, typography, spacing, density, radius and motion definitions were preserved. HEAD had no manually styled `ui-button` business callers.
- Parent owns full latest application E2E and independent Settings/Progress/conversation visual review against the frozen candidate. These remain required for M2 release; passing the catalog cannot substitute for them. Official Test Agents remain unavailable as noted above. No commit, release, packaging or installation performed.

## Counterexamples and disposition

| Perspective | Counterexample | Disposition / evidence |
|---|---|---|
| Product | A migrated default button stops login/task submission | Existing implicit submit buttons identified before migration and made explicit; actual application E2E remains mandatory |
| State | Escape from an inner Dialog closes its owner; a custom ID vanishes after selection | Initially failing browser cases now pass; preserve existing Select search by ID and custom-entry implementation |
| Visual | Global button flex changes compact current layouts; Tabs focus is cut off | Default flex removed, explicit-variant only; inset tab focus tested and screenshot inspected; actual-page comparison remains mandatory |
| Engineering | Migration overwrites concurrent request safeguards | Per-file token/import-only patches check current context before apply; final PersonalAccess migration includes latest generation guards; final typecheck passed |

## Adjacent regression fixes found during current-main acceptance

- Progress initial state combines task loading with conversation-progress loading when Tasks are included. A successful empty chat response cannot label pending or failed task data empty. Existing cards stay visible during background task failures; the existing task polling recovers them, while conversation progress keeps its explicit retry. Conversation-only mode does not wait for the unrelated task request. Both pending-task and task-error cases failed against the current source before this fix; four state cases now pass in `tests/e2e/workflow-polish.spec.ts`.
- Narrow organization graph: the existing 176px node was automatically scaled to approximately 123px, reducing a 14px label to approximately 9.8px. At canvas widths below 480px, automatic fit now retains scale 1 and centers the selected (or first) node; users pan to other nodes. Desktop fit remains unchanged. Acceptance checks actual 176px node width, 14px rendered label, pan movement and recentering; 390px failed before and passed afterward, alongside unchanged 1080px/1440px checks.
- Tests follow current main contracts: new unsaved Task creation allows external navigation and browser Back (41c0162), while saved Task edits and child drafts retain protection. Progress uses three lanes with vertical mobile flow and contextual detail expansion. Model selection retains custom-entry helpers, and keyboard shortcuts follow the current operating system. Selector/fixture corrections preserve behavioral and persistence assertions.
- Source and test checks are candidate evidence; independent review, current product-page inspection and the final complete suite remain release gates owned by the parent task.
