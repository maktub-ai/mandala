import {useState} from 'react';
import {DetailSection} from './ui/WorkspacePage';
import MetadataList from './ui/MetadataList';
import StatusLabel from './ui/StatusLabel';
import Button from './ui/Button';
import Input from './ui/Input';
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
 const checking=state?.status==='checking';
 const downloading=state?.status==='downloading',ready=state?.status==='ready';
 const update=state?.status==='available'||downloading||ready?state?.update:null;
 const latest=!state?'':checking?say('正在检查…','Checking…'):downloading?say('正在下载…','Downloading…'):ready?say('已下载，等待重启','Downloaded, awaiting restart'):update?say(`${update.version} 可下载`,`${update.version} available`):state.status==='current'?say('已是最新版本','Up to date'):state.status==='error'?say('检查失败','Check failed'):say('尚未检查','Not checked yet');
 return <DetailSection title={say('关于与更新','About and updates')}>
  <p className="field-hint">{say('Mandala 会在启动后检查一次新版本，之后每 6 小时检查一次。','Mandala checks for a new version shortly after it starts, then every 6 hours.')}</p>
  {!bridge?<StatusLabel icon="info">{say('仅桌面版可用','Desktop only')}</StatusLabel>:!state?<StatusLabel icon="refresh">{say('正在读取版本信息…','Reading version information…')}</StatusLabel>:<>
   <MetadataList items={[
    {label:say('当前版本','Current version'),value:state.current,icon:'info'},
    {label:say('最新版本','Latest version'),value:latest,icon:update?'download':'circleCheck'},
    {label:say('上次检查','Last checked'),value:state.checkedAt?when(state.checkedAt):say('从未','Never'),icon:'clock'},
   ]}/>
   {!state.supported&&<Notice>{say('此平台暂无安装包，请从源码更新。','No installer is published for this platform. Update from source.')}</Notice>}
   {update&&!update.local&&<p className="field-hint">{say(`安装包 ${megabytes(update.size)}。下载后，先从菜单选择“Stop runtime and quit…”，再用新安装包替换 Mandala；项目、对话和设置都会保留。`,`Installer ${megabytes(update.size)}. After downloading, choose “Stop runtime and quit…” from the menu, then replace Mandala with the new installer. Projects, chats and settings are kept.`)}</p>}
   {ready&&<Notice>{say('退出并重新打开 Mandala 即可安装更新。后台有活动时，安装会延后。','Quit and reopen Mandala to install the update. If the runtime is busy, installation will wait.')}</Notice>}
   {state.status==='error'&&<p className="field-hint">{say('暂时连不上发布服务，请检查网络后重试。不影响继续使用。','Could not reach the release service. Check your connection and try again; Mandala keeps working.')}</p>}
   <label className="voice-enable"><Input type="checkbox" checked={state.autoCheck} disabled={busy||!state.supported} onChange={event=>void run(()=>bridge.setAutoCheck(event.target.checked))}/>{say('自动检查更新','Check for updates automatically')}</label>
   <div className="desktop-cli-actions">
    {update&&!ready&&<Button className="primary" disabled={busy||downloading} onClick={()=>void run(bridge.download)}><Icon name="download" size={15}/>{downloading?say('正在下载…','Downloading…'):say(`下载 ${update.version}`,`Download ${update.version}`)}</Button>}
    <Button disabled={busy||checking||downloading||ready||!state.supported} onClick={()=>void run(bridge.check)}>{checking?say('正在检查…','Checking…'):say('检查更新','Check for updates')}</Button>
    {update&&!update.local&&<a className="desktop-update-notes" href={update.notes} target="_blank" rel="noopener noreferrer">{say('发行说明','Release notes')}<Icon name="external-link" size={14}/></a>}
   </div>
  </>}
  {error&&<p role="alert">{error}</p>}
 </DetailSection>;
}
