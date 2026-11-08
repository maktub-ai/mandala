# Unified tool approval

All runtimes expose the same three choices. Existing persisted `default` and `auto` values remain compatible; `default` is displayed as **On-demand approval**.

| Mode | Codex | OMP | Claude Code / Gemini CLI / OpenCode (ACP) |
| --- | --- | --- | --- |
| On-demand (`default`) | Native configured policy, `on-request` when unset | Native `write`: reads and edits proceed; execution follows native rules | Native decisions, with automatic once approval for structured reads/edits whose argument paths and advertised locations agree and resolve inside the working directory |
| Strict (`strict`) | `untrusted` | `always-ask` | Forward every native permission request to the user |
| Automatic (`auto`) | `never` | `yolo` | Select the native `allow_once` option automatically |

Modes do not change filesystem/network sandbox settings. Native deny rules remain enforced by the runtime. Strict mode does not erase native remembered rules or make a runtime prompt for actions that it never reports to the host. Unsupported or ambiguous ACP path shapes keep asking; paths containing parent traversal or escaping through symlinks do not qualify for local automatic approval. These checks reduce unnecessary prompts; runtime sandboxing remains the filesystem boundary.

## Approval scopes

- **Once:** answer this request only.
- **Native session / prefix / always:** show only options advertised by the runtime and return the exact native response. Long-term native rules are managed and revoked in the corresponding CLI. ACP `allow_always` uses its native option ID; its scope is not assumed to be a command prefix.
- **Authorize subsequent tools in this chat:** explicit broad platform authorization, including future commands, rather than a rule for the displayed command. It persists through runtime/service restarts and applies only to the same owner, chat, Agent, Project, runtime and canonical working directory. It answers supported tool requests with a native once response, never a native persistent grant.

The composer displays an active platform chat authorization and a revoke action. Revocation affects subsequent requests immediately; it cannot undo a tool already approved. Strict mode suspends platform grant reuse. Other chats and forked chats do not inherit it. Questions, directory-access grants, explicit additional/network permission requests and arbitrary OMP confirmation dialogs are excluded. OMP's select-based tool approvals qualify; free-form confirmation text never becomes a command-matching rule.

An Agent's default mode and the user's remembered new-chat mode remain separate from individual tool grants. Existing conversations retain their explicit overrides. System-managed Mandala/background restrictions remain unchanged.

## Validation

Policy tests exercise path escape, unsupported native choices, strict mode, preference migration, scope isolation, stale request rejection, reuse across turns and revocation. Browser tests cover once/native persistence, broad chat scope, refresh and revoke, and narrow layouts.
