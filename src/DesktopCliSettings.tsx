import {useEffect,useRef,useState} from 'react';
import type {DesktopCli,DesktopCliStatus} from '../shared/desktop-cli';
import {SettingsGroup,SettingRow} from './ui/SettingsLayout';
import StatusLabel from './ui/StatusLabel';
import Button from './ui/Button';
import Notice from './ui/Notice';
import {useLanguage} from './i18n';

export default function DesktopCliSettings({onBusyChange}:{onBusyChange:(busy:boolean)=>void}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const bridge=(window as Window&{mandalaDesktop?:{cli?:DesktopCli}}).mandalaDesktop?.cli;
 const [status,setStatus]=useState<DesktopCliStatus>(),[checking,setChecking]=useState(!!bridge),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;if(bridge)void bridge.status().then(value=>{if(alive.current)setStatus(value);}).catch(error=>{if(alive.current)setError(error.message);}).finally(()=>{if(alive.current)setChecking(false);});return()=>{alive.current=false;};},[bridge]);
 useEffect(()=>{onBusyChange(busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
 const check=async()=>{if(!bridge)return;setChecking(true);setError('');try{setStatus(await bridge.status());}catch(error){setError((error as Error).message);}finally{setChecking(false);}};
 const install=async()=>{if(!bridge)return;setBusy(true);setError('');try{setStatus(await bridge.install());}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
 const actions=bridge?<>
  <Button disabled={busy||checking} onClick={()=>void check()}>{say('重新检查','Check again')}</Button>
  {status?.supported&&(!status.installed||status.updateAvailable)&&<Button className="primary" disabled={busy||checking||status.conflict||!status.runtimeReady} onClick={()=>void install()}>{busy?say('正在注册…','Registering…'):status.updateAvailable?say('备份并更新 mandala 命令','Back up and update mandala command'):say('注册 mandala 命令','Register mandala command')}</Button>}
 </>:undefined;
 const registration=!status?'':!status.supported?say('此平台暂不支持','Unsupported on this platform'):status.installed?say('已注册','Registered'):status.updateAvailable?say('发现旧版 Mandala 命令','Older Mandala command found'):say('未注册','Not registered');
 return <SettingsGroup title={say('mandala 命令','mandala command')} label={say('Mandala 命令行','Mandala command')} actions={actions}>
  {!bridge?<SettingRow label={say('命令注册','Registration')}><StatusLabel icon="info">{say('仅桌面版可用','Desktop only')}</StatusLabel></SettingRow>
  :checking&&!status?<SettingRow label={say('命令注册','Registration')}><StatusLabel icon="refresh">{say('正在检查命令注册…','Checking command registration…')}</StatusLabel></SettingRow>
  :status&&<>
   <SettingRow label={say('命令注册','Registration')} hint={status.supported?<code className="desktop-cli-command">{status.installed?status.command+' --help':status.launcherPath}</code>:undefined}><StatusLabel icon={status.installed?'circleCheck':'terminal'} tone={status.installed?'success':'neutral'}>{registration}</StatusLabel></SettingRow>
   <SettingRow label="PATH" hint={status.supported&&!status.inPath?say('注册不会修改 PATH 或 shell 配置。可直接使用上方完整命令，或自行将命令目录加入 PATH。','Registration does not edit PATH or shell configuration. Use the full command above or add its directory to PATH yourself.'):undefined}><StatusLabel icon="folder" tone={status.inPath&&!status.shadowed?'success':'neutral'}>{status.shadowed?say('其他命令优先','Another command takes priority'):status.inPath?say('包含命令目录','Command directory included'):say('未包含命令目录','Command directory not included')}</StatusLabel></SettingRow>
   {status.supported&&<>
    {status.shadowed&&<Notice>{say('PATH 中的另一个 mandala 命令优先：','Another mandala command takes priority in PATH: ')}<code>{status.existingCommand}</code></Notice>}
    {status.conflict&&<Notice>{say('命令路径已被其他文件占用，尚未修改。请移动该文件后重新检查，再注册 Mandala 命令。','Another file occupies the command path and has been preserved. Move it, check again, then register Mandala.')}</Notice>}
    {status.updateAvailable&&<p className="field-hint">{say('这是已识别的旧版 Mandala 启动脚本。更新会先备份原文件，再连接到当前 App 与工作区。','This is a recognized older Mandala launcher. Updating backs it up before connecting the command to this app and workspace.')}</p>}
    {status.backupPath&&<p className="field-hint">{say('原命令已备份：','Previous command backed up: ')}<code>{status.backupPath}</code></p>}
    {!status.runtimeReady&&<Notice>{say('App 自带的命令运行环境不可用，请修复桌面安装。','The bundled command runtime is unavailable. Repair the desktop installation.')}</Notice>}
   </>}
  </>}
  {error&&<p role="alert" className="form-error">{error}</p>}
 </SettingsGroup>;
}
