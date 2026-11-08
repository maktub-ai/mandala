# Mandala v0.1.1

This release adds three local knowledge capabilities:

- **Skills:** register directly for an Agent, retain immutable versions and resources, and distill reusable experience from completed conversations. New Skills are assigned to their creator; shared, external and human-maintained Skills receive reviewable proposals.
- **Wiki:** create knowledge bases in Files, include explicit UTF-8 text/Markdown sources, and independently enable new conversation outcomes and automatic page updates. Disabled intervals are not backfilled. Clear replacement versions supersede old material; conflicting sources retain citations and conflict explanations.
- **CodeGraph:** opt in per workspace-directory/resource binding. Default to the selected directory or explicitly expand to its Git repository. Reuse indexes without widening query permissions. Static TS/JS symbols, definitions and call relationships use @colbymchenry/codegraph 1.2.0 without model-based indexing; source trees stay unchanged.

Source permissions apply to generated content, suggestions, history, downloads and downstream knowledge bases. Cache loss and damaged CodeGraph databases can be rebuilt. Cross-workspace dependency graphs remain outside this release.

## Install and upgrade

Download the artifact matching your platform and verify SHA256SUMS.txt. macOS packages use ad-hoc signing and are **not Apple-notarized**; Windows installers are unsigned. These are release versions, not a claim of Developer ID or Microsoft certificate signing.

Before replacing an installation, use **Stop runtime and quit…**, wait for active work to finish, and make an offline workspace backup. Closing the window hides it; ordinary Quit disconnects the frontend while the local background runtime continues. Personal data stays outside the App, and native Codex/OMP login remains in its existing CLI location.

Official account/relay source and service packages are maintained separately in the private maktub-ai/mandala-service repository. This desktop release contains no server archive; see docs/account-service-deployment.md.
