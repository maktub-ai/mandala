import Button from './ui/Button';
import { copyText } from "./clipboard";
import React, { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
// CommonMark rejects `**强调。**后文` (closing delimiter after CJK punctuation); this keeps Chinese emphasis intact.
import remarkCjkFriendly from "remark-cjk-friendly";
import { useLanguage } from "./i18n";
import MermaidDiagram from "./MermaidDiagram";
import Dialog from "./Dialog";
import Icon from "./ui/Icon";
import { api } from "./api";
import { CodePreview, codeLanguage } from "./CodePreview";
import "./file-preview.css";
import HtmlPreview from './HtmlPreview';
import LocalFileActions from './LocalFileActions';
import { linkSource, sourceIcon, sourceLabel, messageLinks } from "./conversationFiles";
import { useContentPreview } from "./ContentPreviewContext";
import { isLocalFileReference, remarkDeliveredFiles, publishedFileLinks,publishedFileUrl, type PublishedFileReference } from "../shared/local-file-links";
import "./markdown-delivery.css";
import { hasVerifiedFile, VerifiedFilesContext } from "./VerifiedFilesContext";
import { revealStreamingText } from './streaming-text';
import { useCopyFeedback } from './useCopyFeedback';
import './chat-motion.css';

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useLanguage();
  const [copied, markCopied, clearCopied, copySequence] = useCopyFeedback();
  const [copyError, setCopyError] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const code = React.isValidElement<{ className?: string; children?: React.ReactNode }>(children) ? children : undefined;
  const language = code
    ? code.props.className?.replace("language-", "")
    : "";
  const rawSource = typeof code?.props.children === "string" ? code.props.children : "";
  const source = rawSource.replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || t("代码")}</span>
        {language === "mermaid" && <Button type="button" aria-pressed={showSource} onClick={() => setShowSource(value => !value)}>{t(showSource ? "查看图表" : "查看源码")}</Button>}
        <Button
          aria-label={t("复制代码")}
          data-copied={!!copied || undefined}
          onClick={async () => {
            try {
              await copyText(source);
              setCopyError(false); markCopied('code');
            } catch {
              clearCopied(); setCopyError(true);
            }
          }}
        >
          <span aria-live="polite"><span key={"feedback-" + copySequence}>{t(copyError ? "复制失败" : copied ? "已复制" : "复制代码")}</span></span>
        </Button>
      </div>
      {language === "mermaid" && !showSource ? <MermaidDiagram source={source} /> : <CodePreview text={rawSource} language={language} />}
    </div>
  );
}

const localFile = isLocalFileReference;
function MessageLink({ href = "", children,publishedFile,workspaceLinks=false }: { href?: string; children?: React.ReactNode;publishedFile?:PublishedFileReference;workspaceLinks?:boolean }) {
  if(workspaceLinks){
    const conversation=/^\/chat\/([^/?#]+)$/.exec(href);
    if(conversation)href='/?conversation='+conversation[1];
    else if(/^\/assets\/[^/?#]+(?:\?[^#]*)?$/.test(href))href='/library/'+href.slice('/assets/'.length);
  }
  const { t, errorText, text: localize } = useLanguage();
  const verifiedFiles = useContext(VerifiedFilesContext);
  const source=linkSource(href),sourceName=localize(sourceLabel[source][0], sourceLabel[source][1]);
  const openContent = useContentPreview();
  const [copied, markCopied, clearCopied, copySequence] = useCopyFeedback();
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<{ name: string; path: string; text: string }>();
  const requestVersion = useRef(0);
  useEffect(() => () => { requestVersion.current++; }, []);
  const close = () => { requestVersion.current++; setOpened(false); };
  if(publishedFile)return <a className="local-file-link source-link" href={'/assets/'+encodeURIComponent(publishedFile.assetId)+'?version='+encodeURIComponent(publishedFile.versionId)} title={t('打开文件')+' · '+publishedFile.name} onClick={event=>{
    if(!openContent||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();openContent({kind:'asset',assetId:publishedFile.assetId,versionId:publishedFile.versionId,fileId:publishedFile.fileId,title:publishedFile.name});
  }}><Icon name="file" size={14}/><span>{children}</span></a>;
  const external = /^(?:https?:|mailto:|tel:|\/\/)/i.test(href);
  const workspaceLink=workspaceLinks&&(/^\/library\/[^/?#]+(?:\?[^#]*)?$/.test(href)||/^\/\?conversation=[^&#]+(?:&project=[^&#]*)?$/.test(href));
  const appLink = workspaceLink||/^\/(?:api|assets)(?:[/?]|$)/.test(href);
  if (!href || localFile(href) && !hasVerifiedFile(verifiedFiles, href) || !localFile(href) && !external && !appLink) return <>{children}</>;
  if(workspaceLink)return <a className="source-link" href={href} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();history.pushState(null,'',href);window.dispatchEvent(new PopStateEvent('popstate'));}}>{children}</a>;
  if (!localFile(href)) return <a className="source-link" data-source={source} title={sourceName+" · "+href} href={href} target="_blank" rel="noopener noreferrer"><Icon name={sourceIcon[source]} size={14}/><span>{children}</span></a>;
  return <><Button type="button" role="link" className="local-file-link source-link" data-source="local" title={`${t("打开文件")} · ${sourceName} · ${href}`}
    onClick={async () => {
      if (openContent) { openContent({ kind: 'file', href }); return; }
      const version = ++requestVersion.current;
      setOpened(true); setLoading(true); setError(""); setFile(undefined); clearCopied();
      const conversationId = new URL(window.location.href).searchParams.get("conversation");
      try {
        if (!conversationId) throw new Error("File preview requires a chat");
        const file = await api<{ name: string; path: string; text: string }>(`/conversations/${conversationId}/local-file`, "POST", { href });
        if (version === requestVersion.current) setFile(file);
      } catch (error) { if (version === requestVersion.current) setError(errorText((error as Error).message)); }
      finally { if (version === requestVersion.current) setLoading(false); }
    }}><Icon name={sourceIcon[source]} size={14}/><span>{children}</span></Button>
    {opened && createPortal(<Dialog label={t("文件预览")} className="file-preview-panel" onClose={close}>
      <header className="file-preview-header"><h2>{file?.name ?? children}</h2>
        <Button type="button" aria-label={t("复制路径")} title={t(copied ? "路径已复制" : "复制路径")}
          data-copied={!!copied || undefined}
          onClick={async () => { try { await copyText(file?.path ?? href); markCopied('path'); } catch { clearCopied(); setError(t("复制失败")); } }}><Icon key={"icon-" + copySequence} name={copied ? "check" : "copy"} size={16} />{copied && <span key={"feedback-" + copySequence} className="copy-feedback" role="status">{t('路径已复制')}</span>}</Button>
        <Button type="button" aria-label={t("关闭文件预览")} onClick={close}><Icon name="close" size={18} /></Button>
      </header>
      {file&&<LocalFileActions key={href} url={'/api/conversations/'+encodeURIComponent(new URL(window.location.href).searchParams.get('conversation')??'')+'/local-file/open'} body={{href}}/>}
      <div className="file-preview-content">
        {loading && <p role="status">{t("正在加载文件…")}</p>}
        {error && <p role="alert">{error}</p>}
        {file && (/\.md$/i.test(file.name) ? <MarkdownMessage text={file.text} /> : /\.html?$/i.test(file.name)?<HtmlPreview key={href} name={file.name} url={'/api/conversations/'+encodeURIComponent(new URL(window.location.href).searchParams.get('conversation')??'')+'/local-file/preview?href='+encodeURIComponent(href)} source={<CodePreview text={file.text} language={codeLanguage(file.name)}/>}/>:<CodePreview text={file.text} language={codeLanguage(file.name)} />)}
      </div>
    </Dialog>, document.body)}
  </>;
}

export function tableTsv(rows: string[][]) {
  return rows.map(row => row.map(cell => /[\t\n\r"]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell).join('\t')).join('\n');
}

function MessageTable({ children }: { children?: React.ReactNode }) {
  const {text: localize,  t } = useLanguage();
  const label = localize('复制表格', 'Copy table');
  const [copied, setCopied] = useState<"已复制" | "复制失败" | "">("");
  const table = useRef<HTMLTableElement>(null);
  return <div className="markdown-table">
    <Button className="markdown-table-copy" type="button" aria-label={label} title={copied ? t(copied) : label} onClick={async () => {
      if (!table.current) return;
      const cellText = (node: Node): string => node.nodeName === 'BR' ? '\n' : node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : Array.from(node.childNodes).map(cellText).join('');
      const rows = Array.from(table.current.rows, row => Array.from(row.cells, cell => cellText(cell)));
      try { await copyText(tableTsv(rows)); setCopied('已复制'); } catch { setCopied('复制失败'); }
    }}><Icon name={copied === "已复制" ? "check" : "copy"} size={14} /><span>{copied ? t(copied) : label}</span></Button>
    <div className="table-scroll"><table ref={table}>{children}</table></div>
  </div>;
}

const markdownComponents: Components = {
 span: ({ node, ...props }) => <span key={String(node?.properties.dataStreamKey ?? '')} {...props} />,
 pre: CodeBlock,
 a: ({ node: _, ...props }) => <MessageLink {...props} />,
 table: MessageTable,
};

/** YAML front matter at the very top of a document; simple `key: value` pairs only, otherwise left as Markdown. */
export function splitFrontmatter(text:string):{entries:[string,string][];body:string}|undefined{
 const match=text.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
 if(!match)return undefined;
 const entries:[string,string][]=[];
 for(const line of match[1].split(/\r?\n/)){
  const pair=line.match(/^([A-Za-z0-9_.-]+):[ \t]*(.*)$/);
  if(pair)entries.push([pair[1],pair[2].replace(/^(["'])(.*)\1$/,'$2')]);
  else if(line.trim()&&entries.length){const last=entries[entries.length-1];last[1]=(last[1]&&!/^[|>][-+]?$/.test(last[1])?last[1]+' ':'')+line.trim().replace(/^-\s+/,'');}
  else if(line.trim())return undefined;
 }
 return entries.length?{entries,body:text.slice(match[0].length)}:undefined;
}

function Frontmatter({entries}:{entries:[string,string][]}){
 return <dl className="markdown-frontmatter">{entries.map(([key,value],index)=><div key={key+index}><dt>{key}</dt><dd title={value}>{value||'—'}</dd></div>)}</dl>;
}

const MarkdownMessage = React.memo(function MarkdownMessage({ text,publishedFiles=[], streaming = false,workspaceLinks=false,frontmatter=false }: { text: string;frontmatter?:boolean;workspaceLinks?:boolean; streaming?: boolean;publishedFiles?:PublishedFileReference[] }) {
  const files=React.useMemo(()=>publishedFileLinks(publishedFiles),[publishedFiles]);
  const components=React.useMemo<Components>(()=>{
    const targets=new Map([...files.values()].map(file=>[publishedFileUrl(file),file]));
    return {...markdownComponents,a:({node:_,...props})=><MessageLink {...props} workspaceLinks={workspaceLinks} publishedFile={targets.get(props.href??'')}/>};
  },[files,workspaceLinks]);
  // A mounted history snapshot is already readable. Only later appends reveal.
  const [previous, setPrevious] = useState({ text, from: text.length });
  let from = previous.from;
  if (previous.text !== text) {
    from = streaming && text.startsWith(previous.text) ? previous.text.length : text.length;
    setPrevious({ text, from });
  }
  const reveal = React.useMemo(() => () => revealStreamingText(from, text), [from, text]);
  const meta = React.useMemo(() => frontmatter ? splitFrontmatter(text) : undefined, [frontmatter, text]);
  return (
    <div className="markdown-text">
      {meta && <Frontmatter entries={meta.entries} />}
      <Markdown
        skipHtml
        urlTransform={url => localFile(url) ? url : defaultUrlTransform(url)}
        remarkPlugins={[remarkGfm, remarkCjkFriendly, [remarkDeliveredFiles,{publishedFiles:files}]]}
        rehypePlugins={streaming && from < text.length ? [reveal] : []}
        components={components}
      >
        {meta ? meta.body : text}
      </Markdown>
    </div>
  );
});
export default MarkdownMessage;

export function LinkedMessageText({text}:{text:string}) {
 const links=React.useMemo(()=>messageLinks(text),[text]);
 let end=0;
 return <>{links.map(link=>{const before=text.slice(end,link.start);end=link.end;const href=localFile(link.href)?link.href:defaultUrlTransform(link.href);return <React.Fragment key={link.start}>{before}{href?<MessageLink href={href}>{link.label}</MessageLink>:text.slice(link.start,link.end)}</React.Fragment>;})}{text.slice(end)}</>;
}
