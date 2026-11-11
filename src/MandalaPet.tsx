import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ConversationProgress } from '../shared/conversation-progress';
import type { Task } from '../shared/tasks';
import type { Conversation } from '../shared/types';
import type { PetPack, PetPreference, PetState, PetSummary } from '../shared/mandala-pet';
import { advancePet, parsePetPreference, petImage, summarizePet } from '../shared/mandala-pet';
import { api } from './api';
import { devicePreferences } from './devicePreferences';
import { useLanguage } from './i18n';
import { useUiExtensions } from './UiExtensions';
import './mandala-pet.css';

export type DesktopPet = { show: () => Promise<void>; hide: () => Promise<void>; open: (path: string) => Promise<void>;
  /** Pet window only: whether the mouse should reach the pet or pass through to what is underneath. */ interactive: (value: boolean) => void; move: (x: number, y: number) => void; settle: () => void;
  onVisibility: (listener: (visible: boolean) => void) => () => void; onNavigate: (listener: (path: string) => void) => () => void };
export const desktopPet = (): DesktopPet | undefined => (window as Window & { mandalaDesktop?: { pet?: DesktopPet } }).mandalaDesktop?.pet;

// ---- Preference ----
const preferenceKey = 'mandala-pet', preferenceEvent = 'mandala-pet-preference';
function readPreference(): PetPreference {
  try { return parsePetPreference(devicePreferences.getItem(preferenceKey)); } catch { try { return parsePetPreference(localStorage.getItem(preferenceKey)); } catch { return parsePetPreference(null); } }
}
export function savePetPreference(value: PetPreference) {
  try { devicePreferences.setItem(preferenceKey, JSON.stringify(value)); } catch { /* The choice still applies to this window. */ }
  dispatchEvent(new CustomEvent(preferenceEvent, { detail: value }));
}
/** Follows changes made in this window and, through storage events, in the desktop pet window. */
export function usePetPreference(): [PetPreference, (value: PetPreference) => void] {
  const [value, setValue] = useState(readPreference);
  useEffect(() => {
    const changed = (event: Event) => setValue((event as CustomEvent<PetPreference>).detail ?? readPreference());
    const stored = (event: StorageEvent) => { if (event.key === preferenceKey) setValue(parsePetPreference(event.newValue)); };
    addEventListener(preferenceEvent, changed); addEventListener('storage', stored);
    return () => { removeEventListener(preferenceEvent, changed); removeEventListener('storage', stored); };
  }, []);
  return [value, savePetPreference];
}

/** The chosen pack, or undefined for the official figure (also when the chosen pack was uninstalled). */
export function usePetPack(figure: string): PetPack | undefined {
  const { snapshot, refresh } = useUiExtensions();
  useEffect(() => { if (!snapshot && figure !== 'official') void refresh(); }, [snapshot, figure, refresh]);
  const item = figure === 'official' ? undefined : snapshot?.items.find(entry => entry.catalogId === figure);
  return item?.data.format === 'mandala-pet' ? item.data : undefined;
}

// ---- Live state ----
export type PetStatus = PetSummary & { pet: PetState; loaded: boolean };
const emptySummary: PetSummary = { state: 'idle', waiting: 0, errors: 0, unknown: 0, running: 0 };
/** Polls the same records the task and progress views use; failing to reach the service is itself a state. */
export function usePetStatus(active = true, intervalMs = 4000): PetStatus {
  const [status, setStatus] = useState<PetStatus>({ ...emptySummary, pet: 'idle', loaded: false });
  const timeline = useRef({ state: 'idle' as PetState, since: Date.now(), busyAt: Date.now() });
  useEffect(() => {
    if (!active) return;
    const controller=new AbortController();
    let live = true, pending = false;
    const read = async () => {
      if (pending) return; pending = true;
      let summary: PetSummary;
      try {
        const [rows, tasks, mandala] = await Promise.all([api<ConversationProgress[]>('/conversation-progress','GET',undefined,controller.signal), api<Task[]>('/v2/tasks','GET',undefined,controller.signal), api<{ conversation?: Conversation }>('/mandala','GET',undefined,controller.signal).catch(() => ({ conversation: undefined }))]);
        summary = summarizePet({ rows, tasks, mandalaStatus: mandala.conversation?.status });
      } catch { summary = summarizePet({ rows: [], tasks: [], offline: true }); }
      finally { pending = false; }
      if (!live) return;
      timeline.current = advancePet(timeline.current, summary, Date.now());
      setStatus({ ...summary, pet: timeline.current.state, loaded: true });
    };
    void read();
    const timer = setInterval(() => void read(), intervalMs);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [active, intervalMs]);
  return status;
}

export function petStatusText(status: Pick<PetStatus, 'pet' | 'waiting' | 'errors' | 'unknown' | 'running'>, text: (zh: string, en: string) => string): string {
  switch (status.pet) {
    case 'waiting': return text(`${status.waiting} 件事等你处理`, status.waiting === 1 ? '1 item needs you' : `${status.waiting} items need you`);
    case 'error': return text(`${status.errors} 个任务出错`, status.errors === 1 ? '1 task failed' : `${status.errors} tasks failed`);
    case 'unknown': return text('有工作失去联系，状态未知', 'Lost contact with some work');
    case 'working': return text(`${status.running} 个在运行`, `${status.running} running`);
    case 'thinking': return text('正在规划…', 'Planning…');
    case 'done': return text('都做完了', 'All done');
    case 'sleep': return text('休眠中', 'Resting');
    default: return text('一切安静', 'All quiet');
  }
}
export const petTone: Record<PetState, string> = { waiting: 'warning', error: 'danger', unknown: 'muted', working: 'accent', thinking: 'accent', done: 'success', idle: 'success', sleep: 'muted' };

/** Where clicking the pet leads: the first item waiting for the person, otherwise the Mandala chat. */
export function petTarget(status: Pick<PetSummary, 'first'>): string {
  if (status.first?.kind === 'conversation') return '/?conversation=' + encodeURIComponent(status.first.id);
  if (status.first?.kind === 'task') return '/tasks/' + encodeURIComponent(status.first.id);
  return '/mandala';
}

// ---- Figure ----
const petals = [
  ['M50 5.1 C47.5 10.7 39.4 14.1 35.5 23.4 L40.9 26.2 C43.2 20.9 47.2 17.8 50 14.3 C52.8 17.8 56.8 20.9 59.1 26.2 L64.5 23.4 C60.6 14.1 52.5 10.7 50 5.1 Z'],
  ['M9.6 27 C16.1 27.6 21.5 22.4 29.4 23.7 C41 24.3 47.7 32.2 49 43 C43.6 36.1 36.4 30.3 29.4 30.2 C23.7 29.8 21 31.6 17.8 31.9 C20.2 36.7 20 41.4 24.5 46 L19.6 49.1 C13.3 43.1 14.2 34.5 9.6 27 Z', 'M34 34 C36.5 34.5 38.3 35.8 40.6 37 C40.8 41 41.7 45.4 43.4 47.7 C37.1 45.4 33.7 41.3 34 34 Z'],
  ['M90.4 27 C83.9 27.6 78.5 22.4 70.6 23.7 C59 24.3 52.3 32.2 51 43 C56.4 36.1 63.6 30.3 70.6 30.2 C76.3 29.8 79 31.6 82.2 31.9 C79.8 36.7 80 41.4 75.5 46 L80.4 49.1 C86.7 43.1 85.8 34.5 90.4 27 Z', 'M66 34 C63.5 34.5 61.7 35.8 59.4 37 C59.2 41 58.3 45.4 56.6 47.7 C62.9 45.4 66.3 41.3 66 34 Z'],
  ['M42.2 48.4 C34.6 44.2 26.4 45.8 20.5 50.4 C11.6 57.2 13 65.4 9.6 72.1 C17.9 72.4 23.6 78.4 33.8 76.7 L33.3 70.8 C26.2 72.4 22 67.8 17.4 68.1 C19.5 58.5 26.4 50.2 42.2 48.4 Z', 'M31.8 52.9 C35.5 54.8 38.8 55.8 42.9 55.2 L38.4 59.2 C34.6 60.4 30.4 58.7 27.1 56 Z'],
  ['M57.8 48.4 C65.4 44.2 73.6 45.8 79.5 50.4 C88.4 57.2 87 65.4 90.4 72.1 C82.1 72.4 76.4 78.4 66.2 76.7 L66.7 70.8 C73.8 72.4 78 67.8 82.6 68.1 C80.5 58.5 73.6 50.2 57.8 48.4 Z', 'M68.2 52.9 C64.5 54.8 61.2 55.8 57.1 55.2 L61.6 59.2 C65.4 60.4 69.6 58.7 72.9 56 Z'],
  ['M42.8 55.3 C37.5 62 34.8 66.2 35.3 73.5 C35.8 83.2 44.8 88.1 50 95.1 C55.2 88.1 64.2 83.2 64.7 73.5 C65.2 66.2 62.5 62 57.2 55.3 C59.8 62.4 59.8 65 59.3 71.9 C58.7 80 52.9 83 50 86.6 C47.1 83 41.3 80 40.7 71.9 C40.2 65 40.2 62.4 42.8 55.3 Z', 'M50 58.5 C47.9 62.3 45.3 65.1 42.5 66.8 C42.5 69 42.8 71 43.2 72.8 C46.1 70.9 48.9 67.5 50 63 Z', 'M50 58.5 C52.1 62.3 54.7 65.1 57.5 66.8 C57.5 69 57.2 71 56.8 72.8 C53.9 70.9 51.1 67.5 50 63 Z'],
];
// The light that travels around the flower while it works: thin sectors from the centre, brightest at the head and fading behind it.
const sweep = Array.from({ length: 17 }, (_, slot) => {
  const index = slot - 3, step = 9, from = (-90 - index * step) * Math.PI / 180, to = (-90 - (index + 1) * step) * Math.PI / 180, r = 70;
  const point = (angle: number) => `${(50 + r * Math.cos(angle)).toFixed(2)} ${(50 + r * Math.sin(angle)).toFixed(2)}`;
  // A short soft rise at the head, then a long fade behind it.
  return { d: `M50 50 L${point(to)} A${r} ${r} 0 0 1 ${point(from)} Z`, opacity: +(index < 0 ? (4 + index) / 4 : 1 - index / 14).toFixed(2) };
});
/** The official figure is the Mandala mark itself; state is carried by petal motion and colour, with no face. */
export function PetFigure({ state, pack, count = 0, size = 64, label }: { state: PetState; pack?: PetPack; count?: number; size?: number; label?: string }) {
  if (pack) {
    const image = petImage(pack, state);
    return <span className="mandala-pet is-pack" data-state={state} data-tint={pack.tint || undefined} role="img" aria-label={label} style={{ width: size, height: size, ...(pack.tint ? { WebkitMaskImage: `url("${image}")`, maskImage: `url("${image}")` } : {}) }}>
      {!pack.tint && <img src={image} alt="" draggable={false} />}
    </span>;
  }
  const clip = useId().replace(/:/g, '') + '-petals';
  return <svg className="mandala-pet" data-state={state} role="img" aria-label={label} width={size} height={size} viewBox="-8 -14 116 120" overflow="visible">
    <defs><clipPath id={clip}>{petals.flat().map(d => <path key={d} d={d} />)}</clipPath></defs>
    <circle className="pet-halo" cx="50" cy="50" r="30" />
    <g className="pet-body"><g className="pet-ring">{petals.map((paths, index) => <g key={index} className={'pet-petal p' + (index + 1)}>{paths.map(d => <path key={d} d={d} />)}</g>)}</g>
      <g className="pet-light" clipPath={`url(#${clip})`}><g className="pet-sweep">{sweep.map(part => <path key={part.d} d={part.d} opacity={part.opacity} />)}</g></g></g>
    <g className="pet-dots"><circle cx="76" cy="10" r="2.4" /><circle cx="83" cy="10" r="2.4" /><circle cx="90" cy="10" r="2.4" /></g>
    <g className="pet-badge"><circle cx="88" cy="6" r="9" /><text x="88" y="10" textAnchor="middle">{count > 9 ? '9+' : count}</text></g>
    <g className="pet-sparks"><path d="M8 4 v6 M5 7 h6" /><path d="M92 2 v5 M89.5 4.5 h5" /><path d="M96 70 v4 M94 72 h4" /></g>
    <g className="pet-zz"><text x="78" y="12">z</text><text x="86" y="4">z</text></g>
  </svg>;
}

/** The pet at the top of the Mandala side panel; it can move out to a desktop window and back. */
export function MandalaPetCard({ name, onOpen, active = true }: { name: string; onOpen: (path: string) => void; active?: boolean }) {
  const { text } = useLanguage();
  const [preference, setPreference] = usePetPreference();
  const pack = usePetPack(preference.figure);
  const status = usePetStatus(active);
  const desktop = desktopPet(), popped = !!desktop && preference.placement === 'desktop';
  const toggle = useCallback(() => {
    const placement = popped ? 'panel' : 'desktop';
    setPreference({ ...preference, placement });
    void (placement === 'desktop' ? desktop?.show() : desktop?.hide())?.catch(() => setPreference({ ...preference, placement: 'panel' }));
  }, [desktop, popped, preference, setPreference]);
  const line = petStatusText(status, text);
  return <section className="mandala-pet-card" data-compact={popped || undefined} aria-label={text('Mandala 状态', 'Mandala status')}>
    <button type="button" className="mandala-pet-figure" title={status.first ? text('打开等你处理的第一项', 'Open the first item that needs you') : text('打开 Mandala 对话', 'Open the Mandala chat')} onClick={() => onOpen(petTarget(status))}>
      <PetFigure state={status.pet} pack={pack} count={status.running} size={popped ? 22 : 84} label={name + ' · ' + line} />
    </button>
    <strong className="mandala-pet-name">{name}</strong>
    <span className="mandala-pet-status" data-tone={petTone[status.pet]} role="status"><i aria-hidden="true" />{popped ? text('在桌面浮窗 · ', 'On the desktop · ') + line : line}</span>
    {desktop && <button type="button" className="mandala-pet-toggle" onClick={toggle} aria-label={popped ? text('收回到面板', 'Return to the panel') : text('弹出到桌面', 'Pop out to the desktop')} title={popped ? text('收回到面板', 'Return to the panel') : text('弹出到桌面', 'Pop out to the desktop')}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{popped ? <path d="M7 9 2.5 13.5M2.5 9.5v4h4M9 2.5h4.5v4M13.5 2.5 9 7" /> : <path d="M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />}</svg>
    </button>}
  </section>;
}

/** Keeps the desktop pet window in step with the saved placement, and follows its requests in the main window. */
export function useDesktopPetBridge(onNavigate: (path: string) => void) {
  const [preference, setPreference] = usePetPreference();
  const desktop = desktopPet(), latest = useRef({ preference, setPreference, onNavigate });
  latest.current = { preference, setPreference, onNavigate };
  useEffect(() => { if (desktop && preference.placement === 'desktop') void desktop.show().catch(() => {}); }, [desktop, preference.placement]);
  useEffect(() => {
    if (!desktop) return;
    const offVisibility = desktop.onVisibility(visible => { const { preference: current, setPreference: save } = latest.current; if (!visible && current.placement === 'desktop') save({ ...current, placement: 'panel' }); });
    const offNavigate = desktop.onNavigate(path => latest.current.onNavigate(path));
    return () => { offVisibility(); offNavigate(); };
  }, [desktop]);
}
