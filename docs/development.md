# Mandala 开发与运维说明

面向贡献者与维护者。产品介绍与快速开始见 [README](../README.md)（[中文](../README.zh-CN.md)）。本文保留原 README 中的交付、数据、发布与边界说明，内容未删减。


Mandala 是一个以对话为入口的个人 AI 工作平台。你可以给 Agent 设置长期职责，把代码、资料与工作目录组织到 Project 中，再通过 Codex 或 OMP 执行具体工作。任务、产出和记忆留在可查看的工作台里，减少在多个终端、目录与会话之间重复配置。

当前交付包含 **本地 Node.js 服务 + Web UI**，以及 macOS / Windows 桌面预览包构建流程。桌面应用内置 Node.js，关闭窗口后保留后台服务，明确退出时停止自身服务。预览包尚未签名/公证；下载以 GitHub Releases 实际附件为准，原生 CLI 认证和模型费用仍由执行端管理。

桌面构建与数据兼容见 [桌面说明](desktop.md)，自托管连接服务见 [部署说明](account-service-deployment.md)。官方连接是远程访问的默认选择，但尚无真实官方地址或已部署服务；部署前须配置并验证 HTTPS 账号服务。打包桌面端必须登录 Google、GitHub 或邮箱账号；有效期内可离线使用，不同账号使用独立本地工作区。

源码 `package.json` 的 `0.1.0` 是开发基线；预览构建由 `MANDALA_VERSION` 固定实际发布版本，安装文件名、App 版本、`runtime/build.json` 与服务包 `release.json` 应一致，并记录实际源码 SHA。CLI 当前不支持产品 `--version`，`service status` 中的 Node 版本表示运行时，不表示 Mandala 版本。

## 为什么做 Mandala

- **Agent 围绕业务模块持续积累。** 按相对独立的模块和知识复用划分，保留经验、记忆与能力配置。
- **Project 承载业务工作范围。** 可包含多个仓库和工作路径，模块 Agent 共用获授权的 Project Wiki；普通聊天也可以独立开始。
- **执行端沿用原生 CLI。** 登录、模型、工具和原生会话由 CLI 管理，Mandala 不另建模型账号体系。

- **协作过程可以审阅。** 对话、独立任务、回执和产出分别保留，方便检查做了什么、还缺什么。
- **本地使用优先。** 服务绑定回环地址，平台数据保存在本机。

执行端接入支持 Codex、OMP、Claude Code、Gemini CLI、OpenCode、CodeBuddy、Pi、Cursor Agent、Kimi、DSH、Antigravity 和 Grok。可分别配置启停、Agent 默认执行端和新对话模型；凭据不会写入 Mandala 配置。

Cursor、DSH、Antigravity 的工具授权覆盖整轮执行，界面会明确说明范围。Pi、Cursor、Antigravity 不支持会话级 MCP 绑定；只有能够在启动前禁用全部工具的执行端可用于系统任务。Cursor 模型权限由原生账号计划决定。

## 当前功能

以下模块已进入代码实现；具体 CLI 能力仍取决于本机安装版本、登录状态和实际验收。

| 模块 | 用途 |
| --- | --- |
| 对话 | Codex / OMP 接入、流式输出、Markdown、附件、模型与思考强度选择、审批、停止与继续 |
| Agent | 长期职责、执行默认值、模型、MCP 和 Skill 引用 |
| Project | 可选上下文、工作目录组、资源与参与 Agent |
| 任务 | 独立派发、排队、执行状态、交接与回执 |
| 资产 | 管理任务产出与版本，预览可访问的资料 |
| 记忆 | 分层资料、来源、候选确认、检索与使用范围 |
| 自动化与系统任务 | 定时工作及后台处理的配置与状态 |
| Market | 浏览与管理 Skills、MCP、主题和语言包 |

任务直接包含执行对话，没有父子任务或任务依赖。每个执行对话只属于一个任务，可由不同 Agent 并行执行；委派与定时触发为同一任务新增执行对话。回报投递至任务的来源对话，执行成功与任务验收分开记录。

**任务结构升级会自动清空旧任务数据。** 首次启动检测到旧结构时，先将完整 SQLite 数据库保存到 `<数据目录>/backups/tasks-flatten-<UTC 时间>-<唯一编号>.sqlite`；备份失败则停止升级。随后重建任务、运行、回报及关联数据，并清除定时规则的旧任务指向。对话、Agent、项目、记忆、资料和普通聊天队列保留，旧执行对话成为普通对话。历史记忆保留固定证据及原读取权限，旧任务的待处理记忆作业失效。将来更新已安装 App 后启动，也会执行此迁移；仅同步源码不会触发。

主题与语言包来自两个独立的 GitHub 社区目录，安装后可在 Market 应用或卸载。包格式、贡献方式和行为边界见[主题与语言包](market-ui-extensions.md)。

Agent、Project 与 CLI 原生能力的同名配置按 **Project > Agent > 原生** 处理。保存配置、加载配置和实际生效是不同状态，应以执行记录和原生行为验证。

## 快速开始

### 环境要求

- Node.js **22.23.2 或更高**；当前验证基线为 22.23.2。
- npm；依赖按仓库中的 `package-lock.json` 安装。
- 至少一个已安装并完成原生认证的受支持执行端。
- 本地运行主要在 macOS 验证。Windows 专属测试在 Windows CI 运行；macOS 测试中的 Windows skip 不代表原生验收。

Mandala 复用执行端已有的登录态。请先确认对应 CLI 能在终端独立工作，再启动平台。

### SSH 远程工作目录

在“设置 → 远程机器”添加 OpenSSH 目标或 `~/.ssh/config` 别名（添加时会先测试连接，失败会给出处理建议），在项目的工作目录组选择机器并填写远端绝对路径。SSH 密钥或 ssh-agent、端口及跳板机沿用系统 OpenSSH 配置；首次连接前应在终端核对主机指纹并建立 `known_hosts` 信任。Mandala 不保存 SSH 密码，也不会关闭主机密钥校验。

首版远端要求 Linux、Node.js 22.23.2 或更高，以及已安装并完成原生认证的 CLI；SSH 命令环境必须能找到 `node` 和相应 CLI。“已安装”检测不代表认证或模型调用已验收。所有已登记执行端共用远端执行服务，仍使用各自现有协议适配器；原生账号、Git 凭据、环境变量引用和 stdio MCP 命令在远端解析，不自动复制本机登录态。

首次实际使用远程目录时，Mandala 通过 SSH 将构建时生成的服务安装到远端用户私有目录 `~/.mandala-execution`。业务数据、任务和记忆仍由本机服务持有，远端托管原生进程与必要的执行状态；获授权 Skills、附件和明确发布的输出通过作用域通道传输。目录和终端操作使用远端机器，远程 CodeGraph 暂不支持。

对话保存机器、SSH 目标和目录的快照，后续修改工作目录组不会迁移旧对话。短暂断线在同一本机进程中重连到原执行，保留请求身份并补回事件；未确认停止时保持未知状态，不自动重发工作。本机 Mandala 进程退出后，远端当前原生进程可以继续，但任务编排及记忆等业务调用需要本机在线；重新启动本机服务会将未确认工作标记为中断/未知，本版不自动重建活动回调、审批或完整运行订阅，应先核对远端状态再继续。终端 SSH 会话与后台 Agent 执行分别管理。

远端服务检查协议与构建版本；不兼容的既有服务保留原工作并拒绝新连接。升级遇到版本不匹配时，应先在远端确认任务和进程已空闲，再停止旧服务；本版不会自动替换活动服务。源码运行前执行 `npm run build`（或仅构建服务的 `npm run build:ssh-runner`），桌面包包含相同的独立服务产物。

```bash
git clone https://github.com/maktub-ai/mandala.git
cd mandala
npm ci
npm run build
npm start
```

访问 **http://127.0.0.1:4317**。

在界面创建 Agent，选择执行端与模型，按需关联 Project 和工作目录，然后开始对话。执行前检查 Agent 的文件、网络与审批配置；当前 Codex Agent 的文件与网络完整访问默认开启，可在 Agent 配置中调整。

所有执行端统一提供按需审批、严格审批和自动批准。按需模式减少日常读写确认；可明确授权本对话后续工具操作，并在输入区撤销。原生长期规则仍由对应 CLI 管理，详见[审批规则](approval-policy.md)。

### 开发模式

```bash
npm run dev
```

访问 **http://127.0.0.1:4174**。开发模式同时启动 Vite 和本地 API 服务。

### 指定数据目录与端口

```bash
MANDALA_HOME="$HOME/.mandala" MANDALA_PORT=4332 npm start
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MANDALA_HOME` | `~/.mandala` | 平台配置、状态、资料及工作目录的保存位置 |
| `MANDALA_PORT` | `4317` | 本地 API 与构建界面的端口 |

更名兼容：`mandala` 是主命令，`openmana` 仍为兼容入口。所有 `MANDALA_*` 变量优先于同名 `OPEN_MANA_*`。新安装使用 `.mandala`、`.mandala-account-service` 和 `.mandala-releases`；旧目录可通过显式离线迁移命令转移，完整原目录作为备份，并保留旧路径链接。迁移后 CLI 与桌面统一选择新版目录；两套独立数据目录并存时拒绝猜测。详见[迁移说明](desktop.md)。显式 HOME、已有登录、电脑批准、自动化与历史正文保留；新旧 Cookie 和内部请求头兼容独立升级的服务。Git Hook 优先读 `mandala.releaseHome/releasePort`，保留旧 `openmana` 配置回退。

源码仓库为 `maktub-ai/mandala`，保持 private；公开安装包与版本说明发布到 `maktub-ai/mandala-releases`。官网和 App 更新检查使用公开安装包仓库，不能把源码历史推送到该仓库。本地已有 checkout 只需将 origin 更新为新地址，无需移动数据目录。

日常数据与测试数据应使用不同目录。停止服务可能中断正在执行的工作；关闭浏览器窗口不会停止独立运行的服务。

### 离线备份与恢复

先停止使用该数据目录的 Mandala 服务，再创建本地快照。备份会拒绝活动 Store；恢复只接受尚不存在的新目录，校验文件摘要和 SQLite 完整性后才发布结果。

```bash
npm run backup -- --home "$HOME/.mandala" --output "$HOME/mandala-snapshot"
npm run restore -- --input "$HOME/mandala-snapshot" --home "$HOME/.mandala-restored"
MANDALA_HOME="$HOME/.mandala-restored" npm start
```

快照包含平台配置、聊天与任务历史、记忆来源/修订/状态、资产文件、附件、托管工作目录、输出和 Market 包。恢复会调整配置、聊天工作目录及目录占用记录中的托管路径，保留外部路径与历史正文。原生 CLI 登录态和原生会话历史、外部仓库、临时运行授权及待发布上传不在快照范围内；继续原生会话仍依赖执行端自身的历史和工作目录，换机器或目录后可能需要新会话。快照目录权限为 `0700`，文件为 `0600`，原有可执行文件保留所有者执行权限（`0700`），应按个人数据保管。

## 验证与测试

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

单元和 E2E 测试使用临时数据与模拟协议端点，不需要把个人 CLI 登录态交给 CI，也不能替代真实模型验收。E2E 使用本地端口 `4318`，需要先构建界面。

真实 CLI 验收使用系统临时目录和个人样例数据，可能调用已登录的模型并产生费用：

```bash
MANDALA_HOME="$(mktemp -d "${TMPDIR:-/tmp}/mandala-smoke.XXXXXX")" npm run smoke:cli
```

## 开发、审阅与本机发布

语音输入的模型下载、云端密钥、数据位置与验证边界见[语音输入说明](voice-input.md)。

以 **`main` 作为唯一交付主线**。功能、修复、重构、文档、配置和测试的有效更改，完成与改动相称的验证和审阅后，**默认提交、合并到本地 `main`，并推送到 `origin/main`，读取远端 SHA 确认同步**。这是项目的默认授权，不再另等“是否合并／推送”的确认；只留在任务分支、本地提交或本地 `main` 不算交付完成。遵守实际仓库保护规则；需要 PR 时走对应流程，不强推、不绕过保护。验证和打包默认在本机执行，代码推送不触发云端 CI/CD。

只有用户明确要求仅调研、仅预览、保留候选或暂不合并／推送，或者必要检查尚未通过、存在冲突或远端拒绝时，才保留待处理状态，并说明具体阻塞。历史实验分支不能因为“默认合并”而不加区分地批量合入。

```text
fetch origin/main → 快进同步 main 并核对 SHA → 从 main 新建 work/<任务名>（可配新 worktree）
  → 精准修改 → 合并最新主线 → 验证与审阅
  → 提交 → 合并 main → 推送 origin/main → 读取远端 SHA
  → 按需要更新本地 App → 安装版本、实际界面与已有状态验收
```

每个新任务都从已同步的 `main` 新建分支，不沿用旧任务分支或旧 worktree 的 HEAD。合并前再次获取主线变化并验证最终结果；保留其他工作树的未提交改动，不强制重置。具体命令见[分支与审阅](collaboration.md#分支与审阅)。

本地 App 在用户要求、修复需要安装版验证或其他明确交付需要时更新；不把每次主线同步等同于重装。只从已合入并同步远端的干净 `main` 固定提交构建，安装前核对包内构建提交与目标 main SHA，不能直接复用旧工作树的遗留包；主线若前进，先整合、重新验证并构建。更新前确认无活动工作、备份 App 与真实数据，更新后核对安装提交、实际运行版本及已有对话、任务、记忆和外观等偏好。每次交付分别报告源码提交、远端同步结果、验证结果和 App 更新状态。

类型、单元测试、构建与适用的 E2E 在本机执行；远端保存代码与审计历史。GitHub Actions 仅保留手动入口，不因 push、PR 或版本 Tag 自动运行。DMG 在 macOS 本机用 `npm run desktop:build` 生成；本机服务发布另外重新验证固定提交，并核对 API 和实际提供的界面。远端主线更新不会直接重启你的 Mac。

```bash
# 在干净的 main 工作副本中执行
MANDALA_HOME="$HOME/.mandala" npm run release:local -- --check
MANDALA_HOME="$HOME/.mandala" npm run release:local
# 仅在用户明确要求不推送远端时，才使用本机例外模式
MANDALA_HOME="$HOME/.mandala" npm run release:local -- --local-only
```

发布默认使用 `4332`，可通过 `MANDALA_PORT` 指定。它会拒绝未提交改动、活动任务以及未由管线管理的现有服务。首次接入已有自用服务前，必须先归并实际运行源码与数据路径，避免用较旧的 Git 版本覆盖新功能。

完整分支约定、自动发布 Hook、首次迁移和故障处理见 [协作与发布流程](collaboration.md)。

## 代码结构

```text
src/          React 界面与交互
server/       本地 HTTP 服务、CLI 适配、会话与任务管理
shared/       前后端共享类型与领域约定
scripts/      开发、真实 CLI 验收、导入与本机发布入口
tests/        单元、协议与浏览器测试
public/       静态资源
.github/      CI 与 PR 模板
```

技术栈：TypeScript、React、Vite、Node.js、SQLite；Vitest 和 Playwright 负责自动检查。平台配置由本地文件管理，运行状态由 SQLite 保存，CLI 原生历史仍按各执行端机制维护。

## 当前边界

- 业务配置、对话、任务、附件与执行始终留在运行中的本机。可选远程连接仅加密转发，不提供云端业务存储或离线投递。
- 手机端可对话、上传/下载、处理原生审批和停止运行；远程配置仅显示脱敏摘要，不能修改配置、访问原始配置、终端或文件浏览接口。
- 平台资料的使用范围不等于 CLI 文件系统沙箱，实际访问权限取决于执行端配置。
- 每段对话绑定一个执行端；跨 CLI 历史迁移与能力差异需要分别适配。
- 服务重启、原生 CLI 退出和任务恢复有独立状态；平台不应把中断伪装成完成。
- Node 22 的 `node:sqlite` 可能输出实验性提示。
- 自动测试通过不代表所有模型、MCP、Skill 或 OMP 版本都完成真实验收。

## 后续方向

近期继续完善 Personal 本地版与全站移动适配。远程访问、Teams 自部署和 Teams 托管的已确认方向与待定边界见 [产品路线图](roadmap.md)。各形态沿用统一主线，按实际需要划分模块和部署入口。

1. 稳定 Agent 协作、主线审阅和本机发布闭环，归并现有运行副本。
2. 补齐真实 CLI 验收、发布记录和可演练的回退流程。
3. 封装 macOS / Windows 桌面 App，复用现有本地服务与界面。
4. 增加签名、公证、安装升级与版本化 DMG / EXE 发布。

桌面预览构建使用 Electron；签名、公证、安装升级与实际设备验收须单独记录。安装包发布应使用版本 Tag，与日常 `main` 更新分开。

## 桌面账号与可选手机连接

桌面端通过 Google、GitHub 或邮箱验证码登录，首次验证后建号；会话有效期为 7 天，期间可离线使用。账号分别使用本地工作区与浏览器分区，旧数据仅在明确认领后归属账号。账号服务只保存认证、设备和访问元数据，统计注册账号数；原生 CLI 仍独立管理模型登录。远程连接为可选功能。电脑与手机浏览器通过 TweetNaCl 的 NaCl authenticated box 端到端加密业务请求和响应；连接服务只作有界、临时的密文转发。电脑必须在线，服务不缓存离线消息，也不自动重放业务写入。

手机首次连接须从已登录的本机页面直接复制配对码，固定电脑公钥；本机批准手机时也固定该浏览器的公钥。密钥不匹配会拒绝访问，服务端账号登录不能替换公钥。浏览器私钥保存在该浏览器的 IndexedDB。非回环部署仍须 HTTPS；密文协议不能防止被攻陷的网页来源提供恶意代码。

初次配置与自托管步骤见 [连接说明](personal-connection.md)；固定版本部署与验收见 [服务部署说明](account-service-deployment.md)。官方服务尚未部署。源码检查、本地测试、构建包、覆盖安装和手机公网验收分别记录，不能互相代替。

本地 `mandala` CLI 从 `MANDALA_HOME/local-access.key` 读取私有所有者凭据；`MANDALA_HOME` 应指向运行中的工作区。Agent 调用继续使用限定范围的原生调用凭据。

## 源码许可

项目原创部分按 [Mandala Source-Available License](../LICENSE) 提供：允许个人自用、单一组织内部自托管及内部商业使用；向第三方提供托管服务，无论收费或免费，均须事先取得相关权利人的书面授权。可按许可保留声明并分发源码或构建副本。它是源码可用许可，不宣称为 OSI 批准的无限制开源许可。第三方组件与既有历史授权继续适用各自条款，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

Type `/` in the composer to search Skill, MCP and task references. Selected Skills supply exact source instructions for that turn; task references provide context and do not start work. Long conversations buffer their initial replay and first appear at the end.

## 官方服务仓库与联调

官网、账号登录及中继服务维护在私有仓库 `maktub-ai/mandala-service`；部署、凭据和服务构建按其中 `account-service/README.md` 操作。本仓库保留桌面客户端和本地运行时，不再提供 `start:control`、`account:build` 或旧版双服务初始化脚本。

桌面单元测试默认不需要私有仓库。维护者配置 `MANDALA_ACCOUNT_SERVICE_SOURCE=/absolute/path/to/mandala-service/account-service` 后，可运行 `npm test -- --maxWorkers=2 tests/local-access.test.ts` 和 `NODE_OPTIONS="--import tsx" npx playwright test tests/e2e/personal-auth.spec.ts tests/e2e/remote-mobile.spec.ts`，验证现行服务与桌面协议兼容。运行前分别安装两个仓库的依赖并构建前端。未配置路径时，只跳过需要真实账号后端的跨仓库用例；服务单元、HTTP 边界和登录页测试已迁至私有服务仓库。

## Source distribution

The root `.gitignore` allowlists source directories and maintained documentation. Local audit reports, plans, runtime data, credentials and build output stay outside the source distribution. Preserve third-party licenses and reproducible tests.

Run `npm run release:check` before committing a release. It rejects tracked files that match ignore rules, including files committed before an ignore rule was added. Desktop packaging and the local service release run this check automatically. Review the staged diff and inspect packaged artifacts separately; this check does not scan credentials or Git history.

A public source snapshot must be exported from a reviewed fixed commit into an independent repository without copying `.git`, old branches, tags or development evidence. Keep existing history private. Do not merge historical branches into the public repository. A repository rename does not remove its history.
