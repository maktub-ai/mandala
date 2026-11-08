import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startPolling } from '../src/polling';

let visibility: EventTarget & { hidden: boolean };
beforeEach(() => { vi.useFakeTimers(); visibility = Object.assign(new EventTarget(), { hidden: false }); vi.stubGlobal('document', visibility); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('slow requests never overlap and disposal cancels pending scheduling', async () => {
  let finish!: () => void;
  const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = startPolling(work, 1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(work).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(1000);
  expect(work).toHaveBeenCalledTimes(2);
  stop(); finish(); await vi.advanceTimersByTimeAsync(10000);
  expect(work).toHaveBeenCalledTimes(2);
});

test('hidden pages pause; showing the page refreshes once and errors keep polling recoverable', async () => {
  visibility.hidden = true;
  const error = new Error('offline'), onError = vi.fn();
  const work = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const stop = startPolling(work, 1000, { onError });
  await vi.advanceTimersByTimeAsync(3000); expect(work).not.toHaveBeenCalled();
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0); expect(onError).toHaveBeenCalledWith(error);
  await vi.advanceTimersByTimeAsync(1000); expect(work).toHaveBeenCalledTimes(2);
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(5000); expect(work).toHaveBeenCalledTimes(2);
  stop(); visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(1000); expect(work).toHaveBeenCalledTimes(2);
});

test('disposal aborts active work and does not report its cancellation as a failure', async () => {
  let observed!: AbortSignal;
  const onError = vi.fn();
  const work = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    observed = signal;
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  const stop = startPolling(work, 1000, { onError });
  expect(observed.aborted).toBe(false);
  stop();await vi.advanceTimersByTimeAsync(10000);
  expect(observed.aborted).toBe(true);expect(onError).not.toHaveBeenCalled();expect(work).toHaveBeenCalledTimes(1);
});
test('showing a page during active work waits then refreshes immediately without overlap', async () => {
  let finish!: () => void;
  const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = startPolling(work, 1000);
  visibility.hidden = true;visibility.dispatchEvent(new Event('visibilitychange'));
  visibility.hidden = false;visibility.dispatchEvent(new Event('visibilitychange'));
  expect(work).toHaveBeenCalledTimes(1);
  finish();await vi.advanceTimersByTimeAsync(0);
  expect(work).toHaveBeenCalledTimes(2);
  stop();finish();
});

test('a visibility refresh is consumed once even when hidden again before active work finishes', async () => {
  let finish!: () => void;
  const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = startPolling(work, 1000);
  visibility.hidden = true;visibility.dispatchEvent(new Event('visibilitychange'));
  visibility.hidden = false;visibility.dispatchEvent(new Event('visibilitychange'));
  visibility.hidden = true;visibility.dispatchEvent(new Event('visibilitychange'));
  finish();await vi.advanceTimersByTimeAsync(0);
  visibility.hidden = false;visibility.dispatchEvent(new Event('visibilitychange'));
  expect(work).toHaveBeenCalledTimes(2);
  finish();await vi.advanceTimersByTimeAsync(0);
  expect(work).toHaveBeenCalledTimes(2);
  stop();
});
