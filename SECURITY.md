# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.

Report privately through GitHub: **[Report a vulnerability](https://github.com/maktub-ai/mandala/security/advisories/new)**.

Include what you found, how to reproduce it, and the version you tested. We will acknowledge your report, keep you updated while we fix it, and credit you in the advisory unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release. Update through Settings → General → About and updates, or download from [mandala.pub](https://mandala.pub).

## Scope

In scope: this repository, the desktop app, the local service, the personal-connection relay protocol, and the official installers in [mandala-releases](https://github.com/maktub-ai/mandala-releases).

Out of scope: the native CLIs Mandala launches (Claude Code, Codex and others) and their model providers. Report those to their vendors.

## How Mandala treats your data

- The local service listens on the loopback address only, and platform data stays on your machine.
- CLI credentials stay with each CLI and are never written to Mandala's configuration.
- The optional phone connection uses end-to-end encryption. The relay only forwards ciphertext.
