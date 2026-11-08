import { AccountAvatar, AvatarEditor, accountInitial } from './AccountAvatar';
import { CloudSignIn, DesktopSignIn, DesktopApproval, desktopAccount } from './AccountSignIn';
import Input from './ui/Input';
import Button from './ui/Button';
import { startPolling } from './polling';
import { useEffect, useRef, useState } from 'react';
import App from './App';
import BrandMark from './ui/BrandMark';
import Dialog from './Dialog';
import Icon from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import {PageHeader,DetailSection} from './ui/WorkspacePage';
import Select from './ui/Select';
import Disclosure from './ui/Disclosure';
import { useLanguage } from './i18n';
import LoadingState from './ui/LoadingState';
import './personal-access.css';
import RemoteWorkspace from './RemoteWorkspace';
import { getRemoteBrowserKey, remoteKeyFingerprint } from './remote-client';

type Device = { id: string; name: string; online: boolean; grant: string };
type Session = {
  mode: 'fixture' | 'local' | 'control' | 'desktop'; user: { id: string; username: string; avatarUrl?: string } | null;
  providers?: {google:boolean;github:boolean;email:boolean}; partition?:string;
  preview?: boolean; csrfToken?: string; computerName?: string; provisioned?: boolean; revocationPending?: boolean; devices?: Device[]; selectedDeviceId?: string | null;
  setup?: { available: boolean; token?: string };
  connection?: { device: Device; controlUrl: string; status?: { state: string }; pairingCode?: string } | null;
};
type Grant = { clientId: string; status: string; requestedAt: string; publicKey?: string };

export default function PersonalAccess() {
  const {text: localize,  language } = useLanguage(), en = language !== 'zh-CN', l = (zh: string, english: string) => localize(zh, english);
  const [session, setSession] = useState<Session | null>(null), [error, setError] = useState('');
  const [avatar, setAvatar] = useState<{userId: string; value?: string}>();
  const avatarLoad = useRef<AbortController | null>(null);
  const desktopUserId = session?.mode === 'desktop' ? session.user?.id : undefined;
  useEffect(() => {
    if (!desktopUserId) return;
    const controller = new AbortController();
    avatarLoad.current = controller;
    void fetch('/auth/avatar', {signal:controller.signal}).then(async response => {
      if (!response.ok) return;
      const {avatar:value} = await response.json();
      if (!controller.signal.aborted) setAvatar({userId:desktopUserId, value:value ?? undefined});
    }).catch(() => {});
    return () => controller.abort();
  }, [desktopUserId]);
  const customAvatar = desktopUserId && avatar?.userId === desktopUserId ? avatar.value : undefined;
  const saveAvatar = async (value: string | null) => {
    if (!desktopUserId) throw Error('Sign in required');
    const load = avatarLoad.current;
    const response = await fetch('/auth/avatar', {
      method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':session?.csrfToken ?? ''},
      body:JSON.stringify({avatar:value}),
    });
    if (!response.ok) throw Error('Could not save avatar');
    if (avatarLoad.current === load) {
      load?.abort();
      setAvatar({userId:desktopUserId, value:value ?? undefined});
    }
  };

  useEffect(() => { document.title = session?.preview ? l('Mandala · 隔离验收环境', 'Mandala · Isolated acceptance preview') : 'Mandala'; }, [session?.preview, language]);
  useEffect(()=>{if(session?.mode==='desktop'&&session.partition&&desktopAccount()?.partition!==session.partition)void desktopAccount()?.restart();},[session?.partition]);
  const [busy, setBusy] = useState(false), [panel, setPanel] = useState(false), [choose, setChoose] = useState(false);
  const [connectionMode, setConnectionMode] = useState('official'), [grants, setGrants] = useState<Grant[]>([]);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const accountReturnFocus=useRef<HTMLElement|null>(null);
  const sessionGeneration = useRef(0);
  const [browserKey, setBrowserKey] = useState<{ publicKey: string; secretKey: string }>();
  const [pinnedHost, setPinnedHost] = useState(''), [pairingCode, setPairingCode] = useState('');
  const pinName = (id: string) => `mandala-host-key:${location.origin}:${id}`;
  useEffect(() => {
    if (session?.mode !== 'control' || !session.user) return;
    void getRemoteBrowserKey().then(setBrowserKey).catch(reason => setError(String(reason)));
  }, [session?.mode, session?.user?.id]);
  useEffect(() => {
    setPinnedHost(session?.selectedDeviceId ? localStorage.getItem(pinName(session.selectedDeviceId)) ?? '' : '');
    setPairingCode('');
  }, [session?.selectedDeviceId]);
  const refresh = async (signal?: AbortSignal) => {
    const generation = ++sessionGeneration.current;
    const response = await fetch('/auth/session', { signal });
    if (!response.ok) throw new Error(l('无法读取账号状态，请确认 Mandala 正在运行后重试。', 'Cannot read account status. Check that Mandala is running, then retry.'));
    const value = await response.json();
    if (!signal?.aborted && generation === sessionGeneration.current) setSession(value);
  };
  const errorMessage = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const messages: Record<string, string> = {
      'Invalid account or password': l('账号或密码不正确，请检查后重试。', 'The account or password is incorrect. Check them and try again.'),
      'Connection service login failed': l('服务账号登录失败，请检查服务账号与密码后重试。', 'Service sign-in failed. Check the service account and password, then retry.'),
      'Computer enrollment failed': l('电脑关联失败，请检查自部署服务状态后重试。', 'Computer registration failed. Check your self-hosted service, then retry.'),
      'Use HTTPS for the connection service': l('请输入自部署服务的 HTTPS 地址。', 'Enter the HTTPS address of your self-hosted service.'),
      'Request verification required': l('登录状态已变化，请刷新页面后重试。', 'Your session has changed. Refresh the page and retry.'),
      'Invalid computer name': l('请输入 1–128 个字符的电脑名称。', 'Enter a computer name of 1–128 characters.'),
      'Could not rename this computer': l('无法保存电脑名称。请检查连接服务是否在线并已更新。', 'Could not save the computer name. Check that your connection service is online and up to date.'),
      'Sign in required': l('登录已失效，请刷新页面并重新登录。', 'Your session has expired. Refresh the page and sign in again.'),
      'Try again later': l('尝试过于频繁，请稍等一分钟后重试。', 'Too many attempts. Wait one minute and try again.'),
      'This personal workspace belongs to another account': l('此工作区属于其他本地账号，请使用原账号登录。', 'This workspace belongs to another local account. Sign in with that account.'),
      'Failed to fetch': l('无法连接服务，请确认服务正在运行后重试。', 'Cannot reach the service. Check that it is running, then retry.'),
      'fetch failed': l('无法连接自部署服务，请检查地址与网络后重试。', 'Cannot reach your self-hosted service. Check its address and your network, then retry.'),
      'First-use verification required': l('本次初始化授权已失效，请退出并重新启动 Mandala 后重试。', 'Setup authorization has expired. Quit and restart Mandala, then retry.'),
      'Workspace already has an owner': l('这台电脑已创建本地身份。请刷新账号状态，然后登录。', 'This computer already has a local identity. Refresh account status, then sign in.'),
      'Use a valid account name and a password of 12–1024 characters': l('请使用有效的账号名称，并输入 12–1024 位密码。', 'Use a valid account name and a password of 12–1024 characters.'),
    };
    return messages[message] ?? message;
  };
  const action = async (path: string, body?: unknown) => {
    sessionGeneration.current++;
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrfToken ?? '', ...(path === '/auth/setup' ? { 'X-Setup-Token': session?.setup?.token ?? '' } : {}) }, body: JSON.stringify(body ?? {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? l('服务未完成请求，请稍后重试。', 'The service could not complete the request. Try again.'));
    try { await refresh(); } catch { throw new Error(l('请求已被接受，但无法刷新账号状态。请刷新页面确认结果。', 'The request was accepted, but account status could not refresh. Reload the page to check the result.')); }
    return data;
  };
  const perform = async (work: () => Promise<unknown>, failure = l('操作失败', 'Action failed')) => {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { setError(`${failure}: ${errorMessage(reason)}`); } finally { setBusy(false); }
  };
  const readGrants = async (signal?: AbortSignal) => {
    const response = await fetch('/auth/access', { signal });
    if (!response.ok) throw new Error(l('无法读取电脑授权，请刷新重试。', 'Cannot read computer access. Refresh to retry.'));
    const value = await response.json();
    if (!signal?.aborted) setGrants(value.grants);
  };
  useEffect(() => {
    const controller = new AbortController();
    const update = () => { void refresh(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); };
    update(); addEventListener('focus', update);
    return () => { sessionGeneration.current++; controller.abort(); removeEventListener('focus', update); };
  }, []);
  useEffect(() => {
    if (!session?.user || session.mode === 'fixture') return;
    return startPolling(signal => refresh(signal).catch(() => {}), 5000, { immediate: false });
  }, [session?.user?.id, session?.mode]);
  useEffect(() => {
    if (!panel || !['local','desktop'].includes(session?.mode??'') || !session?.connection) return;
    return startPolling(signal => readGrants(signal), 3000, { onError: reason => setError(errorMessage(reason)) });
  }, [panel, session?.mode, session?.connection?.device.id]);
  useEffect(() => { if (error) errorNotice.current?.focus(); }, [error]);
  const fields = (form: HTMLFormElement) => Object.fromEntries(new FormData(form));
  const accountFields = (service = false, creating = false) => <>
    <label>{service ? l('服务账号', 'Service account') : l('账号', 'Account')}<Input name="username" autoComplete={service ? 'section-service username' : 'username'} required maxLength={128} autoCapitalize="none" spellCheck={false} pattern={creating ? '[a-zA-Z0-9_.@\\-]+' : undefined} aria-describedby={creating ? 'personal-setup-help' : undefined} /></label>
    <label>{service ? l('服务密码', 'Service password') : l('密码', 'Password')}<Input name="password" type="password" autoComplete={creating ? 'new-password' : 'current-password'} required minLength={creating ? 12 : undefined} maxLength={1024} aria-describedby={creating ? 'personal-setup-help' : undefined} /></label>
  </>;
  const heading=(title:string,icon:'user'|'link'|'agent'='user')=><PageHeader title={title} icon={icon}/>;
  const brand = <div className="personal-brand"><BrandMark /><span>Mandala</span></div>;
  const notice = error ? <p ref={errorNotice} tabIndex={-1} role="alert" className="personal-error">{error}</p> : null;
  const officialNotice = <p className="personal-caption">{l('官方连接服务尚未开放。', 'The official connection service is not available yet.')}</p>;
  const closePanel = () => {const account=document.querySelector<HTMLButtonElement>('.sidebar-account'),opener=document.querySelector<HTMLButtonElement>('main .mobile-menu'),remote=document.querySelector<HTMLButtonElement>('.remote-header .remote-actions button:last-child');const candidates=opener?.getClientRects().length?[opener,account,remote]:[account,remote,opener];accountReturnFocus.current=candidates.find(button=>button?.isConnected&&button.getClientRects().length&&!button.disabled)??null;setPanel(false);setError('');};
  const signOut = () => perform(async () => { if(session?.mode==='desktop'&&!window.confirm(l('退出将停止此账号的本地任务、终端和远程连接。确定退出？','Signing out stops this account’s local tasks, terminals and remote connection. Sign out?')))return; await action('/auth/logout'); setPanel(false); setChoose(false); }, l('退出失败', 'Sign-out failed'));
  const grantLabel = (status: string) => ({ pending: l('等待电脑确认', 'Waiting for computer approval'), approved: l('已授权', 'Approved'), denied: l('已拒绝', 'Denied'), revoked: l('已撤销', 'Revoked') })[status] ?? l('尚未授权', 'Not approved');
  const connectionLabel = (state?: string) => ({ connecting: l('正在连接', 'Connecting'), connected: l('已连接', 'Connected'), offline: l('连接中断，正在重连', 'Offline, reconnecting'), closed: l('已断开', 'Disconnected') })[state ?? ''] ?? l('连接状态未知', 'Connection status unknown');

  const previewNotice = session?.preview ? <aside className="personal-preview-notice" role="note" aria-label={l('隔离验收环境', 'Isolated acceptance preview')}><Icon name="info" size={16}/><div><strong>{l('隔离验收环境', 'Isolated acceptance preview')}</strong><p>{l('此环境只含合成数据，不包含日常账号。请勿在此输入日常账号或密码；日常使用请关闭此验收窗口，打开原有安装。', 'This environment contains synthetic data, not your daily account. Do not enter your daily credentials here. Close this preview and open your existing installation for everyday work.')}</p></div></aside> : null;

  if (!session) return <main className="personal-access"><section className="personal-card">{brand}{notice ?? <LoadingState label={l('读取账号状态…', 'Loading account…')} />}{error && <Button disabled={busy} onClick={() => void perform(refresh, l('读取账号失败', 'Account loading failed'))}>{l('重试', 'Retry')}</Button>}</section></main>;
  if (session.mode === 'fixture') return <App />;
  if(session.mode==='desktop'&&!session.user)return <DesktopSignIn/>;
  if(session.mode==='control'&&!session.user&&session.providers&&Object.values(session.providers).some(Boolean))return <CloudSignIn providers={session.providers} onSignedIn={refresh}/>;
  const desktopCode=new URLSearchParams(location.search).get('device')??sessionStorage.getItem('mandala-desktop-request');
  if(session.mode==='control'&&session.user&&desktopCode&&/^[A-F0-9]{16}$/.test(desktopCode))return <DesktopApproval code={desktopCode} csrfToken={session.csrfToken??''} username={session.user.username}/>;
  if (!session.user) return <main className="personal-access"><section className="personal-card">
    {brand}{previewNotice}
    {session.mode === 'local' && session.provisioned === false ? <>
      {heading(l('开始使用 Mandala', 'Get started with Mandala'),'agent')}
      <p>{l('先创建这台电脑的本地身份。对话、记忆和文件保留在这台电脑，使用本机无需连接服务。', 'Create a local identity for this computer. Chats, memory and files stay here. No connection service is needed for local use.')}</p>
      {session.setup?.available && session.setup.token ? <form onSubmit={event => { event.preventDefault(); void perform(() => action('/auth/setup', fields(event.currentTarget)), l('创建本地身份失败', 'Local identity setup failed')); }}>
        {accountFields(false, true)}
        <p id="personal-setup-help" className="personal-caption">{l('账号使用字母、数字或 _ . @ -；密码至少 12 位。请保存好本地账号和密码。', 'Use letters, numbers or _ . @ - for your account and at least 12 characters for your password. Keep your local account and password safe.')}</p>
        {notice}<Button type="submit" className="primary" disabled={busy}>{busy ? l('正在创建…', 'Creating…') : l('创建本地身份', 'Create local identity')}</Button>
        {error && <Button type="button" disabled={busy} onClick={() => void perform(refresh, l('读取账号失败', 'Account loading failed'))}>{l('刷新账号状态', 'Refresh account status')}</Button>}
      </form> : <>
      <p>{l('此窗口暂不能创建本地身份。请从 Mandala 桌面应用打开；从源码运行时，可按下方步骤在本机终端初始化。', 'Local setup is unavailable in this window. Open Mandala from the desktop app. If running from source, follow the terminal steps below.')}</p>
      <Disclosure title={l('macOS / zsh 终端初始化', 'macOS / zsh terminal setup')}>
        <p>{l('在 Mandala 源码目录操作，数据目录必须与启动服务时一致。账号名称使用字母、数字或 _ . @ -；密码至少 12 位，只在本机终端输入。', 'Run in your Mandala source checkout, using the same data directory as the running service. Use letters, numbers or _ . @ - in the account name. Enter a password of at least 12 characters only in your local terminal.')}</p>
        <pre>{`read 'mandala_home?Mandala data directory: '\nread 'mandala_user?Local account: '\nread -s 'mandala_password?Password (12+ characters): '\nprint -rn -- "$mandala_password" | npm run account:admin -- --home "$mandala_home" --username "$mandala_user"\nunset mandala_password`}</pre>
      </Disclosure>
      {notice}<Button className="primary" disabled={busy} onClick={() => void perform(refresh, l('检查初始化失败', 'Setup check failed'))}>{l('已创建，刷新', 'Created, refresh')}</Button>
      </>}
    </> : <>
      {heading(l('登录 Mandala', 'Sign in to Mandala'),'user')}
      <p>{session.mode === 'local' ? l('使用这台电脑的本地账号，继续你的工作。', 'Use this computer’s local account to continue your work.') : l('使用此连接服务的账号登录，再选择已授权的电脑。', 'Sign in with an account for this connection service, then choose an approved computer.')}</p>
      <form onSubmit={event => { event.preventDefault(); void perform(() => action('/auth/login', fields(event.currentTarget)), l('登录失败', 'Sign-in failed')); }}>
        {accountFields()}{notice}<Button type="submit" className="primary" disabled={busy}>{busy ? l('正在登录…', 'Signing in…') : l('登录', 'Sign in')}</Button>
      </form>
      {session.mode === 'local' && <p className="personal-caption">{l('本地身份只保护这台电脑的工作区，与自部署连接服务的账号独立。', 'Your local identity protects this computer’s workspace and is separate from a self-hosted service account.')}</p>}
    </>}
  </section></main>;

  const devices = <section className="personal-card">{brand}{previewNotice}{heading(l('连接电脑', 'Connect a computer'),'link')}<p>{l('电脑需保持在线。首次连接请在电脑的“账号与连接”中批准此浏览器。', 'Keep your computer online. For first access, approve this browser in “Account and connection” on that computer.')}</p>
    {session.devices?.length ? session.devices.map(device => <div className="personal-device" key={device.id}><div><strong>{device.name}</strong><p>{<StatusLabel icon={device.online?"circleCheck":"clock"} tone={device.online?"active":"neutral"}>{device.online?l('在线','Online'):l('离线，请启动电脑上的 Mandala','Offline — start Mandala on the computer')}</StatusLabel>} · {grantLabel(device.grant)}</p></div>
      {['none', 'denied', 'revoked'].includes(device.grant) ? <Button disabled={busy || !device.online || !browserKey} onClick={() => void perform(() => action(`/connect/devices/${device.id}/request`, { publicKey: browserKey?.publicKey }), l('请求授权失败', 'Access request failed'))}>{l('请求授权', 'Request access')}</Button> : <Button disabled={busy || !device.online || device.grant !== 'approved'} onClick={() => void perform(async () => { await action('/connect/select', { deviceId: device.id }); setChoose(false); setPanel(false); }, l('连接电脑失败', 'Computer connection failed'))}>{l('连接', 'Connect')}</Button>}
    </div>) : <p>{l('尚未关联电脑。请在电脑的“账号与连接”中选择自部署服务，并连接到当前服务。', 'No computer is linked. Choose a self-hosted service in “Account and connection” on your computer and connect it to this service.')}</p>}
    {browserKey && <p className="personal-caption">{l('本浏览器指纹（请在电脑上核对）', 'Browser fingerprint (verify on the computer)')}<br /><code>{remoteKeyFingerprint(browserKey.publicKey)}</code></p>}
    {notice}<div className="personal-actions"><Button disabled={busy} onClick={() => void perform(refresh, l('刷新电脑失败', 'Computer refresh failed'))}>{l('刷新', 'Refresh')}</Button><Button disabled={busy} onClick={() => void signOut()}>{l('退出登录', 'Sign out')}</Button>{choose && session.selectedDeviceId && <Button onClick={() => setChoose(false)}>{l('返回', 'Back')}</Button>}</div>
  </section>;
  if (session.mode === 'control' && (!session.selectedDeviceId || choose)) return <main className="personal-access">{devices}</main>;
  if (session.mode === 'control' && (!pinnedHost || !browserKey)) return <main className="personal-access"><section className="personal-card">{brand}{previewNotice}{heading(l('配对这台电脑', 'Pair this computer'),'link')}<p>{l('在电脑的“账号与连接”中复制配对码，直接粘贴到这里。请通过你信任的本地屏幕取得配对码。', 'Copy the pairing code from “Account and connection” on your computer and paste it here. Get it directly from the trusted local screen.')}</p><form onSubmit={event => { event.preventDefault(); void perform(async () => {
    const code = pairingCode.trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(code) || atob(code).length !== 32 || !session.selectedDeviceId) throw new Error(l('配对码无效，请从电脑重新复制。', 'Invalid pairing code. Copy it again from the computer.'));
    localStorage.setItem(pinName(session.selectedDeviceId), code); setPinnedHost(code);
  }, l('配对失败', 'Pairing failed')); }}><label>{l('电脑配对码', 'Computer pairing code')}<Input value={pairingCode} onChange={event => setPairingCode(event.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" required /></label>{notice}<Button type="submit" className="primary" disabled={busy || !browserKey}>{l('确认配对', 'Confirm pairing')}</Button></form><Button onClick={() => setChoose(true)}>{l('选择其他电脑', 'Choose another computer')}</Button></section></main>;
  const userInitial = accountInitial(session.user.username);
  return <div className="personal-shell">{session.mode === 'control' && browserKey ? <RemoteWorkspace userId={session.user.id} deviceId={session.selectedDeviceId!} key={session.selectedDeviceId} hostOnline={session.devices?.find(device=>device.id===session.selectedDeviceId)?.online} hostPublicKey={pinnedHost} keyPair={browserKey} computerName={(session.devices?.find(device => device.id === session.selectedDeviceId)?.name ?? 'Mandala') + (session.preview ? l(' · 隔离验收', ' · Acceptance preview') : '')} onAccount={() => { setError(''); setPanel(true); }} /> : <App draftIdentity={session.user.id} key={session.mode === 'control' ? session.selectedDeviceId : session.user.id} userInitial={userInitial} account={{username:session.user.username,status:session.preview ? l('隔离验收 · 合成数据', 'Acceptance preview · Synthetic data') : session.mode === 'control' ? session.devices?.find(device => device.id === session.selectedDeviceId)?.name ?? l('离线','Offline') : l('本机','This computer'),avatar:customAvatar || session.user.avatarUrl,onOpen:()=>{setError('');setPanel(true);}}} />}
    {panel && <Dialog label={l('账号与连接', 'Account and connection')} className="personal-account-panel" returnFocusRef={accountReturnFocus} onClose={closePanel} locked={busy}>
      <div className="personal-heading"><h1>{l('账号与连接', 'Account and connection')}</h1><Button type="button" className="icon-button" aria-label={l('关闭', 'Close')} onClick={closePanel} disabled={busy}><Icon name="close" size={18} /></Button></div>
      {previewNotice}<p className="personal-identity"><AccountAvatar name={session.user.username} source={customAvatar || session.user.avatarUrl} className="sidebar-account-avatar" />{session.user.username}<span>{session.mode === 'desktop' ? l('Mandala 账号','Mandala account') : session.mode === 'local' ? l('本地身份', 'Local identity') : l('服务账号', 'Service account')}</span></p>
      {session.mode === 'desktop' && <AvatarEditor key={session.user.id} name={session.user.username} providerUrl={session.user.avatarUrl} custom={customAvatar} save={saveAvatar} />}
      {session.mode === 'control' ? <><Button onClick={() => { setChoose(true); setPanel(false); }}>{l('选择电脑', 'Choose computer')}</Button><Button onClick={() => { if (session.selectedDeviceId) localStorage.removeItem(pinName(session.selectedDeviceId)); setPinnedHost(''); setPanel(false); }}>{l('重新配对电脑', 'Pair computer again')}</Button></> : session.connection ? <>
        <div><h2>{session.connection.device.name}</h2><p>{connectionLabel(session.connection.status?.state)}</p><p className="personal-service-url"><code>{session.connection.controlUrl}</code></p><a className="personal-link" href={session.connection.controlUrl} target="_blank" rel="noreferrer">{l('打开手机连接地址', 'Open phone connection address')}<Icon name="external-link" size={16} /></a></div>
        <Disclosure title={l('重命名电脑', 'Rename computer')}><form onSubmit={event => {
          event.preventDefault();
          void perform(() => action('/auth/connection/name', fields(event.currentTarget)));
        }}>
          <label>{l('电脑名称', 'Computer name')}<Input name="name" key={session.connection.device.name} defaultValue={session.connection.device.name} required maxLength={128} autoComplete="off" /></label>
          <Button type="submit" disabled={busy}>{l('保存名称', 'Save name')}</Button>
        </form></Disclosure>
        {session.connection.pairingCode && <section><h2>{l('电脑配对码', 'Computer pairing code')}</h2><p>{l('批准手机浏览器后，将此配对码直接复制到手机；连接服务不能替你确认电脑身份。', 'After approving the phone browser, copy this code directly to it to verify this computer.')}</p><pre aria-label={l('电脑配对码', 'Computer pairing code')}>{session.connection.pairingCode}</pre></section>}
        <DetailSection title={l('设备授权', 'Device access')} icon="users"><section className="personal-grants"><p>{l('只批准你刚发起的浏览器请求。撤销后，该浏览器将无法继续访问这台电脑。', 'Approve only a browser request you just made. Revoking access blocks that browser from this computer.')}</p>
          {grants.length ? grants.map(grant => <div className="personal-device" key={grant.clientId}><div><strong>{l('浏览器', 'Browser')} {grant.clientId.slice(0, 12)}</strong><p>{grantLabel(grant.status)} · {new Date(grant.requestedAt).toLocaleString(en ? 'en' : 'zh-CN')}</p>{grant.publicKey && <p><code>{remoteKeyFingerprint(grant.publicKey)}</code></p>}</div><div className="personal-actions">{grant.status !== 'approved' ? <><Button disabled={busy} onClick={() => void perform(async () => { await action('/auth/access', { clientId: grant.clientId, state: 'approved', publicKey: grant.publicKey }); await readGrants(); }, l('批准失败', 'Approval failed'))}>{l('批准', 'Approve')}</Button><Button disabled={busy} onClick={() => void perform(async () => { await action('/auth/access', { clientId: grant.clientId, state: 'denied' }); await readGrants(); }, l('拒绝失败', 'Denial failed'))}>{l('拒绝', 'Deny')}</Button></> : <Button disabled={busy} onClick={() => void perform(async () => { await action('/auth/access', { clientId: grant.clientId, state: 'revoked' }); await readGrants(); }, l('撤销失败', 'Revocation failed'))}>{l('撤销', 'Revoke')}</Button>}</div></div>) : <p>{l('暂无设备连接请求', 'No device access requests')}</p>}
        </section></DetailSection>
        <Button disabled={busy} onClick={() => void perform(async () => { await action('/auth/disconnect'); setConnectionMode('local'); }, l('断开服务失败', 'Disconnect failed'))}>{l('断开服务，回到仅本机', 'Disconnect and use locally')}</Button>
      </> : session.mode==='desktop' ? <><p>{l('关联此账号与电脑后，可从其他设备请求远程访问。对话和任务仍保留在本机。','Link this computer to your account to request remote access from other devices. Conversations and tasks stay here.')}</p><form onSubmit={event=>{event.preventDefault();void perform(()=>action('/auth/connect',fields(event.currentTarget)));}}><label>{l('电脑名称','Computer name')}<Input name="name" defaultValue={session.computerName} required maxLength={128} autoComplete="off"/></label><Button type="submit" disabled={busy}>{l('关联这台电脑','Link this computer')}</Button></form></> : <>
        <div className="personal-field"><span>{l('连接方式', 'Connection mode')}</span><Select ariaLabel={l('连接方式', 'Connection mode')} value={connectionMode} onChange={value => { setConnectionMode(value); setError(''); }} searchable={false} disabled={busy} options={[{ value: 'local', label: l('仅本机', 'This computer only') }, { value: 'official', label: l('官方连接服务（尚未开放）', 'Official service (unavailable)') }]} /></div>
        {connectionMode === 'local' ? <p>{l('可以直接在这台电脑使用 Mandala。对话、记忆、文件和执行保留在本机；无需配置连接服务。', 'Use Mandala directly on this computer. Chats, memory, files and execution stay here. No connection service is required.')}</p> : <>{officialNotice}</>}
        <p className="personal-caption">{l('仅在需要远程访问时配置连接。本机使用无需官方账号。', 'Configure a connection only for remote access. Local use requires no official account.')}</p>
        <Disclosure title={l('高级：自部署连接服务', 'Advanced: self-hosted connection service')}><form onSubmit={event => { event.preventDefault(); void perform(() => action('/auth/connect', fields(event.currentTarget)), l('连接服务失败', 'Service connection failed')); }}>
          <p>{l('用你部署的服务从手机或其他浏览器访问这台电脑。服务负责账号验证和请求转发，工作数据仍保留在本机。', 'Use your own service to access this computer from a phone or another browser. It authenticates and relays requests; your work data stays on this computer.')}</p>
          <label>{l('账号服务地址', 'Account service URL')}<Input name="controlUrl" type="url" required placeholder="https://…" autoCapitalize="none" spellCheck={false} /></label>
          <label>{l('电脑名称', 'Computer name')}<Input name="name" defaultValue={session.computerName} required maxLength={128} autoComplete="off" /></label>
          {accountFields(true)}<p className="personal-caption">{l('填写自部署服务上的账号，可与本地身份不同。', 'Use an account on your self-hosted service. It may differ from your local identity.')}</p>
          <Button type="submit" className="primary" disabled={busy}>{busy ? l('正在连接…', 'Connecting…') : l('连接账号服务', 'Connect account service')}</Button>
        </form></Disclosure>
      </>}
      {session.mode === 'local' && session.revocationPending && <section><p role="status">{l('已在本机断开；在线撤销待重试。', 'Disconnected locally; online revocation is pending.')}</p><Button disabled={busy} onClick={() => void perform(async () => { await action('/auth/disconnect'); }, l('重试撤销失败', 'Revocation retry failed'))}>{l('重试在线撤销', 'Retry online revocation')}</Button></section>}
      {notice}<div className="personal-actions personal-account-footer"><Button disabled={busy} onClick={() => void signOut()}>{l('退出登录', 'Sign out')}</Button></div>
    </Dialog>}
  </div>;
}
