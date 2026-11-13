# CLI 接入与 acpx

Mandala 保留产品适配层，ACP 协议通信交给 [maktub-ai/acpx](https://github.com/maktub-ai/acpx)。这是 [openclaw/acpx](https://github.com/openclaw/acpx) 的 MIT 轻量 fork，基于 v0.22.0（`1ed28f2842182fdc0526927b8fbe2f5ba906ab2e`）。依赖固定到 fork 的发布包，锁文件校验完整性，不跟随浮动分支；原生 CLI 的安装和登录仍由用户管理。

## 职责

- **acpx**：ACP 进程与连接、协议校验、认证、会话恢复、流式事件、权限回调及取消。通用修复分别提交上游，是否合并由维护者决定。
- **Mandala**：原生命令与凭据环境、功能发现、审批界面和策略、系统任务限制、会话归属、MCP 绑定、历史与任务管理、本机和 SSH 执行。
- **原生适配器**：保留 ACP 尚未覆盖的分叉、压缩、历史检查等能力。Skills 属于执行端的任务能力，不由 acpx 接入层重新实现。

`server/acp.ts` 使用公开的 `acpx/runtime` API，不依赖 `dist` 内部文件。Mandala 保存原生会话 ID；acpx 在内存缓存当前连接状态。已交付的会话 ID 始终严格恢复，失败时报错，不通过创建空会话冒充恢复成功。凭据环境和受限任务元数据不写入 acpx 会话记录。

## 当前能力表

这是 Mandala 已实现的接入边界，不代表每个本机 CLI 版本都已通过在线验收。“原生声明”表示连接时检查能力并拒绝不支持的请求，不伪装统一支持。

| CLI | 传输 | 原生会话继续 | 模型选择 | 图片 | 会话 MCP 绑定 | 工具审批 | 禁用工具的系统任务 | 保留的原生扩展 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | app-server | 支持 | 原生目录 | 支持 | 支持 | 原生逐项 | 支持 | 分叉、压缩、上下文/执行检查、Skills、MCP 状态 |
| OMP | RPC | 支持 | 原生目录 | 支持 | 支持 | 原生逐项 | 支持 | 分叉、压缩、上下文、Skills |
| Claude Code | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | ACP 逐项 | 支持 | 保留 Claude 受限任务元数据 |
| Gemini CLI | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | ACP 逐项 | 支持 | 保留受限启动配置 |
| OpenCode | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | ACP 逐项 | 支持 | 保留原生权限环境 |
| CodeBuddy | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | ACP 逐项 | 支持 | 旧权限种类兼容、受限启动参数 |
| Pi | RPC + 扩展 | 支持 | 原生目录 | 按模型声明 | 不支持 | 权限扩展 | 支持 | 思考级别、Skills |
| Cursor Agent | stream-json | 支持 | 原生目录 | 不支持 | 不支持 | 整轮授权 | 不支持 | 保留现有流式接入 |
| Kimi Code | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | ACP 逐项 | 不支持 | 原生认证与会话 |
| DSH | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | 整轮授权 | 不支持 | resume-only 会话、远端 MCP 命令解析 |
| Antigravity | stream-json | 支持 | 原生目录 | 不支持 | 不支持 | 整轮授权 | 不支持 | 保留现有流式接入 |
| Grok | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 支持 | ACP 逐项 | 不支持 | `--no-leader` 与缓存认证 |
| Hermes Agent | acpx / ACP | 原生声明 | 原生目录 | 原生声明 | 不支持 | 整轮授权 | 不支持 | 本机 Gateway 前置检查 |
| OpenClaw | acpx / ACP | 严格 resume | 仅原生默认 | 原生声明 | 不支持 | 整轮授权 | 不支持 | Gateway 配置、空结果/中断检测 |

ACP 模型目录可能使用配置选项或旧 `models` 字段，均保留原生 ID；没有目录时只使用原生默认模型。HTTP MCP 还需执行端声明支持。会话 MCP 支持不表示能控制 CLI 原有的全局工具。审批和权限范围详见 [审批规则](approval-policy.md)。

**问答与工具审批分开。** 此迁移不宣布所有 CLI 都具有可点选问答体验。现有 Codex 问答保持不变；fork 的 Antigravity ACP 问答回调是独立底层能力，默认取消，未接入 Mandala 当前的 Antigravity stream-json 路径。跨 CLI 统一表单仍需逐项验证后再决定上线。

已有对话绑定原生 CLI 和原生会话，不能把 A 的会话 ID 交给 B 恢复。切换 CLI 应建立新的原生会话；Mandala 配置与历史展示继续由产品层负责。

## 补丁与上游更新

Paperclip 的 [acpx 补丁](https://github.com/paperclipai/paperclip/blob/ff8ec41e6a1236694d28f463b60c7d136442f9c9/patches/acpx%400.22.0.patch) 提供了可复用的宿主进程启动扩展。这里只移植需要的 `spawnAgent` 思路，保留 MIT 版权和固定来源；其余扩展 RPC、子代理路由等补丁没有整体引入。

独立贡献包括宿主进程启动、CodeBuddy 权限兼容、Grok 带参数认证、临时会话元数据、严格 OpenClaw 恢复、显式 Antigravity 问答处理及握手能力诊断。各补丁的提交、上游 PR 和接受状态以 fork 的 `UPSTREAM.md` 为准；发布包可先使用已验证补丁，无需等待上游接受。

更新时先获取上游 tag 并查看变化，再在独立分支重放补丁；已被上游等效覆盖的补丁删除，冲突逐项解决。运行 acpx 完整检查、Mandala 接入回归、构建和 SSH 打包验证后发布新的固定版本，再更新 Mandala 依赖及锁文件。更新不自动替换用户的原生 CLI，不自动启用云端 CI/CD，也没有隐式定时升级。

新增 CLI 优先使用原生 ACP 加命令配置；只有协议差异才补 acpx 通用兼容代码。原生协议或产品专有行为留在 Mandala 模块中。每次登记都应补能力表、取消/恢复/权限/失败回归，不能仅以进程启动成功作为支持证明。
