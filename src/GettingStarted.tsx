import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Cli, Config } from '../shared/types';
import { enabledRuntimes, runtimeCatalog, runtimeIds, runtimeLabel } from '../shared/runtimes';
import { api } from './api';
import { useLanguage } from './i18n';
import { loginCommand, scanRuntimes, type RuntimeProbe } from './onboarding';
import Button from './ui/Button';
import BrandMark from './ui/BrandMark';
import Icon from './ui/Icon';
import RuntimeIcon from './ui/RuntimeIcon';
import StatusLabel from './ui/StatusLabel';
import Disclosure from './ui/Disclosure';
import './getting-started.css';

type RuntimeInfo = { nodeVersion: string; nodeSupported: boolean; minimumNodeVersion: string };
type Action = 'mandala' | 'chat' | 'agent';

/**
 * First use: find the CLIs this computer can already run, adopt one for Mandala,
 * then hand off to the Mandala main chat. Nothing runs until the user sends.
 */
export default function GettingStarted({ config, onOpenPath, onStart }: {
  config: Config;
  onOpenPath: (path: string) => void;
  onStart: (cli: Cli, action: Action) => Promise<void>;
}) {
  const { text: localize } = useLanguage(), l = (zh: string, en: string) => localize(zh, en);
  const [probes, setProbes] = useState<Partial<Record<Cli, RuntimeProbe>>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [round, setRound] = useState(0);
  const [chosen, setChosen] = useState<Cli | ''>('');
  const picked = useRef(false);
  const [busy, setBusy] = useState<Action | ''>(''), [actionError, setActionError] = useState('');
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const enabled = enabledRuntimes(config);

  useEffect(() => { let active = true; void api<{ runtime?: RuntimeInfo }>('/status').then(value => { if (active) setRuntime(value.runtime); }).catch(() => {}); return () => { active = false; }; }, []);
  useEffect(() => {
    setProbes({}); setErrors([]);
    return scanRuntimes((cli, status, error) => {
      setProbes(current => ({ ...current, [cli]: status }));
      if (error) setErrors(current => [...current, error]);
    }, enabled);
  }, [round]);

  const rank = (cli: Cli) => { const probe = probes[cli]; return probe?.status === 'ready' ? 0 : probe?.status === 'login-required' ? 1 : probe === undefined ? 2 : 3; };
  const order = (list: Cli[]) => [...list].sort((a, b) => rank(a) - rank(b) || Number(!enabled.includes(a)) - Number(!enabled.includes(b)) || runtimeLabel(a).localeCompare(runtimeLabel(b)));
  const checked = runtimeIds.filter(cli => probes[cli] !== undefined).length, scanning = checked < runtimeIds.length;
  const found = order(runtimeIds.filter(cli => probes[cli]?.status === 'ready' || probes[cli]?.status === 'login-required'));
  const missing = runtimeIds.filter(cli => probes[cli]?.status === 'unavailable' || probes[cli] === null);
  const ready = found.filter(cli => probes[cli]?.status === 'ready');
  const allFailed = !scanning && runtimeIds.every(cli => probes[cli] === null);

  // Suggest only a sole ready CLI after detection; never override a user choice.
  useEffect(() => {
    if (picked.current) { if (chosen && probes[chosen] && probes[chosen]?.status !== 'ready') setChosen(''); return; }
    const best = !scanning && ready.length === 1 ? ready[0] : '';
    if (best !== chosen && (best || !scanning)) setChosen(best);
  }, [probes]);
  const choose = (cli: Cli) => { picked.current = true; setChosen(cli); setActionError(''); };
  const rescan = () => { picked.current = false; setChosen(''); setRound(value => value + 1); };
  const run = async (action: Action) => {
    if (!chosen || busy) return;
    setBusy(action); setActionError('');
    try { await onStart(chosen, action); }
    catch (reason) { setActionError((reason as Error).message); }
    finally { setBusy(''); }
  };
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key) || !ready.length) return;
    event.preventDefault();
    const visible = found.filter(cli => probes[cli]?.status === 'ready');
    const index = chosen ? visible.indexOf(chosen) : -1, step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const next = visible[(index + step + visible.length) % visible.length];
    choose(next); event.currentTarget.querySelector<HTMLElement>(`[data-runtime-choice="${next}"]`)?.focus();
  };
  const name = chosen ? runtimeLabel(chosen) : '';

  return <section className="getting-started" aria-label={l('开始使用 Mandala', 'Get started with Mandala')}>
    <header className="getting-started-hero">
      <BrandMark/>
      <h1>{l('欢迎使用 Mandala', 'Welcome to Mandala')}</h1>
      <p>{l('你的 AI 总控台：说一件事，Mandala 分派给合适的 Agent，并跟踪到完成。', 'Your AI control desk: say what you need, and Mandala hands it to the right Agent and follows it to done.')}</p>
    </header>

    <section className="getting-started-step" aria-labelledby="getting-started-connect">
      <div className="getting-started-step-heading">
        <span className="getting-started-index" aria-hidden="true">1</span>
        <div><h2 id="getting-started-connect">{l('选一个本机 CLI 来执行工作', 'Pick a CLI on this computer to do the work')}</h2>
          <p>{l('Mandala 负责分派和跟进，实际执行交给你电脑上的 AI 编程工具。账号与额度由各 CLI 自己管理。', 'Mandala plans and follows up; the AI coding tools on your computer do the work. Each CLI keeps its own account and quota.')}</p></div>
      </div>
      <div className="getting-started-scan"><span role="status">{scanning
          ? <StatusLabel icon="clock">{l(`正在检测本机 CLI… ${checked}/${runtimeIds.length}`, `Checking CLIs on this computer… ${checked}/${runtimeIds.length}`)}</StatusLabel>
          : <StatusLabel icon={ready.length ? 'circleCheck' : 'clock'} tone={ready.length ? 'success' : 'warning'}>{ready.length ? l(`找到 ${ready.length} 个可用的 CLI`, `${ready.length} CLI${ready.length > 1 ? 's' : ''} ready`) : l('还没有可直接使用的 CLI', 'No CLI is ready yet')}</StatusLabel>}</span>
        <Button size="sm" variant="ghost" disabled={scanning} onClick={rescan}><Icon name="refresh" size={14}/>{l('重新检测', 'Check again')}</Button>
      </div>
      {found.length > 0 && <div className="getting-started-choices" role="radiogroup" aria-label={l('选择 CLI', 'Choose a CLI')} onKeyDown={moveFocus}>
        {found.map(cli => {
          const probe = probes[cli]!, canStart = probe.status === 'ready', selected = chosen === cli;
          return <button key={cli} type="button" role="radio" aria-checked={selected} aria-disabled={!canStart || undefined} data-runtime-choice={cli}
            tabIndex={selected || (!chosen && cli === ready[0]) ? 0 : -1} className="getting-started-choice" onClick={() => canStart && choose(cli)}>
            <span className="getting-started-radio" aria-hidden="true"/>
            <RuntimeIcon cli={cli} size={20}/>
            <span className="getting-started-choice-text">
              <strong>{runtimeLabel(cli)}</strong>
              {canStart
                ? <span>{probe.version ?? l('版本未知', 'Unknown version')}</span>
                : <span>{l('在终端运行 ', 'Run ')}<code>{loginCommand(cli)}</code>{l(' 完成登录，然后重新检测', ' in a terminal to sign in, then check again')}</span>}
            </span>
            {canStart ? <StatusLabel icon="circleCheck" tone="success">{l('可用', 'Ready')}</StatusLabel> : <StatusLabel icon="user" tone="warning">{l('需要登录', 'Sign-in needed')}</StatusLabel>}
          </button>;
        })}
      </div>}
      {!scanning && found.length === 0 && <div className="getting-started-empty">
        <p>{allFailed ? l('检测没有完成，请重新检测。', 'The check did not finish. Try again.') : l('这台电脑上没有找到受支持的 CLI。安装其中一个后点「重新检测」；装在非默认位置时可手动配置路径。', 'No supported CLI was found on this computer. Install one, then check again. If it lives in a custom location, configure its path.')}</p>
        <div className="getting-started-actions">
          <Button variant="ghost" onClick={() => onOpenPath('/settings/runtimes')}><Icon name="settings" size={14}/>{l('手动配置', 'Configure manually')}</Button>
        </div>
      </div>}
      {errors.length > 0 && (allFailed || found.length === 0) && <p role="alert">{errors[0]}</p>}
      {!scanning && missing.length > 0 && found.length > 0 && <Disclosure className="getting-started-missing" title={l(`未检测到的 CLI（${missing.length}）`, `Not found (${missing.length})`)}>
        <ul>{missing.map(cli => <li key={cli}><RuntimeIcon cli={cli} size={16}/><span>{runtimeLabel(cli)}</span>
          <a href={runtimeCatalog[cli].docs} target="_blank" rel="noopener noreferrer">{l('安装说明', 'Install guide')}</a>
          <a href={'/settings/runtimes/new?runtime=' + cli} onClick={event => { event.preventDefault(); onOpenPath('/settings/runtimes/new?runtime=' + cli); }}>{l('手动配置', 'Configure')}</a></li>)}</ul>
      </Disclosure>}
    </section>

    <section className="getting-started-step" aria-labelledby="getting-started-hand-off">
      <div className="getting-started-step-heading">
        <span className="getting-started-index" aria-hidden="true">2</span>
        <div><h2 id="getting-started-hand-off">{l('把第一件事交给 Mandala', 'Hand Mandala your first task')}</h2>
          <p>{l('Mandala 会用所选 CLI 工作。之后可以在 Mandala 设置里更换，发送前不会执行任何操作。', 'Mandala will work through the CLI you pick. You can change it later in Mandala settings. Nothing runs until you send.')}</p></div>
      </div>
      <div className="getting-started-actions">
        <Button variant="primary" disabled={!chosen || !!busy} busy={busy === 'mandala'} onClick={() => void run('mandala')}>
          {chosen ? l(`用 ${name} 开始`, `Start with ${name}`) : l('先选择一个可用的 CLI', 'Pick a ready CLI first')}<Icon name="arrowRight" size={14}/>
        </Button>
        <Button disabled={!chosen || !!busy} busy={busy === 'chat'} onClick={() => void run('chat')}>{l('直接对话', 'Just chat')}</Button>
      </div>
      <p className="getting-started-aside">{l('想先为某块业务建一个长期 Agent？', 'Want a long-lived Agent for one area of your work first?')}{' '}
        <button type="button" className="getting-started-link" disabled={!chosen || !!busy} onClick={() => void run('agent')}>{l('创建 Agent', 'Create Agent')}</button></p>
      {actionError && <p role="alert">{actionError}</p>}
    </section>

    <Disclosure className="getting-started-diagnostics" title={l('运行环境诊断', 'Environment diagnostics')}>
      <p>{l('桌面应用自带 Mandala 运行环境，无需另外安装 Node.js。', 'The desktop app includes its Mandala runtime; a separate Node.js installation is not required.')}</p>
      {runtime ? <p><code>{runtime.nodeVersion}</code>{!runtime.nodeSupported && ' · ' + l('运行环境需要修复或更新 Mandala', 'Repair the runtime or update Mandala')}</p> : <p>{l('运行环境版本暂不可用', 'Runtime version unavailable')}</p>}
    </Disclosure>
  </section>;
}
