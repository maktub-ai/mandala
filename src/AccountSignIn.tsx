import { useEffect, useState } from 'react';
import { Check, ChevronRight, ExternalLink, Mail, Monitor } from 'lucide-react';
import Button from './ui/Button';
import Input from './ui/Input';
import BrandMark from './ui/BrandMark';
import googleLogo from './assets/account-providers/google.png';
import { useLanguage } from './i18n';
import { startPolling } from './polling';

export const desktopAccount = () => (window as Window & { mandalaDesktop?: { account?: { partition?: string; restart: () => Promise<void> } } }).mandalaDesktop?.account;

export async function accountPost(path: string, body: unknown = {}, csrfToken = '') {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error ?? 'Sign-in failed');
  return data;
}

function ProviderIcon({ provider }: { provider: 'google' | 'github' | 'email' }) {
  if (provider === 'google') return <img className="sign-in-provider-icon" src={googleLogo} width={18} height={18} alt="" />;
  if (provider === 'github') return <span className="sign-in-provider-icon sign-in-github-icon" aria-hidden="true" />;
  return <Mail className="sign-in-provider-icon" size={18} aria-hidden="true" />;
}

function Card({ children }: React.PropsWithChildren) {
  return <main className="personal-access"><section className="personal-card sign-in-card">
    <div className="personal-brand"><BrandMark /><span>Mandala</span></div>
    {children}
  </section></main>;
}

export function CloudSignIn({ providers, onSignedIn }: { providers: { google: boolean; github: boolean; email: boolean }; onSignedIn: () => Promise<void> }) {
  const { text: l } = useLanguage();
  const [email, setEmail] = useState(''), [code, setCode] = useState('');
  const [emailOpen, setEmailOpen] = useState(false), [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');

  useEffect(() => {
    const device = new URLSearchParams(location.search).get('device');
    if (device && /^[A-F0-9]{16}$/.test(device)) sessionStorage.setItem('mandala-desktop-request', device);
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };
  const sendCode = () => run(async () => {
    await accountPost('/auth/email/send', { email });
    setSent(true);
  });

  return <Card>
    <div className="sign-in-heading">
      <h1>{l('登录 Mandala', 'Sign in to Mandala')}</h1>
      <p>{l('选择一种登录方式。对话和任务保存在你的电脑上。', 'Choose how to sign in. Your conversations and tasks stay on your computer.')}</p>
    </div>
    <div className="sign-in-methods">
      {(['google', 'github'] as const).map(provider => {
        const name = provider === 'google' ? 'Google' : 'GitHub';
        return <a key={provider} className="sign-in-option" href={providers[provider] ? '/auth/oauth/' + provider + '/start' : undefined} aria-disabled={!providers[provider]}>
          <ProviderIcon provider={provider} />
          <span>{l('使用 ' + name + ' 登录', 'Continue with ' + name)}</span>
          {providers[provider] ? <ChevronRight size={16} aria-hidden="true" /> : <small>{l('暂未配置', 'Unavailable')}</small>}
        </a>;
      })}
      <button className="sign-in-option" type="button" disabled={!providers.email} aria-expanded={emailOpen} aria-controls="sign-in-email" onClick={() => setEmailOpen(open => !open)}>
        <ProviderIcon provider="email" />
        <span>{l('使用邮箱验证码', 'Continue with email')}</span>
        {providers.email ? <ChevronRight size={16} aria-hidden="true" /> : <small>{l('暂未配置', 'Unavailable')}</small>}
      </button>
      <div id="sign-in-email" hidden={!emailOpen}>
        {emailOpen && <form className="sign-in-email-form" onSubmit={event => {
          event.preventDefault();
          if (busy || !providers.email) return;
          if (!sent) { void sendCode(); return; }
          void run(async () => {
            await accountPost('/auth/email/verify', { email, code });
            await onSignedIn();
          });
        }}>
          <label>{l('邮箱', 'Email')}<Input type="email" autoComplete="email" autoFocus value={email} onChange={event => { setEmail(event.target.value); setSent(false); setCode(''); setError(''); }} required maxLength={254} /></label>
          {sent && <>
            <p role="status">{l('验证码已发送，10 分钟内有效。', 'Code sent. It expires in 10 minutes.')}</p>
            <label>{l('验证码', 'Verification code')}<Input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
          </>}
          {error && <p role="alert" className="personal-error">{error}</p>}
          <Button type="submit" variant="primary" disabled={busy || !email}>{sent ? l('验证并登录', 'Verify and sign in') : l('发送验证码', 'Send code')}</Button>
          {sent && <Button disabled={busy} onClick={() => void sendCode()}>{l('重新发送验证码', 'Resend code')}</Button>}
        </form>}
      </div>
    </div>
    <p className="personal-caption">{l('再次登录时，请使用注册时的方式。不同登录方式可能对应不同账号。', 'Use the same method next time to return to this account.')}</p>
  </Card>;
}

export function DesktopApproval({ code, csrfToken, username }: { code: string; csrfToken: string; username: string }) {
  const { text: l } = useLanguage();
  const [name, setName] = useState(''), [error, setError] = useState('');
  const [done, setDone] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/auth/desktop/request?code=' + encodeURIComponent(code), { signal: abort.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      setName(data.name);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason.message); });
    return () => abort.abort();
  }, [code]);

  return <Card>
    <div className="sign-in-heading">
      <h1>{l('允许桌面登录', 'Approve desktop sign-in')}</h1>
      {!done && <p>{l('请确认这是你刚刚发起的登录。', 'Confirm this is the sign-in you just started.')}</p>}
    </div>
    {done ? <div className="sign-in-device" role="status">
      <Check size={20} aria-hidden="true" />
      <p>{l('已批准，请返回 Mandala 桌面应用。', 'Approved. Return to the Mandala desktop app.')}</p>
    </div> : <>
      {name && <div className="sign-in-device">
        <Monitor size={20} aria-hidden="true" />
        <div><strong>{name}</strong><p>{username}</p></div>
      </div>}
      <Button variant="primary" disabled={!name || busy} onClick={() => {
        setBusy(true);
        setError('');
        void accountPost('/auth/desktop/approve', { userCode: code }, csrfToken).then(() => {
          sessionStorage.removeItem('mandala-desktop-request');
          setDone(true);
        }).catch(reason => setError(reason.message)).finally(() => setBusy(false));
      }}>{l('允许登录这台电脑', 'Allow this computer')}</Button>
    </>}
    {error && <p role="alert" className="personal-error">{error}</p>}
    <a className="sign-in-secondary-link" href="/" onClick={() => sessionStorage.removeItem('mandala-desktop-request')}>{l('返回账号首页', 'Back to account')}</a>
  </Card>;
}

export function DesktopSignIn() {
  const { text: l } = useLanguage();
  const [link, setLink] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<{ user: { username: string }; legacyAvailable: boolean }>();
  const [claim, setClaim] = useState(false);
  useEffect(() => {
    if (!link || grant) return;
    return startPolling(async signal => {
      const response = await fetch('/auth/desktop/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
      if (response.status === 202) return;
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      if (!signal.aborted) setGrant(data);
    }, 2500, { onError: reason => { setError((reason as Error).message); setLink(''); } });
  }, [link, grant]);

  const start = () => {
    setBusy(true);
    setError('');
    setLink('');
    void accountPost('/auth/desktop/start').then(data => setLink(data.verificationUri))
      .catch(reason => setError(reason.message)).finally(() => setBusy(false));
  };

  return <Card>
    <div className="sign-in-heading">
      <h1>{l('登录 Mandala', 'Sign in to Mandala')}</h1>
      <p>{grant
        ? l('浏览器已批准登录，可以打开你的工作区了。', 'Sign-in approved. Your workspace is ready to open.')
        : l('在浏览器中登录并授权这台电脑。', 'Sign in from your browser to authorize this computer.')}</p>
    </div>
    {!grant ? <>
      <ul className="sign-in-supported" aria-label={l('可用登录方式', 'Sign-in methods')}>
        <li><ProviderIcon provider="google" />Google</li>
        <li><ProviderIcon provider="github" />GitHub</li>
        <li><ProviderIcon provider="email" />{l('邮箱', 'Email')}</li>
      </ul>
      {link ? <>
        <a className="primary sign-in-browser-link" href={link} target="_blank" rel="noreferrer">
          {l('在浏览器中登录并批准', 'Sign in and approve in your browser')}<ExternalLink size={16} aria-hidden="true" />
        </a>
        <div className="sign-in-waiting">
          <p role="status"><span aria-hidden="true" />{l('等待浏览器中的登录确认…', 'Waiting for approval in your browser…')}</p>
          <Button variant="ghost" onClick={start}>{l('重新开始登录', 'Restart sign-in')}</Button>
        </div>
      </> : <Button variant="primary" busy={busy} onClick={start}>{l('开始登录', 'Start sign-in')}</Button>}
      <p className="personal-caption">{l('每个账号都有独立的本地工作区。登录有效期内可以离线使用。', 'Each account has its own local workspace. You can work offline while signed in.')}</p>
    </> : <>
      <div className="sign-in-device"><Check size={20} aria-hidden="true" /><div><p>{l('即将使用账号', 'Continue as')}</p><strong>{grant.user.username}</strong></div></div>
      {grant.legacyAvailable && <label className="sign-in-claim">
        <Input type="checkbox" checked={claim} onChange={event => setClaim(event.target.checked)} />
        {l('将这台电脑原有的 Mandala 数据归属此账号。请先停止旧版后台运行；原有远程连接将断开。不勾选则创建空白工作区。', 'Assign this computer’s existing Mandala data to this account. Stop the old background runtime first; its previous remote connection will be disconnected. Leave unchecked for a new workspace.')}
      </label>}
      <Button variant="primary" busy={busy} onClick={() => {
        setBusy(true);
        setError('');
        void accountPost('/auth/desktop/activate', { claimLegacy: claim }).then(() => desktopAccount()?.restart())
          .catch(reason => setError(reason.message)).finally(() => setBusy(false));
      }}>{l('进入工作区', 'Open workspace')}</Button>
    </>}
    {error && <p role="alert" className="personal-error">{error}</p>}
  </Card>;
}
