import type {Cli,CliStatus} from '../shared/types';
import {runtimeCatalog,officialRuntimeSetup} from '../shared/runtimes';
import {useLanguage} from './i18n';

export function RuntimeProbeSummary({status}:{status:CliStatus}){
 const {text:l}=useLanguage(), detail=status.diagnostics;
 if(!detail)return null;
 if(status.status==='unavailable'){
  if(detail.failureStage==='configuration')return <small>{l('运行设置有误，尚未启动 CLI。请检查所选运行方式和环境变量引用。','Runtime settings prevented the check. Review the selected route and environment references.')}</small>;
  if(detail.requiredDependency==='claude-override-unavailable')return <small>{l('配置的 Claude Code 路径不可执行。请修正或移除 CLAUDE_CODE_EXECUTABLE，以使用执行机器上已安装的 Claude Code。','The configured Claude Code executable is not runnable. Correct or remove CLAUDE_CODE_EXECUTABLE to use the installed Claude Code on the execution machine.')}</small>;
  if(detail.requiredDependency==='claude-bridge-missing')return <small>{l('该安装缺少 Mandala 随包提供的 Claude ACP 桥。请修复或更新 Mandala。','This installation is missing Mandala’s bundled Claude ACP bridge. Repair or update Mandala.')}</small>;
  if(detail.requiredDependency==='claude-bridge-integrity')return <small>{l('Mandala 的 Claude ACP 桥未通过完整性校验。请使用可信的 Mandala 安装包修复。','Mandala’s Claude ACP bridge failed integrity verification. Repair Mandala using a trusted installer.')}</small>;
  if(detail.requiredDependency==='claude-version-incompatible')return <small>{l('该 Claude Code 版本或启动器不支持安全的会话连接。请在执行机器上更新原生 Claude Code。','This Claude Code version or launcher cannot establish a secure session. Update the native Claude Code on the execution machine.')}</small>;
  if(detail.requiredDependency==='claude-version-probe-failed')return <small>{l('执行机器上的 Claude Code 无法返回版本。请检查原生安装和执行权限。','Claude Code could not return its version on the execution machine. Check the native installation and execution permissions.')}</small>;
   if(detail.executable==='missing')return <small>{l('执行机器的 PATH 中未找到启动命令。若已安装，请确认安装目录在该环境的 PATH 中，再重新检测。','Launcher not found on the execution machine PATH. If it is installed, check that its directory is on that PATH and detect again.')}</small>;
   if(detail.executable==='broken')return <small>{l('启动命令的链接指向不存在的文件。','Launcher link points to a missing file.')}</small>;
   if(detail.executable==='blocked')return <small>{l('找到了启动路径，但该文件不能执行。','A launcher path exists but is not executable.')}</small>;
   if(detail.failureStage==='handshake')return <small>{l('ACP 握手未完成。请在执行机器上检查原生 CLI 的版本以及 ACP 模式能否正常启动。','The ACP handshake did not finish. On the execution machine, check the native CLI version and whether it can start in ACP mode.')}</small>;
  if(detail.failureStage==='gateway')return <small>{l('原生 Gateway 未就绪。请检查执行机器上的 Gateway、当前配置和服务商认证。','The native Gateway is not ready. Check its setup, selected profile and provider authentication on the execution machine.')}</small>;
  if(detail.capabilityIssue==='durable-resume-unsupported')return <small>{l('协议已连接，但此版本无法恢复对话。请升级到支持恢复会话的原生 CLI 或适配器。','The protocol connected, but this version cannot resume conversations. Update the native CLI or adapter to a version that supports session resume.')}</small>;
  if(detail.host==='remote')return <small>{l('远端检查未成功，本机结果不能替代。','Remote check failed; local detection is not used.')}</small>;
  if(detail.failureStage==='launch')return <small>{l('未能启动或初始化原生 CLI。请在同一台电脑检查安装及版本。','Could not start the native CLI or initialize its connection. Check its installation and supported version on this computer.')}</small>;
  if(detail.failureStage==='probe')return <small>{l('原生 CLI 未通过就绪检查。请在原生工具中检查配置和版本。','The native CLI readiness check failed. Review its native settings and supported version.')}</small>;
  if(detail.executable==='not-verified')return <small>{l('未能验证执行端。请检查这台电脑上的安装和运行设置。','The runtime could not be verified. Check its installation and runtime settings.')}</small>;
  return <small>{l('找到了启动命令，但启动或协议检查失败。','The launcher was found, but startup or its protocol check failed.')}</small>;
 }
 if(detail.auth==='native-account-ready')return <small>{l('原生账户检查通过；未运行任务。','Native account check passed; no task was run.')}</small>;
 if(detail.auth==='login-required'||detail.auth==='configuration-required')return <small>{l('需要在原生工具中完成登录或配置。','Finish sign-in or configuration in the native tool.')}</small>;
 if(detail.probe==='version-only')return <small>{l('仅检测到 CLI 可返回版本；未验证登录。','Only the CLI version check passed; sign-in was not verified.')}</small>;
 return <small>{l('连接检查通过；未验证登录或任务执行。','Connection check passed; sign-in and task execution were not verified.')}</small>;
}

export default function RuntimeSetup({cli,status}:{cli:Cli;status?:CliStatus|null}){
 const {text:l}=useLanguage(), runtime=runtimeCatalog[cli], setup=officialRuntimeSetup[cli];
 return <div className="runtime-setup-guide">
  {status&&<RuntimeProbeSummary status={status}/>}
  <small>{l('启动命令：','Launcher: ')}<code>{[runtime.command,...runtime.args].join(' ')}</code></small>
  {cli==='claude'&&<small>{l('Mandala 随包提供 ACP 桥，使用执行机器上已安装的 Claude Code。','Mandala supplies the ACP bridge and uses the Claude Code installation on the execution machine.')}</small>}
   {cli==='opencode'&&<small>{l('OpenCode CLI 内置 ACP，不需要单独安装适配器。','ACP is built into the OpenCode CLI; no separate adapter installation is required.')}</small>}
   {(cli==='gemini'||cli==='pi')&&<small>{l('此执行端的协议模式由原生 CLI 提供，不需要单独安装适配器。','The native CLI provides this protocol mode; no separate adapter installation is required.')}</small>}
   {cli!=='opencode'&&<small>{setup.source}{setup.nodeMinimum&&<> · Node.js ≥ {setup.nodeMinimum}</>}
   {setup.windowsGitBash&&<> · {l('Windows 要求 Git Bash','Windows requires Git Bash')}</>}
   {cli==='hermes'&&<> · {l('需要 Hermes ACP 扩展，以及已配置模型服务且正在运行的 Hermes Gateway','Requires the Hermes ACP extra and a running Hermes Gateway with a configured model provider')}</>}
   {cli==='openclaw'&&<> · {l('需要已配置并运行的 OpenClaw Gateway','Requires a configured, running OpenClaw Gateway')}</>}
   </small>}
   <a href={runtime.docs} target="_blank" rel="noopener noreferrer">{cli==='opencode'?l('OpenCode 官方 ACP 使用说明','Official OpenCode ACP guide'):l('官方安装说明','Official setup guide')}</a>
 </div>;
}
