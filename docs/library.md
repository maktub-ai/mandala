# Library

Library lists resources the current user can read. `/library` and `/library/:id` are canonical; existing `/assets` URLs retain their version, page, Project and Agent queries.

A Project scope combines authorized usage bindings and execution provenance. For ordinary resources and historical Agent Wiki this does not imply Project ownership. New Project Wiki explicitly persists Project ownership independently of these usage bindings. Removing an association removes only that binding; it neither deletes the resource nor changes its owner or access policy. Personal imports remain user owned. Agent associations reference existing Agent identities.

A pinned association opens its exact version. An unreadable or missing pinned version never falls back to the latest version. Source labels use the selected version's provenance; historical versions without sufficient source metadata show a neutral historical-source label. The reader explicitly distinguishes a Project's pinned reference from another version selected in its URL.

## Reading and editing

The reader keeps version selection and available editing actions above the document. Source evidence, access, associations and maintenance remain inspectable in separate disclosures. Wiki citation presentation may collapse generated evidence and map historical workspace links for navigation; immutable version bytes remain unchanged.

Only a single UTF-8 file up to 1 MiB is editable through the ordinary document editor. Publishing uses the captured expected head version and a stable publication key. Failed publication preserves input. Reading the latest version does not overwrite input; adopting it as the new base also adopts its filename and source-version provenance. Other formats retain preview and fixed-version download actions.

Wiki pages use the Wiki page API and its expected head version; access policy uses the independent Asset revision. Wiki generation requires an eligible Project maintainer using a supported generation runtime (currently Codex or OMP). Overview pages are read only. Restoring a Wiki version rebuilds from current authorized sources rather than silently changing the head pointer.

Dirty and busy editors guard application navigation and browser unload. Library editing does not claim durable offline document drafts. Losing source permission clears protected reader content and editing state. A usage binding never grants source permission.

Imports retain their staged submission and publication key after a lost response. A failed scoped association can be retried without creating another resource. A successful import is distinct from successful Project association.

## Project Wiki ownership and maintenance

New Wiki belongs to one explicit Project (`ownership: project`, Asset `owner.projectId`). A Chat with that Project and no Agent can create, save sources, read and edit Wiki. The host binds its Project and original Agent identity to the invocation; arguments cannot change them. Each call, replay, source read and publication rechecks the current Project, Agent membership (when present), Chat identity and active invocation. Missing Project creation asks for a selection rather than guessing an Agent or Project.

Maintenance is an optional execution responsibility. It must name a current Project member running enabled Codex or OMP. Creation never selects one implicitly. `maintenance` reports ready, unconfigured or unavailable; absence does not prevent knowledge or source storage. Generation needs a valid executor. Changing/removing it is revision guarded, cancels old reception epochs and never changes ownership or grants. Source generation, version CAS and restoration retain the existing immutable version contract.

Sources must be available to the owning Project (or all users of the local workspace) and the caller; a maintainer's private assets cannot become shared Project knowledge. New imports from the Wiki reader are explicitly granted only to its Project. Owning Project membership is intrinsic: the owning binding cannot be removed or changed, listing uses owner.projectId even if a binding is missing, and another Project/Agent association cannot be added. Ordinary resources and legacy Wiki retain removable associations. Project Wiki access cannot be broadened with the generic asset sharing/maintenance-owner controls.

Reception starts off. Enabling it explicitly shares only future outcomes from the chosen maintainer's conversations in this Project. Other Agents, other Projects and pre-enable rounds are excluded. New evidence has an explicit `sharedProjectId`; old evidence is never reinterpreted. Conversations containing Memory-history references or inherited Task contexts are rejected for Project sharing until an independent Project-level authorization contract exists. Unresolved or pending attachment history is refused, never interpreted as having no dependencies. All acknowledged native-history file versions and inherited attachment sources are reauthorized for the Project, persisted as supporting versions, and rechecked on derived reads; a later round cannot launder an earlier private file by omitting its reference. Supporting file versions still need Project permission. This conservative boundary leaves Agent Memory private; it does not grant readers direct access to a private source Chat. Source identity, events, membership and permissions are rechecked before generation, publication and every derived read.

Policies without `ownership: project` retain historical Agent ownership, original access settings, fixed-version URLs, source checks and reception semantics, including when already associated with a Project. There is no automatic data reassignment or grant migration. The new model is additive JSON; rollback requires the pre-upgrade HOME backup because old code cannot operate new Project Wiki. Legacy mutation reservations are replayed with their original key after authorization; new reservations are Project-scoped. No historical key may silently repeat a mutation.
