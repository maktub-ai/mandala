# L3 项目与 Agent 接入契约

本次实现将上游 `team + agent` 映射到 Mandala 的 `project + agent`。每个本地用户下，每个组合最多维护一份当前有效 L3；`recordId` 固定，更新增加 `revision`，历史留在 `memory_revisions`。L1、L2 的共享和授权规则保持原有行为。

## 对话接入

```ts
const scope = {
  projectId: conversation.projectId || null,
  agentId: conversation.agentId || null,
};
const principal = {
  userId: localUserId,
  ...(scope.agentId ? { agentId: scope.agentId } : {}),
};
const current = runtime.profiles.current(principal, scope);
// 等同于 runtime.memory.profile(principal, scope)
```

- `current` 返回当前有效、证据和权限仍有效的 L3，或 `null`。对话自动引用必须使用这份单条结果，并遵守请求记忆读取开关。
- 两个维度的 `null` 都是独立组合，不表示全部项目或全部 Agent。项目内对话不回退引用无项目的 L3；A 不引用 B 的 L3。Run 的项目也必须匹配。
- `profileScope` 是服务端控制的归属。`sourceAgentIds`、`conversationIds`、`evidence` 是溯源，不能用于判断文档属于哪个 Agent。
- L3 的 `semanticKey` 固定为 `persona.operating-doctrine`。稳定 ID 由本地用户与两个维度计算，不应由对话模块自行计算或选择。
- 泛化 recall 也已排除不属于本组合、非规范 ID 和旧共享的 L3；接入时不要 owner-list 后选最新 L3，也不要合并多条 L3。
- Agent 修改历史、切换项目/Agent、已有原生会话恢复，以及延迟准备期间撤回或改写记忆时，继续使用原有修订核验与历史通知机制。

## 生成与更新

- 同项目多个 Agent 可以读取有权限的共享 L2，但各自维护自己的 L3 与加工任务、检查点。候选中只包含当前组合 L3 和授权场景 L2。
- 多 Agent 来源合并批次分发为各组合独立的 profile 作业。项目对话产生的私有 L2 对应 `(null, Agent)`，不会加入项目 L3。
- 已有 L3 的模型输出必须 `update` 或 `skip`，`replaces` 精确引用同一 ID 的当前修订；首次生成使用 `store`。多份 L3 草稿会在落库前整体拒绝。
- 来源编辑或失效导致旧正文不可读取时，加工只获得空正文的旧文档身份及修订号，用当前有效 L2 重建同一 ID，不能继承不可用的旧正文。
- profile 自动失败最多重试一次，包括服务错误与过期租约。暂停、关闭或未配置生成器不消耗失败额度。相同候选与当前修订的作业去重，终态失败不会通过扫描不断重新创建作业。
- 当前 L3 经用户确认/纠正后，自动生成不得覆盖其不同正文。撤回 L3 后，不通过后台扫描重新生成；恢复须由管理操作显式进行。

## 升级与兼容

`runtime.initialize()` 顺序：旧知识导入 → `repairLegacyContexts`（依赖提交的旧规程修复）→ `retireUnscopedProfiles`。

- 已确认旧规程保留为有用户确认依据的 L1，允许生成授权场景，不把每条规则当成 L3。
- 无 `profileScope` 的旧 active/proposed L3 增加修订并改为 stale，历史正文仍保留；旧无归属 profile 队列变 obsolete 并递增 leaseToken。迁移一次执行，具有幂等标记。
- 不把旧共享 L3 复制成每个 Agent 的新文档。启动扫描从现有 L2、实际对话组合、项目成员和私有集合恢复适用组合的加工。
- 本交付只测试临时数据库，未操作安装应用的数据。安装更新前备份真实数据库，在集成线程执行升级并验证读回。

## 本地集成与验收

依赖旧规程修复为上游线程提交 `468a8a56c5d63ce4d52f98cfe56e35d2273b1427`；本分支对应 cherry-pick 为 `1d4deeb`。接收线程已有该依赖，只接收其后的 L3 边界提交，避免重复 cherry-pick。

接收线程应先保存自身未提交修改，再协调既有 singleton 后端试验与本契约；保留其对话引用与界面修改。只在本地集成和更新 Mandala，不推送 GitHub。

验收至少覆盖：同项目 A/B 隔离，同 A 跨项目隔离，缺项目/缺 Agent 的准确归属，重复更新 ID 固定与历史保留，旧共享 L3 不注入，编辑旧来源后重建，私有场景冷启动，以及已恢复原生对话使用新的准确 L3。

## 上游核对依据

核对 TencentDB Agent Memory `feat/server_team` 的 [profile-scope.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/src/core/profile/profile-scope.ts)、[profile-sync.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/src/core/profile/profile-sync.ts) 和 [persona-generation.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/src/core/prompts/persona-generation.ts)：归属由 team/user 与 agent 固定，每个组合持续更新其 persona，而不是逐条 L2 升格为新的 L3。Mandala 使用 project 替代 team 是本产品的明确映射。
