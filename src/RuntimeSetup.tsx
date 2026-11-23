import type {Cli,CliStatus} from '../shared/types';
import {runtimeCatalog,officialRuntimeSetup} from '../shared/runtimes';
import {useLanguage} from './i18n';

export function RuntimeProbeSummary({status}:{status:CliStatus}){
 const {text:l}=useLanguage(), detail=status.diagnostics;
 if(!detail)return null;
 if(status.status==='unavailable'){
  if(detail.standaloneClaude)return <small>{l('找到了 Claude Code，但当前 PATH 没有可用的独立 ACP 适配器。','Claude Code was found, but the separate ACP adapter is not runnable on PATH.')}</small>;
  if(detail.host==='remote')return <small>{l('远端检查未成功，本机结果不能替代。','Remote check failed; local detection is not used.')}</small>;
  if(detail.executable==='missing')return <small>{l('执行机器的 PATH 中未找到启动命令。','Launcher not found on the execution machine PATH.')}</small>;
  if(detail.executable==='broken')return <small>{l('启动命令的链接指向不存在的文件。','Launcher link points to a missing file.')}</small>;
  if(detail.executable==='blocked')return <small>{l('找到了启动路径，但该文件不能执行。','A launcher path exists but is not executable.')}</small>;
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
  <small>{setup.source}{setup.nodeMinimum&&<> · Node.js ≥ {setup.nodeMinimum}</>}
   {setup.windowsGitBash&&<> · {l('Windows 要求 Git Bash','Windows requires Git Bash')}</>}
   {setup.method==='gateway'&&<> · {l('需要已配置并运行的原生 Gateway','Requires a configured, running native Gateway')}</>}
  </small>
  <a href={runtime.docs} target="_blank" rel="noopener noreferrer">{l('官方安装说明','Official setup guide')}</a>
 </div>;
}
