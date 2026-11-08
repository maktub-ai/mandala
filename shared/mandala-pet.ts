import type { ConversationProgress } from './conversation-progress';
import type { Task } from './tasks';
import type { ConversationStatus } from './types';

// The Mandala pet shows the coordinator's state at a glance. Every state comes from recorded
// execution data, never from a model summary, so the pet cannot claim progress that did not happen.
export const petStates = ['waiting', 'error', 'unknown', 'working', 'thinking', 'done', 'idle', 'sleep'] as const;
export type PetState = typeof petStates[number];
export const requiredPetStates = ['idle', 'working', 'waiting', 'error'] as const satisfies readonly PetState[];
/** A pack may omit optional states; each falls back to the nearest required one. */
export const petFallback: Record<PetState, PetState> = { waiting: 'waiting', error: 'error', unknown: 'error', working: 'working', thinking: 'working', done: 'idle', idle: 'idle', sleep: 'idle' };

export type PetSignals = {
  rows: readonly Pick<ConversationProgress, 'id' | 'state' | 'executionStatus' | 'withinWindow' | 'title'>[];
  tasks: readonly Pick<Task, 'id' | 'state' | 'waitingReason' | 'goal'>[];
  mandalaStatus?: ConversationStatus | null;
  offline?: boolean;
};
export type PetSummary = { state: Exclude<PetState, 'done' | 'sleep'>; waiting: number; errors: number; unknown: number; running: number; first?: { kind: 'conversation' | 'task'; id: string } };

const waitingReasons = new Set<Task['waitingReason']>(['approval', 'input']);
// A run the person stopped is not a failure, so interrupted work does not alarm the pet.
const failedReasons = new Set<Task['waitingReason']>(['run_failed', 'check_failed', 'delivery_missing']);

/** Highest priority wins, so something waiting for the person is never hidden behind running work. */
export function summarizePet({ rows, tasks, mandalaStatus, offline }: PetSignals): PetSummary {
  const current = rows.filter(row => row.state !== 'completed' && (row.withinWindow || row.state === 'attention' || row.executionStatus === 'running' || row.executionStatus === 'approval'));
  const waitingRows = current.filter(row => row.executionStatus === 'approval');
  const waitingTasks = tasks.filter(task => task.state === 'review' || task.state === 'waiting' && waitingReasons.has(task.waitingReason));
  const errorRows = current.filter(row => row.state === 'attention' && row.executionStatus === 'error');
  const errorTasks = tasks.filter(task => task.state === 'waiting' && failedReasons.has(task.waitingReason));
  const unknownRows = current.filter(row => row.state === 'attention' && row.executionStatus !== 'approval' && row.executionStatus !== 'error' && row.executionStatus !== 'interrupted');
  const unknownTasks = tasks.filter(task => task.state === 'waiting' && task.waitingReason === 'host_offline');
  const runningRows = current.filter(row => row.executionStatus === 'running' || row.state === 'running' || row.state === 'queued');
  const runningTasks = tasks.filter(task => task.state === 'running' && !runningRows.length);
  const waiting = waitingRows.length + waitingTasks.length + (mandalaStatus === 'approval' ? 1 : 0);
  const errors = errorRows.length + errorTasks.length, unknown = unknownRows.length + unknownTasks.length + (offline ? 1 : 0);
  const running = runningRows.length + runningTasks.length;
  const first = waitingRows[0] ? { kind: 'conversation' as const, id: waitingRows[0].id } : waitingTasks[0] ? { kind: 'task' as const, id: waitingTasks[0].id }
    : errorRows[0] ? { kind: 'conversation' as const, id: errorRows[0].id } : errorTasks[0] ? { kind: 'task' as const, id: errorTasks[0].id } : undefined;
  const state = waiting ? 'waiting' : errors ? 'error' : unknown ? 'unknown' : running ? 'working' : mandalaStatus === 'running' ? 'thinking' : 'idle';
  return { state, waiting, errors, unknown, running, ...(first ? { first } : {}) };
}

export const petDoneMs = 6000, petSleepMs = 10 * 60000;
/** Adds the two time-based states: a short celebration after work finishes, and sleep after a long idle. */
export function advancePet(previous: { state: PetState; since: number; busyAt: number }, summary: PetSummary, now: number): { state: PetState; since: number; busyAt: number } {
  const busy = summary.state === 'working' || summary.state === 'thinking';
  const busyAt = busy ? now : previous.busyAt;
  let state: PetState = summary.state;
  if (state === 'idle') {
    const wasBusy = previous.state === 'working' || previous.state === 'thinking';
    if (wasBusy || previous.state === 'done' && now - previous.since < petDoneMs) state = 'done';
    else if (now - busyAt >= petSleepMs) state = 'sleep';
  }
  return { state, since: state === previous.state ? previous.since : now, busyAt };
}

// ---- Pet packs: user-made figures that follow the same states ----
export type PetPack = { format: 'mandala-pet'; version: 1; name: string; tint: boolean; states: Partial<Record<PetState, string>> };
export const maxPetPackBytes = 4 * 1024 * 1024;
const imageUri = /^data:image\/(svg\+xml|png|gif|webp|apng);base64,[A-Za-z0-9+/]+={0,2}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const decode = (base64: string) => typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('latin1');
/** Images render through <img> or a CSS mask, where SVG cannot run scripts or load other resources; anything that tries is still rejected. */
export function parsePetPack(value: unknown): PetPack {
  if (!record(value) || Object.keys(value).some(key => !['format', 'version', 'name', 'tint', 'states'].includes(key)) || value.format !== 'mandala-pet' || value.version !== 1) throw Error('invalid pet package');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw Error('invalid pet name');
  if (value.tint !== undefined && typeof value.tint !== 'boolean') throw Error('invalid pet tint');
  if (!record(value.states) || Object.keys(value.states).some(key => !(petStates as readonly string[]).includes(key))) throw Error('invalid pet states');
  const states: Partial<Record<PetState, string>> = {};
  for (const [key, image] of Object.entries(value.states)) {
    if (image === null || image === undefined) continue;
    if (typeof image !== 'string' || image.length > maxPetPackBytes || !imageUri.test(image)) throw Error('invalid pet image');
    if (image.startsWith('data:image/svg+xml') && /<script|javascript:|\son\w+\s*=|<foreignObject|(?:href|src)\s*=\s*["'](?!#|data:)/i.test(decode(image.slice(image.indexOf(',') + 1)))) throw Error('unsafe pet image');
    states[key as PetState] = image;
  }
  for (const state of requiredPetStates) if (!states[state]) throw Error('missing required pet state');
  return { format: 'mandala-pet', version: 1, name: value.name.trim(), tint: value.tint === true, states };
}
export const petImage = (pack: PetPack, state: PetState) => pack.states[state] ?? pack.states[petFallback[state]] ?? pack.states.idle!;

// ---- Preference: which figure, and where it lives ----
export type PetPreference = { figure: string; placement: 'panel' | 'desktop' };
export const defaultPetPreference: PetPreference = { figure: 'official', placement: 'panel' };
export function parsePetPreference(raw: string | null | undefined): PetPreference {
  try {
    const value = JSON.parse(raw ?? '');
    if (!record(value) || typeof value.figure !== 'string' || !/^(?:official|pet:[a-z0-9][a-z0-9-]{0,79}|plugin:[a-z0-9_-]{1,39}\/[a-z0-9_-][a-z0-9_.-]{0,99}:[a-z0-9][a-z0-9-]{0,59}\/pet:[a-z0-9][a-z0-9-]{0,59})$/.test(value.figure) || !['panel', 'desktop'].includes(value.placement as string)) throw Error();
    return { figure: value.figure, placement: value.placement as PetPreference['placement'] };
  } catch { return { ...defaultPetPreference }; }
}
