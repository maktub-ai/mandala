import { fromMarkdown } from 'mdast-util-from-markdown';
import type { VersionRef } from './workspace-contracts';

export type PublishedFileReference=VersionRef&{name:string;fileId:string;runId?:string};
export const publishedFileUrl=(file:PublishedFileReference)=>'/api/v2/assets/'+encodeURIComponent(file.assetId)+'/versions/'+encodeURIComponent(file.versionId)+'/files/'+encodeURIComponent(file.fileId);
export function publishedFileLinks(files:PublishedFileReference[]){
 const names=new Map<string,PublishedFileReference|null>();
 for(const file of files)for(const name of new Set([file.name,file.name.split('/').at(-1)!])){
  const previous=names.get(name);
  if(!names.has(name))names.set(name,file);
  else if(!previous||previous.assetId!==file.assetId||previous.versionId!==file.versionId||previous.fileId!==file.fileId)names.set(name,null);
 }
 return new Map([...names].filter((entry):entry is [string,PublishedFileReference]=>entry[1]!==null));
}

export const MAX_FILE_REFERENCE_BATCH = 4096;
export const MAX_FILE_REFERENCE_BODY_BYTES = 240 * 1024;

export const withoutFileLine = (href: string) => href.replace(/:\d+(?::\d+)?$/, '');

export function isConcreteLocalFileReference(href: string) {
 let value: string;
 try { value = decodeURIComponent(withoutFileLine(href)); } catch { return false; }
 return !/[\x00-\x1f*?{}<>\[\]]/.test(value) && !/(?:^|\/)\.{3}(?:\/|$)|YYYY|MM-DD|<[^>]+>|\$\{/.test(value);
}

export function isRelativeLocalFileReference(href: string) {
 if (!isConcreteLocalFileReference(href)) return false;
 let path: string;
 try { path = decodeURIComponent(withoutFileLine(href)); } catch { return false; }
 const explicit = path.startsWith('./');
 if (explicit) path = path.slice(2);
 return !!path && !path.split('/')[0].includes(':') && (explicit || path.includes('/')) && !/^(?:[A-Za-z][\w+.-]*:|\/|~)/.test(path)
  && (explicit || !/\s/.test(path.split('/')[0]))
  && !/[\\\x00-\x1f?#;&|<>`$"'\[\]]/.test(path)
  && !path.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part);
}

export function isLocalFileReference(href: string) {
 if (!isConcreteLocalFileReference(href)) return false;
 return /^(?:file:\/\/|\/(?:Users|home|tmp|private|Volumes)\/|[A-Za-z]:[\\/])/.test(href)
  || /^\/(?!\/|api(?:\/|$)|assets(?:[/?]|$))[^?#]*\.[^/]+$/.test(withoutFileLine(href)) || isRelativeLocalFileReference(href);
}

// Only an entire inline-code span that looks like a file is a delivery reference.
// Commands, code fences, web URLs and directory names retain their original form.
export function isInlineFileReference(value: string) {
 if (!isLocalFileReference(value) || /[\x00-\x1f;&|<>`$"'\[\]]|\s--?\w/.test(value)
  || value.split('/').some(part => part.trim() !== part)) return false;
 return /\.[^./\\\s]+$/.test(withoutFileLine(value));
}

type MarkdownNode = { type: string; url?: string; identifier?: string; value?: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export function messageFileLinks(source: string) {
 if (!/[\[<`]/.test(source)) return [];
 const tree = fromMarkdown(source);
 const definitions = new Map<string, string>();
 const collect = (node: MarkdownNode) => {
  if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  node.children?.forEach(collect);
 };
 collect(tree);
 const text = (node: MarkdownNode): string => node.value ?? node.children?.map(text).join('') ?? '';
 const links: { href: string; label: string; start: number; end: number }[] = [];
 const visit = (node: MarkdownNode) => {
  const href = node.type === 'link' ? node.url : node.type === 'linkReference' ? definitions.get(node.identifier!)
   : node.type === 'inlineCode' && isInlineFileReference(node.value ?? '') ? node.value : undefined;
  if (href && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) links.push({ href, label: text(node), start: node.position.start.offset, end: node.position.end.offset });
  else if (node.type !== 'code' && node.type !== 'image') node.children?.forEach(visit);
 };
 visit(tree);
 return links;
}

// remark uses the same recognition as the file sidebar and server authorization.
export function remarkDeliveredFiles(options?:{publishedFiles?:ReadonlyMap<string,PublishedFileReference>}) {
 return (tree: MarkdownNode) => {
  const visit = (node: MarkdownNode) => {
   if(node.type==='link'){
    const file=options?.publishedFiles?.get(node.url??'');
    if(file)node.url=publishedFileUrl(file);
    return;
   }
   if(node.type==='linkReference')return;
   node.children = node.children?.map(child => {
    const published=child.type==='inlineCode'?options?.publishedFiles?.get(child.value??''):undefined;
    if (child.type === 'inlineCode' && (isInlineFileReference(child.value ?? '')||published)) return { type: 'link', url: published?publishedFileUrl(published):child.value, children: [child], position: child.position };
    visit(child);
    return child;
   });
  };
  visit(tree);
 };
}
