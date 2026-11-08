# Hermes Agent 与 OpenClaw

这两个执行端复用 Mandala 的原生 ACP、会话管理和执行机器机制。它们是“执行端接入 / CLI 接入”中的选项，不是 GitHub Actions。默认启用列表、已有 Agent 默认值、原生认证和历史不迁移、不重置。停用保留设置，只影响后续执行；关闭适配器不会向用户的原生 Gateway 发送 stop/restart。

## 已验证版本与边界

2026-11-07 在 Apple Silicon、macOS 26.6.2 上验证：

| 项目 | 实际版本 |
| --- | --- |
| 系统 Node / Python | 23.6.0 / 3.13.3（未替换） |
| 开发及 OpenClaw Node | 24.22.2（官方二进制与 SHA-256 核验） |
| 桌面构建 Node | 22.23.4 |
| Hermes | 0.23.0，源码 `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19` |
| Hermes 管理的 Python | 3.14.9，官方 PM / uv.lock 哈希校验安装 |
| OpenClaw | 2026.11.1，npm 固定版本、保留 package-lock.json 与完整性校验 |

| 能力 | Hermes Agent | OpenClaw |
| --- | --- | --- |
| 入口 | `hermes acp` | `openclaw acp` |
| 执行归属 | 原生 Gateway；原生程序可以按需启动它 | 必须有运行中的原生 Gateway |
| 模型 | 读取原生 ACP 模型目录与选择能力 | 仅探测原生默认模型；ACP 不提供模型切换 |
| 审批 | 默认/严格模式均在发送提示前整轮授权 | 同左；部分原生 exec 审批可经 ACP 转发，不等于完整逐工具控制 |
| 会话级 MCP | 本次明确拒绝；当前原生恢复接口对空列表保留旧绑定，无法可靠撤销 | 原生 ACP 不支持，提前拒绝 |
| 原生 Gateway 已配置的工具/MCP | 按原生配置运行，包含在整轮授权范围 | 同左 |
| 标题、记忆等受限系统任务 | 禁止，未证明能完全关闭工具 | 禁止 |
| 远程执行 | 使用 Mandala 现有 SSH 执行机器 | 同左 |

Hermes 的非空 ACP MCP 列表原生能够接入，但从非空改为空时，原生 `load_session` / `resume_session` 会保留旧工具。为防止移除授权后工具仍执行，Mandala 在创建、恢复和当前会话重绑定前均拒绝会话 MCP。应在原生 Gateway 管理这些能力。

Gateway、工作目录、Skills/附件路径和本轮 Mandala 业务 CLI 必须处在同一执行机器。Mandala 拒绝 `HERMES_TUI_GATEWAY_URL`、`OPENCLAW_GATEWAY_URL` 和 OpenClaw `gateway.remote.url` 直连覆盖（包括可能通往其他机器的 loopback 隧道）。在“设置 → 执行机器”登记 Gateway 所在的 Linux SSH 主机，在项目工作目录组选择该机器及远端绝对路径；在那里安装和认证 CLI，并使用本机 Gateway 配置。不会把本机密钥或原生登录复制到远端。本次做了本机真实验收和完整 SSH 适配器路由单元测试，没有宣称已做真实异机 SSH 验收。

## 在其他机器准备原生程序

先检查 `git --version`、`node --version`、`python3 --version`、`command -v hermes openclaw` 和原生程序版本；检查配置与原生登录状态，不输出凭据文件。优先保留已有安装和 profile。仅当 Git 仓库访问失败时，通过 `gh auth login --web` 或已有 SSH 授权处理；不要在聊天里传密码或 token。

OpenClaw 2026.11.1 要求 Node `>=24.16.0 <25 || >=26.1.0`。Mandala 的桌面服务使用 Node 22；原生 OpenClaw 必须由兼容 Node 启动。推荐使用官方独立安装器，或为 npm 安装创建一个固定使用兼容 Node 的启动器，而不是让它的 `#!/usr/bin/env node` 意外选择桌面内置 Node。不要关闭 TLS、校验和或 npm 完整性检查。

官方说明：[Hermes 安装](https://hermes-agent.nousresearch.com/docs/getting-started/installation)、[Hermes ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)、[OpenClaw 安装](https://docs.openclaw.ai/install)、[OpenClaw ACP](https://docs.openclaw.ai/cli/acp)、[OpenAI 原生授权与模型](https://docs.openclaw.ai/providers/openai/setup)。

隔离安装示例（所有路径均为新的测试目录，不覆盖已有 profile）：

```sh
# 使用已经核实兼容的 Node 24，固定 npm 包版本并保留产生的锁文件。
npm install --prefix "$HOME/.local/share/mandala-runtime-check/openclaw" --save-exact openclaw@2026.11.1

# 下载官方安装器后先审读，再安装固定 Hermes 源码及其锁定依赖。
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh
bash /tmp/hermes-install.sh --non-interactive --skip-browser --skip-computer-use \
  --commit 2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19 \
  --dir "$HOME/.local/share/mandala-runtime-check/hermes-source" \
  --hermes-home "$HOME/.local/share/mandala-runtime-check/hermes-state"
```

本机这次安装在仓库根目录的 `.development/runtime-tools/`（不提交）下。`~/.local/bin/hermes` 是官方安装器创建的启动器；`~/.local/bin/openclaw` 固定使用已校验的独立 Node 24 和 npm 安装。系统 Node/Python 未替换。测试原生配置分别是该目录中的 `hermes-state/` 和 `openclaw-state/`，凭据仅由原生程序保存在这些独立目录，不能提交或打包。

为专用测试 profile 完成原生模型配置：

```sh
export HERMES_HOME="$HOME/.local/share/mandala-runtime-check/hermes-state"
hermes model
# 可通过原生向导复用已有 Codex 登录，或完成独立 OAuth。
hermes acp --check

export OPENCLAW_STATE_DIR="$HOME/.local/share/mandala-runtime-check/openclaw-state"
# 对新的、尚未运行 Gateway 的专用 profile 执行；不停止其他用户/日常 Gateway。
openclaw config set gateway.mode local
openclaw config set gateway.port 18981
openclaw models auth login --provider openai --method oauth
openclaw config set agents.defaults.model.primary openai/gpt-6-astra
openclaw gateway run
```

原生 OpenClaw 可能要求认证操作独占离线状态。若提示 `exclusive offline state ownership`，只停止自己专用测试 Gateway，等它退出后登录；不要删除状态锁或停用户共用 Gateway。本次 `openai/gpt-5.6` 路由曾返回无兼容认证来源，改用 OAuth 登录实际推荐的 `openai/gpt-6-astra` 后真实模型验收通过；登录成功不等于任意模型都可调用。

## 在 Mandala 启用

1. 按仓库 README 安装锁定依赖并构建。在启动服务的环境保留原生启动器的 PATH；OpenClaw 启动器须固定使用兼容 Node。
2. 设置 → 执行端接入 → 新增 CLI，选择 Hermes Agent 或 OpenClaw，保存并启用。
3. 可直接继承原生默认 profile；隔离 profile 可用 `HERMES_HOME` / `OPENCLAW_STATE_DIR` 环境变量引用指定。只保存 `${变量来源名}` 引用，密钥仍由原生程序管理；来源变量需要存在于实际执行机器的服务环境。
4. 重新检测并读取原生模型。检测成功表示 ACP/Gateway 会话可建立，模型权限与余额仍以实际请求为准。
5. Agent 设置选择默认执行端；新对话也可单独选择。OpenClaw 模型应保留原生默认值；在原生配置改模型后新建对话。
6. 默认/严格审批都会先显示整轮授权；拒绝或在授权前停止不会发送提示。自动批准代表明确允许整轮工具执行，不等于受限沙箱。
7. 停用后设置、原生认证和历史保留。重新启用继续使用原有设置。

恢复只使用已保存的原生会话。OpenClaw 通过 `session/resume` 和 `requireExisting` 绑定原 `acp-bridge:<UUID>` Gateway key，避免原生宽松 load 在缺失历史时创建替代会话。原生会话不存在时明确失败。断线或 Gateway 报告中断时先检查原生状态，不自动重发可能已执行的任务。原生 Gateway 自身的模型回退、辅助模型请求等仍受其自身配置控制。

## 可复现验收

以下命令均需在工作树中执行，PATH 和原生 profile 环境应指向实际测试安装。所有 Mandala 数据由脚本创建在新的系统临时目录中。脚本输出 `verification.json` 的路径和结果，不打印凭据。

```sh
npm ci
npm run typecheck
npm run build
npm test -- --maxWorkers=4
npx playwright install chromium
npx playwright test tests/e2e/coding-runtimes.spec.ts tests/e2e/runtime-connections.spec.ts

# 真实原生程序/Gateway 协议；不调用模型。
node --import tsx scripts/acp-protocol-smoke.ts hermes
node --import tsx scripts/acp-protocol-smoke.ts openclaw

# 真实模型：文件创建/读取/修改、独立 Node 进程同会话恢复、业务 CLI、审批与停止。
CLI_SMOKE_EXTENDED=1 node --import tsx scripts/acp-live-smoke.ts hermes
CLI_SMOKE_EXTENDED=1 node --import tsx scripts/acp-live-smoke.ts openclaw

# 真实程序 + 受控 localhost 模型接口：只杀脚本自己创建的 Gateway 进程组。
# 此项不能替代上面的真实模型验收。Hermes 首次独立 profile 会先准备锁定依赖。
node --import tsx scripts/acp-gateway-fault-smoke.ts hermes
node --import tsx scripts/acp-gateway-fault-smoke.ts openclaw

# 浏览器使用新的临时 Mandala 数据、真实原生程序和真实模型；仅账号层用隔离夹具。
# 传入上面真实模型验收成功的临时目录。
CLI_SMOKE_BROWSER_HOME=/path/to/successful-live-home node --import tsx scripts/acp-browser-live-smoke.ts
```

`CLI_SMOKE_KIND=real-program-controlled-endpoint` 仅在主动使用受控模型接口时设置；不能将其报告为真实模型。完整单元测试和界面配置浏览器测试使用模拟协议/模型目录；真实程序协议脚本不调用模型；故障脚本使用真实 Gateway 和受控本地模型；真实模型脚本才验证原生认证和实际模型回复。保持这些结果分别记录。

验收截图只使用隔离数据，保存于临时验收目录或 Playwright 输出，不提交。桌面 DMG 按仓库流程从已合并并同步的干净 main 构建，不自动安装桌面 App，不启用云端 CI/CD。

## 本机验收记录（2026-11-07）

| 检查 | Hermes Agent | OpenClaw |
| --- | --- | --- |
| 原生模型 | 原生 OpenAI Codex OAuth，`gpt-6.1-sol` | 原生 OpenAI OAuth，`openai/gpt-6-astra` |
| 真实模型 + 原生文件工具 | 创建、读取、修改及实际内容核对通过 | 同左 |
| 独立 Node 进程重启 | 原原生会话 ID 不变，继续工具任务通过 | 原 ACP ID / Gateway key 绑定保持，继续工具任务通过 |
| 真实业务 CLI | `progress report` 产生持久 progress 事件 | 同左 |
| 整轮审批/停止 | 允许、拒绝前不派发、待批准时停止、运行中 shell 停止均通过 | 同左 |
| 真实浏览器流式 | 运行中观察到 17 次不同可见文本；刷新保留最终回复 | 运行中观察到 26 次不同可见文本；刷新保留最终回复 |
| 真实程序协议，无模型 | 模型目录 15 项、会话恢复、缺失会话拒绝、适配器关闭后可重新连接 Gateway | 原生默认模型探测、恢复、缺失会话拒绝、MCP 拒绝、Gateway 可重新连接 |
| 真实程序 + 受控端点故障 | 适配器关闭后脚本专属 Gateway 原 PID 存活；随后杀掉它明确失败，主任务请求 1 次、无自动重发 | 同左 |

真实模型及浏览器使用独立临时数据，未读取或输出密钥。账号界面之外的浏览器链路使用真实会话管理、ACP、Gateway、模型与持久化，只有账号处理采用隔离夹具。配置类浏览器测试采用模拟 CLI 状态/模型目录；不是模型授权证据。受控端点故障测试也不是实际模型成功证据。

完整单元测试在 Node 24 上为 270 个文件、3369 项通过、2 项 Windows 专属测试跳过。类型检查和生产构建通过，相关浏览器用例 12 项通过。新增接入页面已检查 390px/1280px、浅色/深色；真实浏览器模型回复另行验收。更广的实时输出用例发现并修正了主线遗留的旧定位器和旧主题偏好测试数据，未因此修改产品布局。

没有做真实异机 SSH 或 Windows 原生验收；没有安装/更新 `/Applications` 中的桌面 App，没有启用任何云端 CI/CD。桌面包和最终 Git SHA 以本次交付回执及包内 `runtime/build.json` 为准。
