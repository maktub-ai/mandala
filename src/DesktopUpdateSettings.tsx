import {useState} from 'react';
import {SettingsGroup,SettingRow,SettingSwitch} from './ui/SettingsLayout';
import StatusLabel from './ui/StatusLabel';
import Button from './ui/Button';
import Notice from './ui/Notice';
import Icon from './ui/Icon';
import {useLanguage} from './i18n';
import {desktopUpdates,useDesktopUpdate} from './desktopUpdates';

const megabytes=(size:number)=>(size/1024/1024).toFixed(size>=100*1024*1024?0:1)+' MB';

/** Current version, the newest installer for this computer, and when Mandala last looked. */
export default function DesktopUpdateSettings(){
 const {text:say,language}=useLanguage();
 const bridge=desktopUpdates();
 const [state,setState]=useDesktopUpdate();
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const run=async(action:()=>Promise<typeof state>)=>{setBusy(true);setError('');try{const value=await action();if(value)setState(value);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}};
 const when=(time:number)=>new Date(time).toLocaleString(language==='zh-CN'?'zh-CN':'en',{dateStyle:'medium',timeStyle:'short'});
 const checking=state?.status==='checking',handoff=state?.status==='handoff';
 const downloading=state?.status==='downloading',installing=state?.status==='installing',ready=state?.status==='ready'||installing;
 const update=state?.status==='available'||downloading||ready?state?.update:null;
 const externalInstaller=update&&!update.local&&!update.publicMac&&!update.publicWindows?update:null;
 const latest=!state?'':checking?say('正在检查…','Checking…'):installing?say('正在安装…','Installing…'):downloading?say('正在下载…','Downloading…'):handoff?say('安装程序正在启动','Installer starting'):ready?say('已下载，等待重启','Downloaded, awaiting restart'):update?say(`${update.version} 可下载`,`${update.version} available`):state.status==='current'?say('已是最新版本','Up to date'):state.status==='error'?say('检查失败','Check failed'):say('尚未检查','Not checked yet');
 const actions=bridge&&state?<>
   {update&&!ready&&<Button className="primary" disabled={busy||downloading} onClick={()=>void run(bridge.download)}><Icon name="download" size={15}/>{downloading?say('正在下载…','Downloading…'):externalInstaller?say(`打开 ${update.version} 安装包下载`,`Open installer download for ${update.version}`):say(`下载 ${update.version}`,`Download ${update.version}`)}</Button>}
   {(update?.publicMac||update?.publicWindows)&&ready&&<Button className="primary" disabled={busy||installing} onClick={()=>void run(bridge.install)}><Icon name="refresh" size={15}/>{installing?say('正在安装…','Installing…'):say('安装并重启','Install and restart')}</Button>}
   <Button disabled={busy||checking||downloading||ready||handoff||state.error==='signed_handoff_unknown'||!state.supported} onClick={()=>void run(bridge.check)}>{checking?say('正在检查…','Checking…'):say('检查更新','Check for updates')}</Button>
  </>:undefined;
 return <SettingsGroup title={say('版本','Version')} label={say('关于与更新','About and updates')} actions={actions} description={say('Mandala 会在启动后检查一次新版本，之后每 6 小时检查一次。','Mandala checks for a new version shortly after it starts, then every 6 hours.')}>
  {!bridge?<SettingRow label={say('桌面版更新','Desktop updates')}><StatusLabel icon="info">{say('仅桌面版可用','Desktop only')}</StatusLabel></SettingRow>:!state?<SettingRow label={say('版本信息','Version information')}><StatusLabel icon="refresh">{say('正在读取版本信息…','Reading version information…')}</StatusLabel></SettingRow>:<>
   <SettingRow label={say('当前版本','Current version')}><span className="setting-row-value">{state.current}</span></SettingRow>
   <SettingRow label={say('最新版本','Latest version')} hint={update&&!update.local?<a className="desktop-update-notes" href={update.notes} target="_blank" rel="noopener noreferrer">{say('发行说明','Release notes')}<Icon name="external-link" size={14}/></a>:undefined}><span className="setting-row-value">{latest}</span></SettingRow>
   <SettingRow label={say('上次检查','Last checked')}><span className="setting-row-value">{state.checkedAt?when(state.checkedAt):say('从未','Never')}</span></SettingRow>
   <SettingSwitch label={say('自动检查更新','Check for updates automatically')} checked={state.autoCheck} disabled={busy||!state.supported} onChange={checked=>void run(()=>bridge.setAutoCheck(checked))}/>
   {!state.supported&&<Notice>{say('此平台暂无安装包，请从源码更新。','No installer is published for this platform. Update from source.')}</Notice>}
   {state.channel==='installer'&&<p className="field-hint">{say('此版本支持在 Mandala 内检查更新，下载和安装需在应用外完成。','This version can check for updates in Mandala. Downloads and installation take place outside the app.')}</p>}
   {externalInstaller&&<p className="field-hint">{say(`安装包 ${megabytes(externalInstaller.size)}。下载后，先从菜单选择“Stop runtime and quit…”，再用新安装包替换 Mandala；项目、对话和设置都会保留。`,`Installer ${megabytes(externalInstaller.size)}. After downloading, choose “Stop runtime and quit…” from the menu, then replace Mandala with the new installer. Projects, chats and settings are kept.`)}</p>}
   {ready&&<Notice tone="info">{(update?.publicMac||update?.publicWindows)?say('更新已验证。选择安装并重启；后台有活动时，不会替换当前版本。','The update is verified. Choose Install and restart. Mandala will not replace the current app while the runtime is busy.'):say('退出并重新打开 Mandala 即可安装更新。后台有活动时，安装会延后。','Quit and reopen Mandala to install the update. If the runtime is busy, installation will wait.')}</Notice>}
   {handoff&&<Notice tone="info">{say('已交给安装程序，尚未确认安装完成。','Handed off to the installer. Installation has not yet been verified.')}</Notice>}
   {state.status==='error'&&<p className="field-hint">{state.error==='signed_handoff_unknown'?say('无法确认安装程序是否已打开。请先在 Windows 中确认，不要重复启动安装。','Could not confirm that the installer opened. Check Windows before trying again.'):state.error==='signed_verification'?say('无法验证签名更新。当前应用未更改，请稍后重试。','Could not verify the signed update. The current app was not changed; try again later.'):say('暂时连不上发布服务，请检查网络后重试。不影响继续使用。','Could not reach the release service. Check your connection and try again; Mandala keeps working.')}</p>}
  </>}
  {error&&<p role="alert" className="form-error">{error}</p>}
 </SettingsGroup>;
}
