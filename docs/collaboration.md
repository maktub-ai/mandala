# 协作与发布流程

## 默认交付规则

所有有效更改（功能、修复、重构、文档、配置和测试）完成必要验证与审阅后，默认提交、合并到本地 `main`，并推送 `origin/main`，读取远端 SHA 确认一致。上述步骤已有项目默认授权，无需再次询问是否合并或推送；只停留在任务分支或本地 `main` 不能报告交付完成。

遵守现有仓库保护规则；如需 PR，完成适用的本机检查后按默认授权合并，不绕过检查、不强推。用户明确要求只调研／预览、保留候选或暂缓合并／推送时按该次指示执行；必要验证失败、冲突或远端拒绝时报告具体阻塞，不能默认为完成或静默留在分支。此规则不要求把历史实验、未验收候选和无关未提交改动批量合入。

本地 App 按交付需要更新：用户要求、修复需在安装版验证，或明确的发布／升级需求。更新前核实活动工作、保存可回退 App 与真实 HOME 备份；更新后分别核对安装提交、实际运行界面、业务数据和用户偏好。源码与文档同步成功不等于 App 已更新；文档等不影响运行时的更改通常无需重装。

交付回执必须包含：提交 SHA、验证结果、远端 main SHA、App 是否更新及原因；如更新，补充安装版本、数据与偏好验收、备份位置。

## 分支与审阅

`main` 保存已审阅、可发布的源码。`work/<任务名>` 是短期任务分支；已有 `codex/initial-mvp` 保留作历史开发基线，不作为长期发布入口。

每个新任务必须从刚同步的 `main` 新建 `work/<任务名>` 分支；需要隔离时，从该主线提交创建新 worktree。不得从旧任务分支或旧 worktree 的 HEAD 续开另一个任务，不得复用已交付的任务分支。可以复用干净的工作目录，但必须重新从最新 `main` 建分支；目录名称不代表基线新旧。

Agent 开工先确认真实仓库、remote、主线所在 worktree、文件职责与用户已有改动，记录起点 main SHA。已有改动保留在原处，不自动 stash、reset 或覆盖。独立任务可以使用不同 worktree；同一任务共用分支时，文件职责不能重叠。需要收回历史功能时，以明确审阅过的提交 merge 或 cherry-pick，不能整包覆盖文件。

根目录工作树（仓库本身所在目录）始终停在干净的 `main` 上，作为主线工作树；任务一律在 `.development/<任务名>` 的独立 worktree 中进行。开工与检查由 `scripts/task.mjs` 执行，规则不靠记忆：

```bash
# 在根目录（或任意 worktree）执行：获取 origin/main，快进本地 main，
# 再从该提交创建 .development/my-task 和 work/my-task
npm run task:start -- my-task
cd .development/my-task

# 动手前、提交前各检查一次；失败即停止，按提示处理
npm run task:check

# 完成工作与检查，只暂存本任务的文件
git add path/to/changed-file
git commit -m "feat: describe observable change"
git push -u origin work/my-task
```

`task:check` 拒绝以下情况：根目录不在 `main`；本地 `main` 落后或分叉于 `origin/main`；detached HEAD；没有自己提交却落后主线的旧分支或已交付分支。分支开出后主线又前进只提示，交付前按下文合入。无法联网时按本地记录的 `origin/main` 判断并给出提示，`--no-fetch` 可显式跳过获取。无法使用独立 worktree 的环境（例如路径与本机不同的远程沙盒）才在根目录开任务分支，并以 `npm run task:check -- --allow-root-branch` 检查，交付后把根目录切回 `main`。

主线快进失败或 SHA 不一致时，先核对本地未推送提交与远端变化，整合并正常推送后再开工；禁止用强推或重置掩盖分歧。`main` 已由其他 worktree 检出时，在该主线 worktree 同步，不强行切换或覆盖。

合并前再次执行 `git fetch origin main`，将新到的 `origin/main` 合入任务分支（无变化则无需合并），解决冲突并对最终结果重新验证、审阅。确认 `git merge-base --is-ancestor origin/main HEAD` 成功后再交付。回到干净的主线 worktree，用 `git merge --ff-only origin/main` 同步，再用 `git merge --ff-only work/my-task` 合入任务。若主线又前进，返回任务分支整合后重验，不绕过检查。正常推送 `origin main` 并用 `git ls-remote origin refs/heads/main` 核对 SHA；远端拒绝时同样先整合，禁止强推。最终回执记录起点 SHA、合并后的 main SHA 和远端 SHA。

创建目标为 `main` 的 PR，或在仓库允许时进行经审阅的本地合并，说明行为变化、检查结果和发布影响。需要 PR 时由协作 Agent 按上述默认授权完成合并；类型、测试、构建与适用的 E2E 默认在本机运行。远端仅同步代码和审计记录；Actions 只保留手动入口，不因 push、PR 或 Tag 自动执行。文档等低影响更改执行适用的内容、链接及差异检查，不用无关测试数量代替验证。

建议将 GitHub 默认分支设置为 `main`，并在仓库 Rulesets / Branch protection 中按团队需要要求 PR、禁止强推；不要求默认运行云端 `checks`。工作流文件本身不会开启分支保护。个人仓库不必要求另一位人类审批，避免仓库所有者无法审阅自己的 PR。

## 本机发布命令

在单独的、干净的 `main` 工作副本中执行：

```bash
git switch main
git pull --ff-only origin main
MANDALA_HOME="$HOME/.mandala" MANDALA_PORT=4332 npm run release:local -- --check
MANDALA_HOME="$HOME/.mandala" MANDALA_PORT=4332 npm run release:local
```

`--check` 只检查分支、未提交文件、数据目录、服务归属与活动任务，不推送、不备份数据、不重启服务。发布目录默认使用 `.mandala-releases`；未迁移的旧目录继续复用，可在停止发布进程后使用[离线迁移命令](desktop.md#migrate-a-legacy-home)，保留旧目录链接和完整备份，不移动正在使用的发布副本。Hook 优先读取 `mandala.releaseHome/releasePort`，未设置时兼容旧 `openmana` 键。

完整发布：

1. 固定 `main` 的提交 SHA，将 Git 已跟踪源码归档到 `~/.mandala-releases/<sha>-<随机后缀>/`。
2. 在归档副本执行 `npm ci`、单元测试、类型检查、构建与 E2E。失败时保留副本供排查，现有服务继续运行。
3. 再次确认主线未变化、工作区干净、没有运行或审批中的对话以及排队/活动的任务 Run。
4. 正常推送 `main`，禁止强推；读取远端 SHA 确认。推送失败则不停止服务。
5. 仅对记录中 PID、工作目录均一致的现有服务发送 SIGTERM；等待其退出，再把整个应用数据目录复制到发布副本的 `data-backup/`。
6. 通过当前 Node 与 `tsx` 从固定副本启动后台服务，沿用发布进程的环境与显式 `MANDALA_HOME` / 端口。
7. 核对 API 就绪、监听 PID 和实际首页与 `dist/index.html` 一致；写入 `~/.mandala-releases/current.json`，输出提交、PID、源码和数据路径。

后台服务不依赖浏览器窗口，但当前没有登录自动启动或守护进程自动重启。发布命令不执行真实模型验收；发布后按改动检查真实 CLI、已有会话和实际用户流程。发布期间不要另发新任务，后台系统任务也应先完成或停止。

## 首次迁移已有自用服务

已有端口上的服务若不在 `current.json` 中，发布会直接拒绝。不得为了绕过检查手写 PID 记录。

首次迁移需要：

1. 核对现有进程、启动源码、构建产物、端口和数据 HOME；比较运行副本与 Git 主线。
2. 将需要保留的功能收齐到任务分支，经检查和审阅后合入 `main`。
3. 等待或停止所有活动任务，优雅停止旧服务，并备份其源码、构建和完整数据目录。
4. 用旧服务的真实数据 HOME 执行第一次本机发布；比较原有对话、任务、资产和记忆，并完成真实使用验收。

**此次建立管线不等于完成已有服务迁移。** 当前自用副本可能含尚未提交的功能，不能直接用初始 Git 基线替换。

## 合并后自动发布

首次迁移并成功发布后，可在专用的主线工作副本启用仓库 Hook：

```bash
git config --local mandala.releaseHome "$HOME/.mandala"
git config --local mandala.releasePort 4332
git config --local core.hooksPath .githooks
```

先检查原有 `core.hooksPath`；若已设置，合并现有 Hook 后再启用，不直接覆盖。Hook 只在当前分支是 `main` 且设置了数据 HOME 时发布，任务分支合并不重启服务。

本机 `git merge` 或 `git pull --ff-only` 更新 `main` 时，post-merge 会重新检查、推送并发布。GitHub 网页合并后仍需本机拉取；未安装远程轮询或自托管 Actions Runner。首次启用前，确保该工作副本已执行 `npm ci`，PATH 包含所需 Node 与 CLI，运行参数引用的环境变量也已准备。

Hook 发布失败不会撤销已完成的 Git 合并。检查错误后重新执行 `npm run release:local`；Git 主线、GitHub 推送和本机服务更新必须分别记录。

停用自动发布：

```bash
git config --local --unset-all mandala.releaseHome || true
git config --local --unset-all openmana.releaseHome || true
```

## 故障与回退

先读取失败发布目录的 `service.log` 和 `deployment.json`，以及最后成功的 `current.json`。数据备份只保存在本机，包含个人会话与资料，不得推送到 GitHub。

新服务启动失败时，发布命令停止新进程并报告；**不会自动回滚数据或旧服务**。源码与数据库迁移不一定向后兼容，回退时先确认进程已退出，再根据迁移情况恢复该版本对应的数据备份与运行副本。不得在仍有服务连接 SQLite 时覆盖数据。

若进程被 SIGKILL 或机器断电，`release.lock` 可能残留；先确认没有发布在运行，再删除 `~/.mandala-releases/release.lock`。旧发布副本和数据备份暂不自动清理，确认回退窗口后手动清理。

## 桌面包路线

App 只从已合入并同步远端的干净 `main` 固定提交构建。构建前记录源码 SHA，安装前读取包内 `Contents/Resources/runtime/build.json`，确认提交与目标 main SHA 一致，不能直接拿旧工作树遗留的 App／DMG 安装；期间主线若前进，先整合并重新验证、构建。安装后再核对实际运行提交，不能用源码已同步代替运行版本验收。

日常 `main` 合并与远端同步、独立本地服务发布、桌面 App 更新分别记录。桌面构建、手动更新、正常停机、备份／回退与签名边界以 [桌面说明](desktop.md) 为准；`release:local` 更新的是独立服务，不会替换 `/Applications/Mandala.app`。当前已有 Electron 桌面构建；DMG 默认在 macOS 本机用 `npm run desktop:build` 生成，安装包核对源提交、版本和校验和。版本化云端工作流仅保留手动入口，不由 Tag 自动触发。默认同步主线不自动启用发布 Hook、重启服务或替换 App。

CI 配置依据：[GitHub Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[Node.js 构建与测试](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)。
