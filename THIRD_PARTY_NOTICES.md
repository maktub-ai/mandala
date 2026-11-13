# Third-party notices

The Mandala Source-Available License applies only to covered project-owned contributions. It does not relicense dependencies, vendored code, fonts, logos or other third-party material. Their original terms, copyright notices and any earlier grants remain in effect. Preserve those terms when copying source or distributing compiled packages. A recorded source URL is provenance, not a new permission grant or endorsement.

## Vendored code and assets

| Material | Provenance / copyright | Applicable notice |
| --- | --- | --- |
| TencentDB Agent Memory helpers in `server/vendor/tencentdb/` | TencentDB Agent Memory revision `97f9465`; Copyright (C) 2026 Tencent | MIT; complete original text in `server/vendor/tencentdb/LICENSE` and retained source headers |
| Adapted shadcn/ui components in `src/components/ui/` | [shadcn/ui](https://github.com/shadcn-ui/ui), `radix-nova` registry; Copyright (c) 2023 shadcn | MIT; complete original text in `third-party-notices/shadcn-ui-LICENSE.txt` |
| Inter Variable font | Copyright (c) 2016 The Inter Project Authors | SIL Open Font License 1.1; `src/assets/fonts/Inter-LICENSE.txt` |
| Noto Sans SC font | Copyright 2014-2021 Adobe, with Reserved Font Name 'Source' | SIL Open Font License 1.1; `src/assets/fonts/NotoSansSC-OFL.txt` |
| EB Garamond font | Copyright 2017 The EB Garamond Project Authors | SIL Open Font License 1.1; `src/assets/fonts/EBGaramond-OFL.txt` |
| OpenAI/Codex and Claude icon paths | Bootstrap Icons; Copyright (c) 2019–2024 The Bootstrap Authors | MIT; `public/runtime-logos/LICENSE-bootstrap.txt`; Claude fill adaptation recorded in `public/runtime-logos/sources.json` |
| OMP, Gemini, OpenCode, CodeBuddy, Pi, Cursor, DSH and Antigravity runtime marks | Original upstream URLs, exact files, hashes and brand references in `public/runtime-logos/sources.json` | These marks are not claimed as Mandala-owned or relicensed here. The checkout records their provenance but contains no separate logo-specific permission grant. Preserve original marks/provenance and verify applicable upstream asset/brand permissions for the intended distribution. |
| Kimi Code runtime mark | MoonshotAI/kimi-code; exact source and hash in `public/runtime-logos/sources.json` | MIT; original text in `public/runtime-logos/LICENSE-kimi-code.txt`; brand rights remain with their holder |
| Grok runtime mark | Lobe Icons static SVG 1.101.0; Copyright (c) 2023 LobeHub; exact source and hash in `public/runtime-logos/sources.json` | MIT; original text in `public/runtime-logos/LICENSE-lobe-icons.txt`; brand rights remain with their holder |

All existing upstream license files and headers remain unchanged. Product and project names and marks remain with their respective holders. No endorsement or trademark license is asserted.

The ACP runtime is [maktub-ai/acpx](https://github.com/maktub-ai/acpx), a lightweight fork of [openclaw/acpx](https://github.com/openclaw/acpx), based on v0.22.0 (`1ed28f2842182fdc0526927b8fbe2f5ba906ab2e`). Its host process spawning hook is adapted from [Paperclip's MIT patch](https://github.com/paperclipai/paperclip/blob/ff8ec41e6a1236694d28f463b60c7d136442f9c9/patches/acpx%400.22.0.patch). Original complete notices are shipped in `licenses/dependencies/acpx/LICENSE` and `licenses/dependencies/acpx/THIRD_PARTY_NOTICES.md`. The fork and those upstream contributions retain MIT terms independently of Mandala's project license.

## Application dependencies

Versions are pinned by `package-lock.json`; use that lockfile for the exact dependency graph, including transitive dependencies. The following inventory covers direct application dependencies in this source version. Original texts are supplied by the corresponding installed packages, usually as `node_modules/<package>/LICENSE` or lowercase `license`; retain them with distributed code, including code bundled into browser/server output.

| Dependency | Version | Declared license |
| --- | --- | --- |
| @agentclientprotocol/sdk | 1.8.0 | Apache-2.0 |
| @colbymchenry/codegraph | 1.2.0 | MIT; complete original notice in `third-party-notices/CodeGraph-1.2.0-LICENSE.txt` |
| @tencentdb-agent-memory/tcvdb-text | 0.1.1 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| acpx (Mandala fork) | 0.22.0-mandala.1 | MIT; OpenClaw Team license and Paperclip patch notice retained in the package and release |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| cn | 0.5.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| DOMPurify | 3.4.16 | MPL-2.0 OR Apache-2.0; preserve both supplied `LICENSE` and `LICENSE-MPL` texts |
| highlight.js | 11.11.2 | BSD-3-Clause |
| ignore | 7.0.5 | MIT |
| lowlight | 3.3.0 | MIT |
| lucide-react | 1.49.0 | ISC |
| mdast-util-from-markdown | 2.0.3 | MIT |
| mermaid | 11.17.2 | MIT |
| node-pty | 1.1.0 | MIT; retain accompanying native-code notices as well |
| pdfjs-dist | 6.4.299 | Apache-2.0; retain notices for supplied third-party resources |
| radix-ui | 1.8.1 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| react-markdown | 10.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| tw-animate-css | 1.4.0 | MIT |
| tweetnacl (TweetNaCl.js) | 1.0.3 | Unlicense; original text in `node_modules/tweetnacl/LICENSE` |
| yaml | 2.9.1 | ISC |
| yauzl | 3.4.0 | MIT |

TweetNaCl supplies the established NaCl authenticated box construction used by the optional encrypted connection transport. This does not imply a security audit of Mandala's integration or a warranty by TweetNaCl's authors.

## Build and runtime distributions

CodeGraph retains its platform SDK assets and an additional Node 24.16.0 binary; original terms and that exact Node notice are preserved in `third-party-notices/` and copied with the release. The host integration runs on the existing Node runtime.

The desktop bundle includes a Node.js runtime with its upstream combined license as `LICENSE-node.txt`. Electron and its Chromium/runtime components have their own license and third-party notice files; preserve those in the desktop distribution. Tooling and transitive packages are governed by their respective terms and the root/desktop lockfiles, not this project's license. Package-level license summaries do not replace complete notices, required source availability or any other applicable upstream obligations.

For each release, include the complete original license/notice texts for the dependencies and assets actually bundled in that output, alongside LICENSE and this file; this source inventory alone is not a complete license-text bundle. The connection-service package's README is copied from `docs/account-service-deployment.md`, so that document must describe the same local-storage, encryption, pairing, remote read-only and deployment boundaries as the application.

## Scope reference and prior grants

The [current Multica license](https://github.com/multica-ai/multica/blob/main/LICENSE) was reviewed on 2026-10-18 solely as a scope reference for internal use and third-party hosting. No Multica license text, branding condition, legal entity or ownership assertion is adopted by the Mandala license. This statement does not assert that independently licensed material can be relicensed.

This change does not revoke any earlier grant. No top-level project LICENSE was found in the inspected reachable Git history; that observation is not proof of sole ownership or absence of other grants. Existing third-party notices control their own materials. This inventory is an engineering record, not a claim of legal review or complete rights clearance.
