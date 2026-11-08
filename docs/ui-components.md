# Mandala component contracts

The component foundation is source-owned [shadcn/ui](https://ui.shadcn.com/docs/installation/vite), generated with the `radix-nova` preset, backed by Radix and Tailwind CSS 4. `components.json` records the source configuration. `package-lock.json` pins the installed dependency tree. Generated files in `src/components/ui` are adapted code, not an unmodified vendor directory.

## Layers

1. `themes.ts`, `ThemeProvider` and `ui/tokens.css` define saved appearance and fallback semantic tokens.
2. `ui/tailwind.css` maps shadcn color/radius roles to those tokens. PostCSS compiles utilities for both normal Vite and the source E2E server. No Tailwind preflight is applied to historical Markdown or document content. Dark selectors use the existing `data-theme` attribute.
3. `components/ui` contains Radix primitives. `ui/primitives.css` applies Mandala dimensions and native-control rules. Portal content inherits document-root tokens.
4. `ui` contains compatibility controls and business compositions. Existing callers retain their prop/event contracts; page logic owns navigation, permissions, data and mutations.

## Public controls

| Component | Contract |
| --- | --- |
| `Button` | Native button props/ref; defaults to `type="button"`. `primary`, `secondary`, `ghost`, `danger`; `sm`/`md`; `busy` disables and announces work. Icon-only actions need an accessible label. |
| `Input`, `Textarea` | Native controlled/uncontrolled values, refs and change events. Text inputs use shadcn. Checkbox/radio/range/color retain their native geometry and event contracts. Textareas preserve `rows` and manual resizing. |
| `Field` | One child control connected to a label, existing help IDs, optional hint and validation error. Does not replace a caller's explicit accessible name. |
| `Select` | Controlled string value, options, onChange; value/label/description search, custom IDs, empty string values and disabled options remain supported. Radix Popover owns placement/dismissal/focus boundaries; the existing searchbox/listbox keyboard model preserves public semantics. IME Enter/Escape cannot select or dismiss while composing. |
| `Tabs` / `TabPanel` | Controlled selection; disabled choices skipped; arrows wrap in the displayed orientation. Existing external panel IDs remain linked. The route owner controls actual panel content. |
| `SegmentedControl` | Controlled mutually exclusive options and disabled states; keyboard selection and explicit group semantics. |
| `Dialog` | Existing controlled lifetime (`label`, `onClose`, `locked`, `className`, children), plus optional `initialFocus` ref for workflows such as command search. Radix owns modal focus; only the innermost Escape closes. Locked/composing states protect dismissal. Close restores the original opener, including a picker return target. Business widths, padding and full-screen/drawer geometry override low-specificity defaults. |
| `Notice`, `EmptyState`, `LoadingState` | Labelled feedback with consistent icons; recovery actions remain caller-owned. A loading skeleton is never a completed page. |

Dialog and overlay share layer 1000, selectors 1500, menus 1600 and tooltips 1700. Nested dialogs rely on DOM order at the same modal layer. Overlays are neutral; no decorative blur. Fullscreen Mermaid and run/market drawers explicitly cancel centered translation. Do not reintroduce ancestor-dependent modal layout rules: Radix portals render at the document root.

Dialog and Select register their mounted content synchronously with `escape-scope.ts`. This routes Escape once to the actual focused layer when Radix briefly retains an outer document listener during nested mounting. Locked/composing guards and command-palette back-navigation remain owned by that layer. Radix still owns focus containment, positioning and outside interactions; the helper is not a second focus trap.

## Business compositions

- `WorkspacePage` provides the page boundary; it is a section inside the application main region.
- `PageHeader` takes title, icon, optional compact context, actions and toolbar children. Long titles wrap; actions and filters reflow.
- `ListDetail` takes a list and optional selected detail. On narrow screens, selection replaces the list; the caller must provide a labelled return action and preserve selection/filter history. It never chooses or mutates an object.
- `DetailSection` provides a labelled heading with optional icon/actions.
- `MetadataList` displays explicit label/value pairs with optional semantic icons. It does not synthesize missing data.
- `StatusLabel` takes the real domain label, icon and restrained tone. Run success and Task acceptance must use separate labels; visual tone cannot infer completion.

Use these compositions for the actual Tasks, Projects, Agents, Library and Schedules pages. Do not create another local button/tab/heading vocabulary per module. Specialized readers retain their own comfortable content width and type size.

## Verification and maintenance

`/ui.html` is the interactive component catalog, explicitly labelled as local examples. It includes validation, disabled options, long bilingual labels, custom model IDs, nested/locked dialogs, menu/tooltip composition, list/detail switching and feedback states. It is not a product-data demonstration.

Run `MANDALA_UI_PORT=4335 npm run test:ui` on an unused local port. `tests/ui/controls.spec.ts` covers form/keyboard/focus/IME contracts, including focus alone never committing a segmented setting; `workspace-primitives.spec.ts` covers composition and both themes at 1440/1024/768/390px, coarse-pointer targets and browser zoom. Inspect rendered captures as a separate gate. Actual application integration also exercises settings, command palette, market, execution overview and Mermaid fullscreen.

Future shadcn updates should use `add --dry-run` / `--diff` first. Preserve the Mandala adapters and token mapping; do not overwrite the generated files and assume their defaults satisfy saved preferences, legacy viewers or Chinese input. There is no data migration in this component stage.

`Dialog` accepts an optional `returnFocusRef`: a connected, visible target takes priority during the existing close autofocus cleanup; otherwise the original trigger is restored. Callers retain the shared focus trap and Escape behavior.
