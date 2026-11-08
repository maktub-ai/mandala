/** Wait for each refresh, pause hidden pages, and abort when the owner disposes. */
export function startPolling(work: (signal: AbortSignal) => Promise<unknown>, interval: number, {
  immediate = true, onError = (error: unknown) => console.error('Polling failed', error),
}: { immediate?: boolean; onError?: (error: unknown) => void } = {}): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, refreshPending = false;
  const run = async () => {
    if (controller.signal.aborted || document.hidden || running) return;
    clearTimeout(timer);
    running = true;
    refreshPending = false;
    try { await work(controller.signal); }
    catch (error) { if (!controller.signal.aborted) onError(error); }
    finally {
      running = false;
      if (!controller.signal.aborted && !document.hidden) {
        if (refreshPending) { refreshPending = false; void run(); }
        else timer = setTimeout(run, interval);
      }
    }
  };
  const visibility = () => {
    clearTimeout(timer);
    if (!document.hidden) {
      if (running) refreshPending = true;
      else void run();
    }
  };
  document.addEventListener('visibilitychange', visibility);
  if (immediate) void run();
  else if (!document.hidden) timer = setTimeout(run, interval);
  return () => {
    controller.abort();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibility);
  };
}
