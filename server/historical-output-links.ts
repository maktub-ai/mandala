import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Asset, AssetVersion } from '../shared/assets';
import type { Conversation, DisplayEvent } from '../shared/types';
import { DomainError, type Principal } from '../shared/workspace-contracts';
import type { createAssets } from './assets';
import type { Store } from './store';

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Node = { type: string; url?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
type Candidate = { asset: Asset; version: AssetVersion; hash: string };

function outputRelative(url: string, root: string): string | undefined {
  // Never resolve or open an assistant-supplied host path. Only compare literal
  // components under the known run root, and use the result as hash input.
  try {
    if (url.length > 4096 || /[?#]|%2f|%5c/i.test(url)) return;
    const decoded = decodeURIComponent(url);
    if (/[\x00-\x1f\x7f]/.test(decoded) || decoded.split(/[\\/]/).some(part => part === '.' || part === '..')) return;
    const file = url.startsWith('file:///') ? fileURLToPath(url) : decoded;
    const hostPath = sep === '\\' ? file.replace(/^\/([A-Za-z]:\/)/, '$1').replaceAll('/', sep) : file;
    if (!hostPath.startsWith(root + sep)) return;
    const path = hostPath.slice(root.length + 1).split(sep).join('/');
    if (!path || path.includes('\\') || path.split('/').some(part => !part)) return;
    return path;
  } catch { return; }
}

function matchesOriginalCommand({asset,version,hash}: Candidate, path: string) {
  const title=asset.title, name=version.files[0].path;
  const files = [
    ...(name === path ? [[{path}]] : []),
    [{path,name}], [{name,path}],
  ];
  return files.some(files => digest({title,files}) === hash || digest({files,title}) === hash);
}

export function projectHistoricalOutputLinks(
  home: string, store: Store, assets: Pick<ReturnType<typeof createAssets>, 'getAuthorizedVersion' | 'readAssetFile'>,
  principal: Principal, conversation: Conversation, events: DisplayEvent[],
): DisplayEvent[] {
  if (conversation.executionLocation || principal.agentId || principal.userId !== store.ownerUserId) return events;
  const db = store.database;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_artifact_commands'").get()) return events;
  // Asset import canonicalizes precisely these three Principal fields in sorted
  // order. A fixed identity and command key use the dedup primary key.
  const candidatesFor = db.prepare(`
    SELECT c.result,c.input_hash,v.id AS version_id,v.asset_id
    FROM file_execution_scopes s JOIN run_artifact_commands c ON c.run_id=s.invocation_id
    JOIN artifact_links l ON l.run_id=c.run_id AND l.version_id=json_extract(CASE WHEN json_valid(c.result) THEN c.result ELSE '{}' END,'$.version.id')
    JOIN asset_versions v ON v.id=l.version_id AND v.ordinal=1 AND json_extract(v.data,'$.provenance.runId')=c.run_id
    WHERE s.user_id=? AND s.conversation_id=? AND s.invocation_id=? AND EXISTS (
      SELECT 1 FROM command_dedup d
      WHERE d.principal=json_object('agentId',s.agent_id,'runId',c.run_id,'userId',s.user_id)
        AND d.command_key=c.command_key AND d.version_id=v.id
    ) LIMIT 65
  `);
  const runs = new Map<string, Candidate[]>();
  let budget=128, parseBytes=1024*1024;
  return events.map(event => {
    if (budget < 1 || event.kind !== 'tool') return event;
    const data=event.data as { runId?: string; method?: string; params?: { item?: { type?: string; text?: string } } } | null;
    const item=data?.params?.item, text=item?.text, runId=data?.runId;
    if (data?.method !== 'item/completed' || item?.type !== 'agentMessage' || typeof text !== 'string' ||
        text.length > 65536 || text.length > parseBytes || !text.includes('](') || !safeId(conversation.id) || !safeId(runId)) return event;
    const marker=`/outputs/conversations/${conversation.id}/${runId}/`;
    if (!text.includes(marker) && !(sep==='\\' && text.includes(marker.replaceAll('/',sep)))) return event;
    parseBytes-=text.length;
    const root=resolve(home,'outputs','conversations',conversation.id,runId), edits:{start:number;end:number;url:string}[]=[];
    const visit = (node: Node) => {
      if (budget < 1) return;
      if (node.type !== 'link') { node.children?.forEach(visit); return; }
      const start=node.position?.start.offset, end=node.position?.end.offset;
      if (start===undefined || end===undefined || !node.url) return;
      const raw=text.slice(start,end), link=/\]\(<([^<>\r\n]+)>\)$|\]\(([^\s()<>]+)\)$/.exec(raw);
      if (!link) return;
      const destination=link[1]??link[2];
      // Only replace a literal destination, not escaped links, titles or references.
      if (destination !== node.url) return;
      const path=outputRelative(destination,root);
      if (!path) return;
      budget--;
      let candidates=runs.get(runId);
      if (!candidates) {
        const rows=candidatesFor.all(principal.userId,conversation.id,runId);
        candidates=rows.length>64?[]:rows.flatMap(row=>{
          const {asset,version}=JSON.parse(row.result as string) as {asset:Asset;version:AssetVersion};
          return asset?.kind==='file'&&asset.owner?.userId===principal.userId && safeId(asset.id) && safeId(version?.id) &&
            asset.id===row.asset_id && version.id===row.version_id && version.files?.length===1
            ? [{asset,version,hash:row.input_hash as string}] : [];
        });
        runs.set(runId,candidates);
      }
      const matched = candidates.filter(candidate=>matchesOriginalCommand(candidate,path));
      if (matched.length !== 1) return;
      const {asset,version}=matched[0], ref={assetId:asset.id,versionId:version.id};
      try {
        const current=assets.getAuthorizedVersion(principal,ref);
        if (current.provenance.runId!==runId || current.files.length!==1 || current.files[0].path!==version.files[0].path) return;
        assets.readAssetFile(principal,ref,'0');
      } catch (error) {
        if (error instanceof DomainError) return;
        throw error;
      }
      const destinationEnd=end-(link[1]===undefined?1:2);
      edits.push({start:destinationEnd-destination.length,end:destinationEnd,url:`/api/v2/assets/${asset.id}/versions/${version.id}/files/0`});
    };
    visit(fromMarkdown(text) as Node);
    if (!edits.length) return event;
    let projected=text;
    for (const edit of edits.reverse()) projected=projected.slice(0,edit.start)+edit.url+projected.slice(edit.end);
    return {...event,data:{...data,params:{...data.params,item:{...item,text:projected}}}};
  });
}
