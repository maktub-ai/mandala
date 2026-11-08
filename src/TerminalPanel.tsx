import Button from './ui/Button';
import { requestJson } from './api';
import { shortcutIntent } from './shortcuts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalSnapshot } from '../shared/terminal';
import { useLanguage } from './i18n';
import { terminalReference } from './chat-references';
import Icon from './ui/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

function request<T>(url: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson(url, { method, signal, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
}

type PanelProps = { focusOrigin?: RefObject<Element | null>; conversationId: string; theme: string; onClose: () => void; onReference: (text: string) => void };
type TerminalTab = { slot: number; cwd?: string };
const maxSlots = 6, terminalTabs = new Map<string, { tabs: TerminalTab[]; active: number }>();
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// Terminal tabs per conversation: slot 0 is the chat directory, extra slots open there or in a worktree.
export default function TerminalPanel(props: PanelProps) {
  const { conversationId } = props, { text: localize } = useLanguage(), say = (zh: string, en: string) => localize(zh, en);
  const base = '/api/conversations/' + encodeURIComponent(conversationId) + '/terminal';
  const [state, setState] = useState(() => terminalTabs.get(conversationId) ?? { tabs: [{ slot: 0 }], active: 0 });
  const [worktrees, setWorktrees] = useState<{ path: string; branch: string }[]>([]);
  useEffect(() => { terminalTabs.set(conversationId, state); }, [conversationId, state]);
  useEffect(() => {
    // Extra terminals keep running on the host; show them again after a reload.
    const controller = new AbortController();
    void request<{ sessions: { slot: number; session: TerminalSnapshot }[] }>(base + '/sessions', 'GET', undefined, controller.signal).then(({ sessions }) => setState(current => {
      const extra = sessions.filter(item => item.slot && !current.tabs.some(tab => tab.slot === item.slot)).map(item => ({ slot: item.slot, cwd: item.session.cwd }));
      return extra.length ? { ...current, tabs: [...current.tabs, ...extra].sort((a, b) => a.slot - b.slot) } : current;
    })).catch(() => {});
    return () => controller.abort();
  }, [conversationId]);
  const loadWorktrees = (open: boolean) => {
    if (open) void request<{ git: boolean; worktrees?: { path: string; branch: string }[] }>('/api/conversations/' + encodeURIComponent(conversationId) + '/environment').then(value => setWorktrees(value.worktrees ?? [])).catch(() => setWorktrees([]));
  };
  const add = (cwd?: string) => setState(current => {
    const slot = Array.from({ length: maxSlots }, (_, i) => i).find(i => !current.tabs.some(tab => tab.slot === i));
    return slot === undefined ? current : { tabs: [...current.tabs, { slot, cwd }].sort((a, b) => a.slot - b.slot), active: slot };
  });
  const close = async (slot: number) => {
    const { session } = await request<{ session: TerminalSnapshot | null }>(base + '?slot=' + slot).catch(() => ({ session: null }));
    if (session?.state === 'running') await request(base + '?slot=' + slot, 'DELETE', { sessionId: session.id }).catch(() => {});
    setState(current => { const at = current.tabs.findIndex(tab => tab.slot === slot), tabs = current.tabs.filter(tab => tab.slot !== slot); return { tabs, active: current.active === slot ? (tabs[at - 1] ?? tabs[0]).slot : current.active }; });
  };
  const active = state.tabs.find(tab => tab.slot === state.active) ?? state.tabs[0];
  const tabLabel = (tab: TerminalTab) => tab.slot === 0 ? say('对话目录', 'Chat directory') : tab.cwd ? folderName(tab.cwd) : say('连接中…', 'Connecting…');
  return <div className="terminal-tabs-host">
    <div className="open-file-tabs terminal-tabs" role="group" aria-label={say('终端', 'Terminals')}>
      {state.tabs.map(tab => <span key={tab.slot} className="open-file-tab" data-active={tab.slot === active.slot || undefined}>
        <Button type="button" title={tab.cwd} aria-pressed={tab.slot === active.slot} onClick={() => setState(current => ({ ...current, active: tab.slot }))}><Icon name="terminal" size={12} />{tabLabel(tab)}</Button>
        {tab.slot !== 0 && <Button type="button" className="icon-button" aria-label={say('关闭终端 ', 'Close terminal ') + tabLabel(tab)} title={say('结束并关闭', 'End and close')} onClick={() => void close(tab.slot)}><Icon name="close" size={12} /></Button>}
      </span>)}
      <DropdownMenu onOpenChange={loadWorktrees}>
        <DropdownMenuTrigger asChild><Button type="button" className="icon-button" disabled={state.tabs.length >= maxSlots} aria-label={say('新建终端', 'New terminal')} title={say('新建终端', 'New terminal')}><Icon name="plus" size={15} /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => add()}>{say('对话目录', 'Chat directory')}</DropdownMenuItem>
          {worktrees.map(item => <DropdownMenuItem key={item.path} className="whitespace-nowrap" title={item.path} onSelect={() => add(item.path)}>worktree · {item.branch || folderName(item.path)}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <TerminalSession key={conversationId + ':' + active.slot} {...props} slot={active.slot} cwd={active.cwd}
      onStarted={started => setState(current => ({ ...current, tabs: current.tabs.map(tab => tab.slot === active.slot && !tab.cwd ? { ...tab, cwd: started } : tab) }))} />
  </div>;
}

function TerminalSession({ conversationId, theme, onClose, onReference, focusOrigin, slot, cwd, onStarted }: PanelProps & { slot: number; cwd?: string; onStarted: (cwd: string) => void }) {
  const {text: localize,  language, errorText } = useLanguage(), english = language !== 'zh-CN';
  const say = (zh: string, en: string) => localize(zh, en);
  const terminalErrors: Record<string, string> = {
    'Working directory is unavailable': '工作目录不存在或无法访问，请检查对话的目录设置。',
    'Working directory changed; end the previous terminal first': '工作目录已变化，请先结束旧终端，再重新启动。',
    'Working directory changed; open the terminal again': '工作目录已变化，请重试。',
    'Terminal changed; reconnect before sending input': '终端已重新启动，请重新连接。',
    'Terminal is not running': '终端已结束，请重新启动。',
    'Too many running terminals; end an unused terminal first': '运行中的终端过多，请先结束一个不再使用的终端。',
  };
  const element = useRef<HTMLDivElement>(null), instance = useRef<Terminal | null>(null);
  const focusTarget = useRef<Element | null>(null);
  const refit = useRef<(() => void) | null>(null);
  const [session, setSession] = useState<TerminalSnapshot | null>(null), current = useRef<TerminalSnapshot | null>(null);
  const [connected, setConnected] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState(false);
  const [attempt, setAttempt] = useState(0), [starting, setStarting] = useState(false), [stopping, setStopping] = useState(false);
  const base = '/api/conversations/' + encodeURIComponent(conversationId) + '/terminal';
  const route = (path = '', query = '') => { const search = [slot ? 'slot=' + slot : '', query].filter(Boolean).join('&'); return base + path + (search ? '?' + search : ''); };
  const start = (cols: number, rows: number, signal?: AbortSignal) => request<{ session: TerminalSnapshot }>(route(), 'POST', { cols, rows, ...(cwd ? { worktree: cwd } : {}) }, signal);
  current.current = session;
  const usable = connected && session?.state === 'running' && !stopping;

  useEffect(() => {
    focusTarget.current = attempt || !focusOrigin ? document.activeElement : focusOrigin.current;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, lineHeight: 1.5, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      scrollback: 5000, screenReaderMode: true, disableStdin: true });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current!); instance.current = terminal;
    terminal.textarea?.setAttribute('aria-label', say('终端输入', 'Terminal input'));
    if (terminal.textarea) terminal.textarea.disabled = true;
    terminal.attachCustomKeyEventHandler(event => {
      if (shortcutIntent(event) === 'terminal') return false;
      if (event.type === 'keydown' && ((event.ctrlKey && event.shiftKey && event.code === 'KeyA') || (event.metaKey && event.code === 'KeyA'))) { event.preventDefault(); terminal.selectAll(); return false; }
      return true;
    });
    const controller = new AbortController(); let source: EventSource | null = null, active: TerminalSnapshot | null = null, disposed = false;
    let queue = Promise.resolve();
    const enqueue = (action: string, data: unknown) => {
      queue = queue.then(async () => { if (!disposed) await request(route('/' + action), 'POST', data, controller.signal); })
        .catch(reason => { if (!disposed) setError(reason.message); });
    };
    const fitNow = () => { if (element.current?.clientWidth && element.current.clientHeight) fit.fit(); };
    refit.current = fitNow;
    const observer = new ResizeObserver(fitNow); observer.observe(element.current!);
    const sizeSubscription = terminal.onResize(({ cols, rows }) => { if (active?.state === 'running' && source?.readyState === EventSource.OPEN) enqueue('resize', { sessionId: active.id, cols, rows }); });
    const inputSubscription = terminal.onData(data => { if (active?.state === 'running' && source?.readyState === EventSource.OPEN) enqueue('input', { sessionId: active.id, data }); });
    const selectionSubscription = terminal.onSelectionChange(() => setSelected(terminal.hasSelection()));
    setError(''); setConnected(false); setSession(null); setSelected(false);
    void (async () => {
      fitNow();
      const existing = await request<{ session: TerminalSnapshot | null }>(route(), 'GET', undefined, controller.signal);
      const value = existing.session ?? (await start(terminal.cols, terminal.rows, controller.signal)).session;
      if (disposed) return;
      active = value; setSession(value); if (slot) onStarted(value.cwd);
      source = new EventSource(route('/events', 'sessionId=' + encodeURIComponent(value.id)));
      source.addEventListener('snapshot', event => {
        const next: TerminalSnapshot = JSON.parse((event as MessageEvent).data); active = next; setSession(next);
        terminal.reset(); terminal.write(next.output); setConnected(true); setError('');
        if (next.state === 'running') { fitNow(); enqueue('resize', { sessionId: next.id, cols: terminal.cols, rows: terminal.rows }); }
      });
      source.addEventListener('data', event => terminal.write(JSON.parse((event as MessageEvent).data)));
      source.addEventListener('state', event => { active = JSON.parse((event as MessageEvent).data); setSession(active); setStopping(false); });
      source.onerror = () => { setConnected(false); };
    })().catch(reason => { if (!disposed) setError(reason.message); });
    return () => { disposed = true; controller.abort(); source?.close(); observer.disconnect(); inputSubscription.dispose(); sizeSubscription.dispose(); selectionSubscription.dispose(); terminal.dispose(); instance.current = null; refit.current = null; };
  }, [conversationId, slot, attempt, english]);

  useEffect(() => {
    const terminal = instance.current; if (!terminal) return;
    // Read after App applies the active theme to the document.
    let frame = 0;
    const refresh = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      if (instance.current !== terminal) return;
      const style = getComputedStyle(document.documentElement);
      const token = (name: string) => style.getPropertyValue(name).trim();
      terminal.options.theme = { background: token('--surface'), foreground: token('--text'),
        cursor: token('--focus'), selectionBackground: token('--terminal-selection'),
        red: token('--danger'), green: token('--success'), blue: token('--link'), magenta: token('--theme-code-keyword') };
      terminal.options.fontFamily = token('--font-mono');
      terminal.options.fontSize = parseInt(token('--code-font-size')) || 13;
      refit.current?.();
      void document.fonts.ready.then(() => { if (instance.current === terminal) refit.current?.(); });
    }); };
    refresh(); window.addEventListener('mandala-theme-change',refresh);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('mandala-theme-change',refresh); };
  }, [theme, attempt, english]);
  useEffect(() => {
    if (!instance.current) return;
    instance.current.options.disableStdin = !usable;
    if (instance.current.textarea) instance.current.textarea.disabled = !usable;
    if (usable && focusTarget.current) {
      if ((attempt || !focusOrigin || focusOrigin.current) && (document.activeElement === focusTarget.current || document.activeElement === document.body)) instance.current.focus();
      focusTarget.current = null;
    }
  }, [usable, attempt, english]);

  async function stop() {
    if (!current.current || stopping) return;
    setStopping(true); setError('');
    try { await request(route(), 'DELETE', { sessionId: current.current.id }); }
    catch (reason) { setStopping(false); setError((reason as Error).message); }
  }
  async function restart() {
    if (starting) return;
    setStarting(true); setError('');
    try { await start(instance.current?.cols ?? 80, instance.current?.rows ?? 18); setAttempt(value => value + 1); }
    catch (reason) { setError((reason as Error).message); }
    finally { setStarting(false); }
  }
  return <section className="terminal-pane" role="region" aria-label={say('交互终端', 'Interactive terminal')}>
    <header className="terminal-toolbar">
      <span className="terminal-heading"><Icon name="terminal" size={15} />{say('终端', 'Terminal')}<small className={'terminal-status ' + (usable ? 'is-ready' : '')} role="status">{stopping ? say('正在结束…', 'Ending…') : session?.state === 'exited' ? say('已结束', 'Exited') + (session.exitCode ? ' · ' + session.exitCode : '') : usable ? session.shell : error ? say('启动失败', 'Unavailable') : session ? say('连接已断开', 'Disconnected') : say('连接中…', 'Connecting…')}</small></span>
      <div className="terminal-actions">
        <Button type="button" disabled={!selected} title={say('选中输出后加入输入框；Ctrl + Shift + A 全选', 'Select output to add it to the draft; Ctrl + Shift + A selects all')}
          onClick={() => { const text = instance.current?.getSelection(); if (text && session) onReference(terminalReference(session.cwd, text, english)); }}><Icon name="quote" size={14} />{say('加入对话', 'Add to chat')}</Button>
        {session?.state === 'running' && <Button type="button" disabled={stopping} onClick={() => void stop()} title={say('结束 Shell 及其运行中的子进程', 'End the shell and its running child processes')} aria-label={say('结束终端', 'End terminal')}><Icon name="stop" size={14} /></Button>}
        {session?.state === 'exited' && <Button type="button" disabled={starting} onClick={() => void restart()}>{say('重新启动', 'Restart')}</Button>}
        <Button type="button" aria-label={say('收起终端', 'Collapse terminal')} title={say('收起后继续运行', 'Keeps running when collapsed')} onClick={onClose}><Icon name="chevronDown" size={16} /></Button>
      </div>
    </header>
    <div className="terminal-location" title={session?.cwd}>{session ? say('启动目录：', 'Starting directory: ') + session.cwd : say('正在读取对话工作目录…', 'Reading the conversation directory…')}
      {session?.truncated && <span>{say(' · 仅保留最近输出', ' · Recent output retained')}</span>}</div>
    {error && <div className="terminal-error" role="alert"><span>{!english && terminalErrors[error] || errorText(error)}</span><Button type="button" onClick={() => setAttempt(value => value + 1)}>{say('重试', 'Retry')}</Button></div>}
    {!connected && session?.state === 'running' && !error && <div className="terminal-reconnect" role="status">{say('连接已断开，正在重新连接…', 'Connection lost; reconnecting…')}<Button type="button" onClick={() => setAttempt(value => value + 1)}>{say('重新连接', 'Reconnect')}</Button></div>}
    <div ref={element} className="terminal-surface" onPointerDown={() => { if (usable) instance.current?.focus(); }} />
  </section>;
}
