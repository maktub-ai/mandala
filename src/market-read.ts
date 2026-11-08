/** Bound read-only market work, including response bodies, and cancel obsolete views. */
export async function readMarket<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException("Market request timed out; retry or check network access.", "TimeoutError")), 30_000);
  try {
    const response = await fetch("/api" + path, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
