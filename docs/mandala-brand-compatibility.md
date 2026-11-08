# Mandala naming and storage compatibility audit

Current product, UI, generated host identity, package identity and primary CLI use **Mandala**. Host instructions do not enumerate former names or invite unsolicited naming history. CLI and desktop share storage discovery; migrated homes use `.mandala`, `.mandala-account-service` and `.mandala-releases`. The package smoke check invokes `mandala.mjs`.

The remaining legacy references are deliberate compatibility or historical identifiers:

| Reference | Treatment and reason |
| --- | --- |
| `.open-mana` and ancillary directory paths | Explicit offline migration retains the complete original as a backup and creates an old-path alias. New managed conversations use the canonical directory. |
| `openmana` executable, `OPEN_MANA_*` variables, old Git configuration keys | Supported aliases; canonical commands and variables take priority. Removing them would break existing scripts. |
| Old cookies, internal HTTP headers, usage events, disabled task MCP names | Mixed-version authentication and protocol compatibility. Current names are primary; old inputs remain accepted. |
| Existing Project/Agent IDs and historical conversation/memory text | Stable identity and source evidence; renaming display branding does not rewrite IDs, quotations or evidence. |
| Native Codex/OMP session names or history containing the old data path | Native history stays at its original location. The legacy directory alias keeps old absolute file references usable. |
| GitHub `MaktubCN/open-mana` and repository checkout folder names | Existing external repository identity, including the installer download link; not a product label or a data-home default. No external repository rename is performed. |
| Dated audit records, fixture names, archived installers and source snapshots | Historical evidence remains accurate and reproducible. Active instructions and current release manifests use current paths. |

The inventory covers active `server`, `shared`, `src`, `desktop`, `cli`, `scripts`, public assets, package metadata, Git hooks/CI, README and operational documentation. Legacy protocol and path compatibility is tested separately from canonical behavior. No global string replacement is used.
