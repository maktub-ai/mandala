import Button from './ui/Button';
import Input from './ui/Input';
import Icon from "./ui/Icon";
import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import Dialog from "./Dialog";
import { useLanguage } from "./i18n";

type DirectoryListing = {
  path: string;
  parent: string | null;
  home: string;
  breadcrumbs: { name: string; path: string }[];
  entries: { name: string; path: string }[];
};

export default function FolderPicker({ initialPath, onSelect, onClose, purpose = "configuration" }: {
  initialPath: string;
  purpose?: "configuration" | "conversation";
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [pathDraft, setPathDraft] = useState(initialPath);
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestId = useRef(0);
  const open = async (path?: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(false);
    setListing(null);
    try {
      const next = await api<DirectoryListing>("/directories" + (path ? "?path=" + encodeURIComponent(path) : ""));
      if (id !== requestId.current) return;
      setListing(next);
      setPathDraft(next.path);
      setSearch("");
    } catch {
      if (id === requestId.current) setError(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };
  useEffect(() => {
    void open(initialPath || undefined);
    return () => { requestId.current++; };
  }, []);
  const entries = listing?.entries.filter((item) =>
    (showHidden || !item.name.startsWith(".")) && item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];

  return <Dialog label={t("选择文件夹")} className="folder-picker" onClose={onClose}>
    <div className="settings-header"><div><p className="eyebrow">Mandala / {t("本机目录")}</p>
      <h2>{t("选择文件夹")}</h2></div>
      <Button type="button" className="icon-button" aria-label={t("关闭文件夹选择")} onClick={onClose}><Icon name="close" size={16} /></Button></div>
    <p className="settings-intro">{t(purpose === "conversation" ? "选择后用于这段新对话，不修改项目配置。" : "浏览本机目录。选择后只更新草稿，保存配置后才生效。")}</p>
    <div className="settings-scroll folder-picker-content">
      <form className="folder-path-form" onSubmit={(event) => { event.preventDefault(); void open(pathDraft); }}>
        <Input aria-label={t("目录路径")} value={pathDraft} disabled={loading}
          onChange={(event) => setPathDraft(event.target.value)}
          placeholder={t("输入绝对路径")} />
        <Button type="submit" disabled={loading || !pathDraft.trim()}>{t("前往")}</Button>
      </form>
      <div className="folder-breadcrumbs" aria-label={t("当前路径")}>
        {listing?.breadcrumbs.map((crumb) => <Button type="button" key={crumb.path}
          aria-label={crumb.path} onClick={() => void open(crumb.path)}>{crumb.name}</Button>)}
      </div>
      <div className="folder-picker-tools">
        <Button type="button" disabled={loading || !listing?.parent} onClick={() => void open(listing?.parent ?? undefined)}>↑ {t("上一级")}</Button>
        <Button type="button" disabled={loading} onClick={() => void open(listing?.home)}>{t("个人目录")}</Button>
        <Input aria-label={t("搜索文件夹")} value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder={t("搜索当前目录")} disabled={!listing} />
      </div>
      {error && <p role="alert" className="folder-error">{t("无法打开这个目录，请检查路径或权限。")}</p>}
      <div className="folder-list" aria-label={t("文件夹列表")}>
        {loading ? <p className="field-hint">{t("正在读取目录…")}</p> : entries.length ? entries.map((item) =>
          <Button type="button" key={item.path} aria-label={item.name} onClick={() => void open(item.path)}>
            <span aria-hidden="true">▱</span>{item.name}<span aria-hidden="true">›</span>
          </Button>) : listing && <p className="field-hint">{t("没有匹配的文件夹。")}</p>}
      </div>
      <label className="folder-hidden"><Input type="checkbox" checked={showHidden}
        onChange={(event) => setShowHidden(event.target.checked)} />{t("显示隐藏文件夹")}</label>
    </div>
    <div className="settings-footer"><span>{listing?.path ?? t("请先打开一个目录。")}</span>
      <Button type="button" className="primary" disabled={!listing || loading || pathDraft !== listing.path}
        onClick={() => listing && onSelect(listing.path)}>{t("使用此文件夹")}</Button></div>
  </Dialog>;
}
