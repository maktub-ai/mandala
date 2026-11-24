import type { DraftAttachment } from '../shared/drafts';

type Staged = { conversationId: string; result: Promise<string>; id?: string };
const staged = new WeakMap<File, Staged>();
const route = (id: string) => '/api/drafts/files/' + encodeURIComponent(id);

export function storedComposerFile(file: File, conversationId: string): string | undefined {
  const item = staged.get(file);
  return item?.conversationId === conversationId ? item.id : undefined;
}

export async function stageComposerFile(conversationId: string, file: File): Promise<string> {
  const previous = staged.get(file);
  if (previous?.conversationId === conversationId) return previous.result;
  const params = new URLSearchParams({ name: file.name, type: file.type, lastModified: String(file.lastModified) });
  const result = (async () => {
    const response = await fetch(route(conversationId) + '?' + params, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status });
    return data.id as string;
  })();
  const item: Staged = { conversationId, result };
  staged.set(file, item);
  try {
    item.id = await result;
    return item.id;
  } catch (error) {
    if (staged.get(file) === item) staged.delete(file);
    throw error;
  }
}

export async function readComposerFile(conversationId: string, item: DraftAttachment): Promise<File | undefined> {
  if (!item.storageId) return;
  try {
    const response = await fetch(route(conversationId) + '/' + encodeURIComponent(item.storageId), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return;
    const data = await response.blob();
    if (data.size !== item.size) return;
    const file = new File([data], item.name, { type: item.type, lastModified: item.lastModified });
    staged.set(file, { conversationId, result: Promise.resolve(item.storageId), id: item.storageId });
    return file;
  } catch {
    return;
  }
}
