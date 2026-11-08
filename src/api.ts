export async function requestJson<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  if (timeoutMs !== undefined) {
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, {once:true});
    const timer = setTimeout(() => controller.abort(new Error('Request timed out. Check the result before trying again.')), timeoutMs);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve,reject) => {
      onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort',onAbort,{once:true});
    });
    try { return await Promise.race([requestJson<T>(url,{...options,signal:controller.signal}),aborted]); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort',cancel); controller.signal.removeEventListener('abort',onAbort); }
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); }
  catch {
    throw Object.assign(new Error(response.ok ? `Invalid JSON response (HTTP ${response.status})` : `HTTP ${response.status}`), { status: response.status });
  }
  if (!response.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`), { status: response.status });
  return data;
}

export function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson('/api' + path, { method, signal, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
}
