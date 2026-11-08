import { createContext, useEffect, useMemo, useState } from 'react';
import { MAX_FILE_REFERENCE_BATCH, MAX_FILE_REFERENCE_BODY_BYTES, isLocalFileReference, messageFileLinks } from '../shared/local-file-links';
import type { ChatMessage } from './chatTurns';
import type { ConversationReferenceSummary } from '../shared/conversation-references';
import type { PublishedFileReference } from '../shared/local-file-links';

const noPublishedFiles:PublishedFileReference[]=[];
export function usePublishedConversationFiles(conversationId:string,activityVersion:string){
 const key=JSON.stringify([conversationId,activityVersion]);
 const [result,setResult]=useState<{conversationId:string;files:PublishedFileReference[]}>();
 useEffect(()=>{
  if(!conversationId)return;
  const controller=new AbortController();
  void fetch('/api/conversations/'+encodeURIComponent(conversationId)+'/reference-summary',{signal:controller.signal}).then(async response=>{
   if(!response.ok)throw new Error('Published files unavailable');
   const data=await response.json() as ConversationReferenceSummary;
   const files=data.documents.filter(doc=>doc.relations.includes('output')).flatMap(doc=>(doc.files??[]).map(file=>({...file,assetId:doc.assetId,versionId:doc.versionId,runId:doc.runId})));
   if(!controller.signal.aborted)setResult(previous=>previous?.conversationId===conversationId&&JSON.stringify(previous.files)===JSON.stringify(files)?previous:{conversationId,files});
  }).catch(()=>{if(!controller.signal.aborted)setResult({conversationId,files:noPublishedFiles});});
  return()=>controller.abort();
 },[key]);
 return result?.conversationId===conversationId?result.files:noPublishedFiles;
}

const emptyFiles: ReadonlySet<string> = new Set();
export const VerifiedFilesContext = createContext<ReadonlySet<string>>(emptyFiles);

const normalizedSets = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();
const normalizeHref = (href: string) => { try { return decodeURI(href); } catch { return href; } };
export function hasVerifiedFile(files: ReadonlySet<string>, href: string) {
 let normalized = normalizedSets.get(files);
 if (!normalized) { normalized = new Set([...files].map(normalizeHref)); normalizedSets.set(files, normalized); }
 return normalized.has(normalizeHref(href));
}

export function fileReferenceBatches(candidates: string[]) {
 const batches: string[][] = [];
 const encoder = new TextEncoder();
 let batch: string[] = [], bytes = encoder.encode('{"hrefs":[]}').length;
 for (const href of candidates) {
  const size = encoder.encode(JSON.stringify(href)).length;
  if (batch.length && (batch.length === MAX_FILE_REFERENCE_BATCH || bytes + size + 1 > MAX_FILE_REFERENCE_BODY_BYTES)) {
   batches.push(batch); batch = []; bytes = encoder.encode('{"hrefs":[]}').length;
  }
  if (href.length > 4096) continue;
  bytes += size + (batch.length ? 1 : 0); batch.push(href);
 }
 if (batch.length) batches.push(batch);
 return batches;
}

export async function resolveFileReferenceBatches(conversationId: string, candidates: string[], signal: AbortSignal, publish: (files: ReadonlySet<string>) => void) {
 const files = new Set<string>();
 for (const batch of fileReferenceBatches(candidates)) {
  if (signal.aborted) return;
  const request = new AbortController(), abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 10000);
  try {
   for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted || request.signal.aborted) return;
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/local-files/resolve`, {
     method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hrefs: batch }), signal: request.signal,
    });
    if (signal.aborted || request.signal.aborted) return;
    if (response.status === 409 && attempt === 0) continue;
    if (!response.ok) throw new Error('File resolution unavailable');
    const data = await response.json() as { hrefs: string[] };
    const requested = new Set(batch);
    for (const href of data.hrefs) if (requested.has(href)) files.add(href);
    if (signal.aborted || request.signal.aborted) return;
    publish(new Set(files));
    break;
   }
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
 }
}

export function useVerifiedConversationFiles(conversationId: string, messages: ChatMessage[]) {
 const candidates = useMemo(() => [...new Set(messages.filter(message => message.kind !== 'error')
  .flatMap(message => messageFileLinks(message.text).map(link => link.href).filter(isLocalFileReference)))], [messages]);
 const key = JSON.stringify([conversationId, candidates]);
 const [result, setResult] = useState<{ key: string; files: ReadonlySet<string> }>();
 useEffect(() => {
  if (!conversationId || !candidates.length) return;
  const controller = new AbortController();
  const delay = setTimeout(() => {
   // Keep already verified batches when a later request fails or times out.
   void resolveFileReferenceBatches(conversationId, candidates, controller.signal,
    files => setResult({ key, files })).catch(() => {});
  }, 150);
  return () => { clearTimeout(delay); controller.abort(); };
  // The serialized key is stable across unrelated transcript rerenders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [key]);
 return result?.key === key ? result.files : emptyFiles;
}
