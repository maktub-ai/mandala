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

// Only simultaneous bulk-list readers share a request. No response survives its
// completion, and leaving one view must not cancel another view's active read.
const listReads=new Map<string,{controller:AbortController;read:Promise<unknown>;readers:number}>();
function readList<T>(path:string,signal?:AbortSignal):Promise<T>{
  if(signal?.aborted)return Promise.reject(signal.reason);
  let shared=listReads.get(path);
  if(!shared){
    const controller=new AbortController();
    const entry={controller,read:requestJson('/api'+path,{method:'GET',signal:controller.signal}),readers:0};
    shared=entry;listReads.set(path,entry);
    const clear=()=>{if(listReads.get(path)===entry)listReads.delete(path);};
    void entry.read.then(clear,clear);
  }
  const entry=shared;entry.readers++;
  return new Promise<T>((resolve,reject)=>{
    let done=false;
    const release=()=>{
      if(done)return false;done=true;signal?.removeEventListener('abort',cancel);
      if(--entry.readers===0){if(listReads.get(path)===entry)listReads.delete(path);entry.controller.abort();}
      return true;
    };
    const cancel=()=>{if(release())reject(signal?.reason);};
    signal?.addEventListener('abort',cancel,{once:true});
    void entry.read.then(value=>{if(release())resolve(value as T);},error=>{if(release())reject(error);});
  });
}

export function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  if(method==='GET'&&body===undefined&&['/v2/tasks','/conversation-progress'].includes(path))return readList<T>(path,signal);
  return requestJson('/api' + path, { method, signal, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
}
