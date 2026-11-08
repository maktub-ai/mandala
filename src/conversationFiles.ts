import { isLocalFileReference, messageFileLinks } from '../shared/local-file-links';
import type { ChatMessage } from './chatTurns';
import type { ContentTarget } from './ContentPreviewContext';
import type { IconName } from './ui/Icon';

export type LinkSource = 'local' | 'attachment' | 'material' | 'repository' | 'web';
export function linkSource(href: string): LinkSource {
 let path=href;
 try {const url=new URL(href);if(typeof location!=='undefined'&&url.origin===location.origin)path=url.pathname;} catch { /* Relative links already contain their local path. */ }
 if (/^\/api\/conversations\/[^/]+\/attachments\//.test(path)) return 'attachment';
 if (/^\/(?:api\/v2\/assets|assets)\//.test(path)) return 'material';
 if (isLocalFileReference(href)) return 'local';
 try { if (/^(?:github\.com|gitlab\.com|bitbucket\.org)$/.test(new URL(href).hostname)) return 'repository'; } catch { /* Relative web links use the generic link source. */ }
 return 'web';
}
export const sourceIcon: Record<LinkSource, IconName> = {local:'file',attachment:'paperclip',material:'book',repository:'gitBranch',web:'globe'};
export const sourceLabel: Record<LinkSource, [string,string]> = {local:['本地文件','Local file'],attachment:['上传附件','Attachment'],material:['项目资料','Project material'],repository:['代码仓库','Repository'],web:['网页','Web page']};
export type ConversationFile = { id: string; name: string; detail: string; source: LinkSource; target: Exclude<ContentTarget,{kind:'asset'}> };
export function conversationFiles(messages: ChatMessage[], conversationId: string, verifiedFiles: ReadonlySet<string> = new Set()): ConversationFile[] {
 const files = new Map<string, ConversationFile>();
 for (const message of messages) {
  if (message.kind === 'error') continue;
  for (const link of messageLinks(message.text)) {
   if (!verifiedFiles.has(link.href) || linkSource(link.href) !== 'local') continue;
   const id=link.href.replace(/:\d+(?::\d+)?$/,'');
   files.delete(id);files.set(id,{id,name:link.label||id.split('/').pop()!,detail:link.href,source:'local',target:{kind:'file',href:link.href}});
  }
  for (const item of message.attachments ?? []) {
   const src='/api/conversations/'+encodeURIComponent(conversationId)+'/attachments/'+encodeURIComponent(item.id);
   files.delete(item.id);files.set(item.id,{id:item.id,name:item.name,detail:item.name,source:'attachment',target:/^image\/(png|jpeg|gif|webp)$/.test(item.mimeType)?{kind:'image',name:item.name,src}:{kind:'attachment',name:item.name,src:src+'?download=1',mimeType:item.mimeType,size:item.size}});
  }
 }
 return [...files.values()].reverse();
}

// Source positions let user messages keep their exact text outside links.
export const messageLinks = messageFileLinks;
