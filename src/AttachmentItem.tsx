import Button from './ui/Button';
import Textarea from './ui/Textarea';
import { isDirectoryReference } from './composer-files';
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../shared/chat-input";
import { useLanguage } from "./i18n";
import Dialog from "./Dialog";
import Icon from "./ui/Icon";
import "./attachments.css";
import { useContentPreview } from "./ContentPreviewContext";

export default function AttachmentItem({ item, conversationId, onRemove, onChange, disabled = false }: {
  item: File | Attachment; conversationId?: string; onRemove?: () => void; onChange?: (file: File) => void | Promise<void>; disabled?: boolean;
}) {
  const {text: localize,  t } = useLanguage();
  const openContent = useContentPreview();
  const [localImage, setLocalImage] = useState<{ file: File; url: string }>();
  const [preview, setPreview] = useState(false);
  const [directoryPath, setDirectoryPath] = useState<{file: File; path: string}>();
  const [editText, setEditText] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false), [saveError, setSaveError] = useState('');
  const [failedUrl, setFailedUrl] = useState("");
  const [textPreview, setTextPreview] = useState<{ file: File; text?: string; failed?: boolean }>();
  const mimeType = "id" in item ? item.mimeType : item.type;
  const directory = !('id' in item) && isDirectoryReference(item);
  const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType);
  const textFile = !("id" in item) && !directory && (mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mimeType) || /\.(txt|md|markdown|log|csv|tsv|json|ya?ml|toml|ini|sql|py|[cm]?[jt]sx?|sh|xml|html|css)$/i.test(item.name));
  const shortenedPreview = (textPreview?.text?.length ?? 0) > 64 * 1024;
  const editSize = editText === null ? 0 : new Blob([editText]).size;
  const validEdit = editSize > 0 && editSize <= 20 * 1024 * 1024;
  const closePreview = () => { if (!savingEdit) { setPreview(false); setEditText(null); setSaveError(''); } };
  useEffect(() => {
    if ('id' in item || !directory) return;
    let active = true;
    void item.text().then(path => { if (active) setDirectoryPath({file: item, path}); }).catch(() => {});
    return () => { active = false; };
  }, [item, directory]);
  useEffect(() => {
    if ('id' in item || !textFile || !preview) return;
    let active = true;
    void item.text().then(text => { if (active) setTextPreview({ file: item, text }); })
      .catch(() => { if (active) setTextPreview({ file: item, failed: true }); });
    return () => { active = false; };
  }, [item, textFile, preview]);
  useEffect(() => {
    if ("id" in item || !image) return;
    const url = URL.createObjectURL(item);
    setLocalImage({ file: item, url });
    return () => URL.revokeObjectURL(url);
  }, [item, image]);
  const src = "id" in item ? `/api/conversations/${conversationId}/attachments/${item.id}` : localImage?.file === item ? localImage.url : "";
  const failed = !!src && failedUrl === src;
  return <span className="attachment-chip" data-source={directory ? 'directory' : 'attachment'} role={directory ? 'group' : undefined} aria-label={directory ? (localize('文件夹 ', 'Folder ')) + item.name : undefined} title={directory && directoryPath?.file === item ? directoryPath.path : item.name}>
    {directory ? <><Icon name="folder" size={16}/><span className="attachment-name">{item.name}</span></> : image && src && !failed ? <Button type="button" className="attachment-preview-button" aria-label={t("预览图片 {name}", { name: item.name })}
      onClick={() => { if (openContent && 'id' in item) openContent({ kind: 'image', name: item.name, src }); else setPreview(true); }}>
      <img src={src} alt={item.name} onError={() => setFailedUrl(src)} />
      <span className="attachment-name">{item.name}</span>
    </Button> : textFile ? <Button type="button" className="attachment-preview-button attachment-text-button" aria-label={(localize('预览文本 ', 'Preview text ')) + item.name} onClick={() => setPreview(true)}>
      <Icon name="file" size={16} /><span className="attachment-name">{item.name}</span>
    </Button> : 'id' in item&&openContent?<Button type="button" className="attachment-preview-button" onClick={()=>openContent({kind:'attachment',name:item.name,src:src+'?download=1',mimeType,size:item.size})}><Icon name="paperclip" size={15}/><span className="attachment-name">{item.name}</span></Button>: <><Icon name="paperclip" size={15} /><span className="attachment-name">{item.name}</span></>}
    {onRemove && <small>{directory ? localize('文件夹', 'Folder') : `${Math.ceil(item.size / 1024)} KB`}</small>}
    {failed && <small>{t("图片无法加载")}</small>}
    {onRemove && <Button type="button" className="attachment-remove" aria-label={t("移除附件 {name}", { name: item.name })}
      disabled={disabled} onClick={onRemove}><Icon name="close" size={14} /></Button>}
    {preview && textFile && createPortal(<Dialog label={localize('文本预览', 'Text preview')} className="text-preview-panel" locked={savingEdit} onClose={closePreview}>
      <header className="image-preview-header"><Icon name="file" size={20} /><h2>{item.name}</h2>
        <Button type="button" disabled={savingEdit} aria-label={localize('关闭文本预览', 'Close text preview')} onClick={closePreview}><Icon name="close" size={18} /></Button>
      </header>
      {textPreview?.file !== item ? <p role="status">{localize('正在读取…', 'Loading…')}</p> : textPreview.failed ? <p role="alert">{localize('无法预览文本，请移除后重新粘贴。', 'Unable to preview this text. Remove it and paste again.')}</p> : editText === null ? <pre>{textPreview.text?.slice(0, 64 * 1024)}</pre> : <Textarea aria-label={localize('附件文本', 'Attachment text')} value={editText} onChange={event => setEditText(event.target.value)} rows={12} disabled={disabled || savingEdit} />}
      {editText === null ? <p className="text-preview-note">{localize(shortenedPreview ? '预览已截取，发送时会附上完整文本。' : '发送时会附上完整文本。', shortenedPreview ? 'Preview shortened. The full text will be attached when you send.' : 'The full text will be attached when you send.')}</p> : <p className="text-preview-note" role={validEdit ? undefined : 'alert'}>{localize('仅修改本次附件内容，不改动原文件。内容须为 1 字节至 20 MB。', 'Edits apply to this attachment only. Use 1 byte to 20 MB.')}</p>}
      {onChange && textPreview?.file === item && !textPreview.failed && <div className="text-preview-actions">
        {editText === null ? <Button type="button" disabled={disabled} onClick={() => setEditText(textPreview.text ?? '')}>{localize('编辑文本', 'Edit text')}</Button> : <>
          <Button type="button" disabled={savingEdit} onClick={() => { setEditText(null); setSaveError(''); }}>{localize('取消', 'Cancel')}</Button>
          <Button type="button" className="primary" disabled={disabled || savingEdit || !validEdit} onClick={async () => {
            if ('id' in item || editText === null || !validEdit) return;
            setSavingEdit(true); setSaveError('');
            try { await onChange(new File([editText], item.name, { type: item.type || 'text/plain' })); setEditText(null); }
            catch { setSaveError(localize('无法保存修改，输入仍保留，请重试。', 'Unable to save changes. Your input is retained; try again.')); }
            finally { setSavingEdit(false); }
          }}>{localize(savingEdit ? '正在保存…' : '保存修改', savingEdit ? 'Saving…' : 'Save changes')}</Button>
        </>}
      </div>}
      {saveError && <p className="form-error" role="alert">{saveError}</p>}
    </Dialog>, document.body)}
    {preview && image && createPortal(<Dialog label={t("图片预览")} className="image-preview-panel" onClose={() => setPreview(false)}>
      <header className="image-preview-header"><h2>{item.name}</h2>
        <Button type="button" aria-label={t("关闭图片预览")} onClick={() => setPreview(false)}><Icon name="close" size={18} /></Button>
      </header>
      {failed ? <p role="status">{t("图片无法加载")}</p> : <img className="image-preview-full" src={src} alt={item.name} onError={() => setFailedUrl(src)} />}
    </Dialog>, document.body)}
  </span>;
}
