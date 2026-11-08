# Data plugins: themes, language packs and pets

Mandala 0.1.2 introduces unified data plugins through [mandala-plugins](https://github.com/maktub-ai/mandala-plugins). Language packages and their English reference dictionary now live in that repository. [mandala-themes](https://github.com/maktub-ai/mandala-themes) and [mandala-pets](https://github.com/maktub-ai/mandala-pets) remain compatible sources for single-contribution packages. They share Market search, source management, and installed-item views. Packages are data only, have no Agent or Project bindings, and cannot execute code. File preview and editing plugins are outside this interface. Catalogs and pinned packages must be public for Market's unauthenticated downloads.

## Unified plugin protocol (Mandala 0.1.2+)

A plugin is an installation unit; each contribution is applied separately. One plugin may provide themes, languages and pets together. Skills and MCP keep their existing Agent/Project installation semantics. No JavaScript, workers, commands, HTML, arbitrary CSS, install hooks, network permissions or executable entry points are supported.

`mandala-plugin.json` uses an explicit schema version and a separate release version:

```json
{
  "format": "mandala-plugin",
  "schemaVersion": 1,
  "execution": "data",
  "id": "studio",
  "name": "Studio",
  "description": "A theme and a translation",
  "version": "1.0.0",
  "minAppVersion": "0.1.2",
  "contributes": {
    "themes": [{ "id": "paper", "path": "theme.json", "sha256": "<64 lowercase hexadecimal characters>" }],
    "languagePacks": [{ "id": "french", "path": "language.json", "sha256": "<64 lowercase hexadecimal characters>" }]
  }
}
```

`contributes.pets` uses the same reference shape. Payloads retain the theme, language and [pet](#pets) formats below; do not invent another translation or pet schema. Unknown manifest fields, contribution types, duplicate IDs within a type, duplicate paths and non-JSON paths are rejected. There are at most 50 contributions per plugin. Paths are relative to the repository root, not the manifest's folder. Keep the manifest at the root when using the local validator:

```sh
node --import tsx scripts/validate-data-plugin.ts /path/to/package
```

The unified `catalog.json` is `{ "format": "mandala-plugin-catalog", "version": 1, "items": [] }`. Each entry has the same metadata and `package` reference as the legacy catalog below, plus `kinds`, a non-empty unique array drawn from `theme`, `language`, `pet`. `package.path` points to `mandala-plugin.json` (optionally in a folder). Its digest covers the manifest's exact bytes. Metadata (`id`, name, description, release version, minimum version) and kinds must match the manifest. Commit the manifest and payloads first; then publish the entry with that real 40-character commit and manifest checksum. Every payload is fetched from that same repository and commit and verified against its own checksum. The **entire download**, including the manifest, must fit within 4 MiB. Publication checks are local; no cloud CI/CD is enabled.

An install, update or uninstall affects the complete plugin. All checks finish before an atomic save; a failed download, version check, duplicate locale, checksum, size limit or stale revision leaves the prior installation unchanged. The 50-package / 20 MiB HOME limits include legacy packages. Installing never applies contributions automatically. Plugins have no access to task content; pet state remains controlled by Mandala.

Identity is `plugin:<catalog-owner>/<catalog-repository>:<id>`, with contribution IDs ending in `/theme:<id>`, `/language:<id>` or `/pet:<id>`. This binds identity to the catalog origin, rather than trusting a display publisher name. Changing the package repository of an installed identity is rejected; removal and explicit installation are required. Different catalog origins cannot overwrite each other, and local pet imports retain their separate identity. Duplicate installed language locales are rejected even across origins and legacy packages.

Manage sources accepts canonical GitHub plugin repositories; their `main/catalog.json` must use the unified format. Saved enabled/disabled selections are preserved. Removing or disabling a source does not remove installed plugins, and offline application/uninstallation remains available. Private catalogs are prepared for launch but anonymous Market downloads cannot read them. No credentials are stored in catalogs or added to package requests.

### Compatibility and rollback

Legacy catalogs and packages are still parsed without rewriting their IDs. Reading an existing v1 installation store does not write or migrate it; legacy theme copies, selected locales, pet IDs, local imports and device preferences remain intact. The market's Plugins filter includes these single-contribution packages. The saved `mandala-languages` source ID and enabled/disabled choices remain valid: browsing it now reads language plugins from the unified catalog, with duplicate cards removed when both sources are enabled. Legacy language IDs still resolve through `mandala-plugins/catalogs/languages.json`; updating them keeps their IDs and v1 data while fetching the package from the new repository. New language installations use the unified plugin identity.

The official `arabic-starter` is a reviewed migration exception: explicitly installing `plugin:maktub-ai/mandala-plugins:arabic-starter` atomically replaces its legacy `language:arabic-starter` record only when it comes from the original personal repository, the organization language repository, or the relocated compatibility package. Both must provide locale `ar`, and the plugin must come from the official catalog and package repository. Download and checksum checks complete first. Other publishers, catalogs, locales and installed packages cannot be replaced by this exception. The locale preference is unchanged, so an active Arabic translation remains active. Reading alone never migrates data.

The old [mandala-language-packs](https://github.com/maktub-ai/mandala-language-packs) repository remains a compatibility entry point for older applications. Its catalog now pins the payload in `mandala-plugins`. Older binaries and fixed old commit URLs still depend on the old repository; do not delete it until those consumers are retired and the owner confirms deletion.

The store becomes v2 only while it contains new plugins, with legacy `items` retained separately from grouped `plugins`. Consumers receive a flattened, validated contribution view. Older applications reject v2 rather than silently dropping plugin data. To downgrade, uninstall new plugins in the newer application first; the next save returns to v1. Applied theme copies remain; removing the active language/pet restores English/the official figure. Do not overwrite the store manually.

## Authoring and contribution

- **Themes:** customize and export a `.mandala-theme.json` file in Settings, preview it with the existing Import action, then submit a package-file PR. Follow the [theme contribution guide](https://github.com/maktub-ai/mandala-themes/blob/main/CONTRIBUTING.md).
- **Languages:** use the English reference dictionary, preserve its source keys and placeholders, and put translations in a `.mandala-language.json` file. There is currently no visual translation editor or local language-file import action. Follow the [language plugin contribution guide](https://github.com/maktub-ai/mandala-plugins/blob/main/docs/languages.md).
- **Publication:** maintainers first merge and validate the package, then publish a catalog entry referencing the actual existing commit and exact file checksum. A package-file PR alone does not list a package in Market. Authors may alternatively host packages in their own public repositories and submit catalog-only PRs.
- **Repository language:** documentation, contribution instructions, PR descriptions, commit messages, and catalog descriptions use English. Native language names and translation values use their target language. Chinese source-message keys are required identifiers in the current format and must remain unchanged.

The catalog repositories include English README files, contribution guides, and PR templates. Review and validation run locally; no automatic cloud CI/CD is required.

## User behavior

- Installation saves a package without changing appearance or language. Applying it is a separate action.
- Applying a theme imports its palette, font choices, density, and background while preserving other custom themes. Uninstalling retains the applied appearance copy; it can still be edited or removed in Settings.
- Applying a language pack changes the device's UI language and `lang` / `dir`. Missing translations fall back to English, while code and terminals remain LTR. It does not change Agent response language, memory-processing language, or existing content.
- Installed packages live in `market/ui-extensions.json` under the selected Mandala HOME and are discoverable through that service. Application preferences use the existing device preference storage. This does not provide account synchronization.
- Installed packages can be used or uninstalled without GitHub access while the local service is available. Opening a current catalog entry from Browse checks for updates; installation is explicit, not automatic. Updating an active language pack refreshes its translations; an updated theme must be applied again.
- Uninstalling the active language pack falls back to English. A local service read failure preserves the language choice so it can resume after reconnection.
- Existing saved Market source choices are preserved. If a category is missing, enable its catalog in Manage sources. Once maintainers publish an entry to the catalog's `main` branch, reopen Market to browse it; an App rebuild is not needed for each new package.

## Catalog and package protocol

`catalog.json` declares `format: "mandala-catalog"`, `version: 1`, `kind: "theme" | "language" | "pet"`, and `items`. Each entry contains `id`, `name`, `description`, `publisher`, `version`, `minAppVersion`, and `package`. The package reference contains a GitHub `repository`, full 40-character commit `revision`, relative JSON `path`, and `sha256` of the original file bytes. Commit packages before publishing catalog references; never refer to a future SHA. The initial implementation downloads JSON from fixed commits without Release redirects.

Release versions use `x.y.z`. Raise the entry's version and update the digest and revision for each package release. These release versions are separate from the catalog and package schema versions. Limits are 500 catalog entries, 4 MiB per package, and 50 installed packages totaling at most 20 MiB per HOME. Applied themes retain the existing limit of 20 custom themes. Runtime checks reject unsupported minimum versions, invalid paths, checksum mismatches, duplicate installed language locales, and invalid formats. Older builds with the same `0.1.1` version may predate this feature, so that number alone does not prove support.

Themes reuse `mandala-theme` v1. `shared/themes.ts` provides validation shared by browser and server; `src/themes.ts` retains compatible exports.

A language package looks like this (Chinese source keys are part of the protocol):

```json
{
  "format": "mandala-language",
  "version": 1,
  "locale": "ar",
  "name": "العربية",
  "direction": "rtl",
  "messages": { "市场": "السوق", "安装 {name}": "تثبيت {name}" }
}
```

Preserve placeholders. Built-in `en` and `zh-CN` cannot be replaced. Translations are text, not interpreted HTML, CSS, or scripts. Export the static reference dictionary with `node --import tsx scripts/export-language-template.ts /tmp/messages.en.json`. Some dynamically constructed keys contain runtime content and cannot yet be translated comprehensively; these should gradually move to stable keys with placeholders. The Arabic starter is partial and has not been reviewed by a native speaker.

`direction` describes the language's writing direction. RTL packs preserve the existing sidebar, drawer placement, control order, and alignment. Text resolves its own reading order, including English fallback; code, terminals, URLs, and email fields remain left-to-right. Installing a language pack does not mirror the application layout.

## Verification

Unit tests cover catalog boundaries, pinned download URLs, checksums, version changes, storage conflicts, offline reads, language placeholders, and fallback behavior. Browser tests cover installation, explicit application, persistence, RTL, and uninstall, alongside Skills/MCP and theme-setting regressions. Maintainers should also verify published entries in an isolated App profile. Do not commit personal data, credentials, or real-user screenshots.

## Pets

The Mandala pet sits at the top of the Mandala side panel and, in the desktop app, can pop out to a small always-on-top window. The official figure is the Mandala mark itself; petal motion and colour carry the state, and its colours follow the theme. A pet package replaces the figure with one image per state. Pets use the same catalog protocol with `kind: "pet"`, published from [mandala-pets](https://github.com/maktub-ai/mandala-pets), and can also be imported from a file in Mandala settings. Imported pets stay on this computer and are stored beside Market installs.

States are derived from recorded execution data, never from a model summary. When several apply, the first one in this order wins, so work waiting for the person is never hidden behind running work:

| State | Shown when | Required |
| --- | --- | --- |
| `waiting` | A chat waits for approval, or a task waits for input or review | Yes |
| `error` | A chat failed, or a task's latest run or check failed | Yes |
| `unknown` | Contact with a run, a host or the local service was lost | No, falls back to `error` |
| `working` | A chat or task is running or queued | Yes |
| `thinking` | The Mandala main chat is planning | No, falls back to `working` |
| `done` | Work just finished (about six seconds) | No, falls back to `idle` |
| `idle` | Nothing is running or waiting | Yes |
| `sleep` | Idle for ten minutes | No, falls back to `idle` |

Work the person stopped is not treated as a failure. Clicking the pet opens the first item waiting for the person, otherwise the Mandala chat.

A pet package is a UTF-8 JSON file of at most 4 MiB:

```json
{ "format": "mandala-pet", "version": 1, "name": "Dot", "tint": false,
  "states": { "idle": "data:image/svg+xml;base64,…", "working": "data:image/gif;base64,…", "waiting": "…", "error": "…" } }
```

Images must be inline `data:` URIs (SVG, PNG, APNG, GIF or WebP); animation lives inside the image. With `tint: true` the image is used as a mask and filled with the theme colour (the accent while waiting), which suits single-colour line art. Images render through `<img>` or a CSS mask, where SVG cannot run scripts or load resources; SVG containing scripts, event attributes, `javascript:`, `foreignObject` or external references is rejected. Use a square canvas that stays legible at 22 px and 84 px. The pet choice and its placement are device preferences.
