import { useState } from 'react';
import type { MarketDetail, MarketItem } from '../shared/market';
import { localPetRepository, type ExtensionSnapshot, type ThemePack, type UiExtension } from '../shared/ui-extensions';
import { api } from './api';
import { useUiExtensions } from './UiExtensions';
import { useLanguage } from './i18n';
import { useTheme } from './ThemeProvider';
import Dialog from './Dialog';
import Button from './ui/Button';
import Icon from './ui/Icon';
import { PetFigure, savePetPreference, usePetPreference } from './MandalaPet';
export default function MarketExtensionDialog({ item, detail, loading, error, onRetry, onClose, onBusy }: {
  item: MarketItem; detail: MarketDetail | null; loading: boolean; error: string; onRetry: () => void; onClose: () => void; onBusy: (value: boolean) => void;
}) {
  const { t, text, setLanguage } = useLanguage(), { snapshot, update, refresh } = useUiExtensions(), theme = useTheme(), [petPreference] = usePetPreference();
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
  const plugin = snapshot?.plugins?.find(entry => entry.catalogId === item.catalogId);
  const installed = snapshot?.items.find(entry => entry.catalogId === item.catalogId), local = installed?.package.repository === localPetRepository;
  const metadata = detail?.plugin ?? detail?.extension, packageInstalled = plugin ?? installed;
  const changed = packageInstalled && metadata && (packageInstalled.package.sha256 !== metadata.package.sha256 || packageInstalled.version !== detail?.version);
  const action = async (work: () => Promise<void>) => {
    setBusy(true); onBusy(true); setFailure(''); setNotice('');
    try { await work(); } catch (reason) { setFailure((reason as Error).message); await refresh(); }
    finally { setBusy(false); onBusy(false); }
  };
  const install = () => action(async () => {
    if (!snapshot || !detail || !metadata) return;
    update(await api<ExtensionSnapshot>('/market/extensions/install', 'POST', { catalogId: item.catalogId, version: detail.version, digest: metadata.package.sha256, revision: snapshot.revision }));
    setNotice(text('已安装，应用后生效。', 'Installed. Apply it to use it.'));
  });
  const apply = (entry: UiExtension) => action(async () => {
    if (entry.data.format === 'mandala-language') setLanguage(entry.data.locale);
    else if (entry.data.format === 'mandala-pet') savePetPreference({ ...petPreference, figure: entry.catalogId });
    else {
      const data: ThemePack = entry.data;
      if (data.background.image) {
        const bitmap = await createImageBitmap(await (await fetch(data.background.image)).blob());
        const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= 40000000;
        bitmap.close(); if (!valid) throw Error(text('背景图片尺寸过大。', 'Background image dimensions are too large.'));
      }
      const identity = entry.pluginId ? 'plugin-' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entry.catalogId)))).map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 32) : entry.id;
      const palette = { ...data.theme, id: `market:${identity}:${data.theme.variant}` };
      const custom = [...theme.saved.custom.filter(old => old.id !== palette.id), palette];
      if (custom.length > 20) throw Error(text('最多保存 20 个自定义主题，请先移除一个。', 'Remove a custom theme before adding more (limit 20).'));
      theme.save({ ...theme.saved, mode: palette.variant, [palette.variant]: palette.id, custom, appearance: data.appearance, background: data.background });
    }
    setNotice(text('已应用', 'Applied'));
  });
  return <Dialog label={text('扩展详情', 'Extension details')} className="market-drawer overview" locked={busy} onClose={onClose}>
    <header className="market-drawer-header"><div><h2>{item.name}</h2><p>{item.kind === 'plugin' ? text('数据型插件', 'Data plugin') : item.kind === 'theme' ? t('主题') : item.kind === 'pet' ? text('桌宠', 'Pet') : t('语言包')}</p></div><Button aria-label={t('关闭详情')} disabled={busy} onClick={onClose}><Icon name="close" size={20}/></Button></header>
    <div className="market-drawer-body">
      {(failure || error && !local) && <p role="alert" className="error">{failure || error}</p>}
      {notice && <p role="status">{notice}</p>}
      {local && installed?.data.format === 'mandala-pet' ? <>
        <p>{text('从文件导入的桌宠，只保存在这台电脑上。', 'A pet imported from a file. It is kept on this computer only.')}</p>
        <div className="pet-preview-states" aria-label={text('桌宠状态预览', 'Pet state preview')}>{(['idle', 'working', 'waiting', 'error'] as const).map(state => <figure key={state}><PetFigure state={state} pack={installed.data.format === 'mandala-pet' ? installed.data : undefined} size={48} /></figure>)}</div>
      </> : loading ? <p>{t('正在读取详情…')}</p> : !detail ? <Button onClick={onRetry}>{t('重试')}</Button> : <>
        <p dir="auto">{detail.description}</p>
        <dl className="market-extension-meta"><dt>{t('版本')}</dt><dd>{detail.version}</dd><dt>{text('作者', 'Author')}</dt><dd>{detail.publisher}</dd><dt>{text('需要 Mandala', 'Requires Mandala')}</dt><dd>{metadata?.minAppVersion}</dd></dl>
        {item.kind === 'plugin' && <>
          <p className="field-hint">{text('仅提供外观与翻译数据，不运行代码。安装、更新和卸载会处理整个插件。', 'Provides appearance and translation data without running code. Install, update and uninstall affect the whole plugin.')}</p>
          <p>{text('内容：', 'Includes: ')}{(detail.kinds ?? plugin?.kinds ?? []).map(kind => kind === 'theme' ? text('主题', 'Themes') : kind === 'pet' ? text('桌宠', 'Pets') : text('语言包', 'Languages')).join(' / ')}</p>
          {plugin && <div className="market-plugin-contributions">{plugin.items.map(entry => <div key={entry.catalogId}><span>{entry.name}</span><Button disabled={busy} onClick={() => void apply(entry)}>{entry.kind === 'theme' ? text('应用主题', 'Apply theme') : entry.kind === 'pet' ? text('使用此桌宠', 'Use this pet') : text('使用此语言', 'Use this language')}</Button></div>)}</div>}
          <p className="field-hint">{text('卸载会保留已应用的主题副本；正在使用的语言和桌宠分别恢复为英文和官方形象。', 'Uninstalling keeps applied theme copies; an active language or pet falls back to English or the official figure.')}</p>
        </>}
        {detail.unsupported && <p role="alert">{text('此扩展需要更新版本的 Mandala。', 'This extension requires a newer version of Mandala.')}</p>}
        {installed?.data.format === 'mandala-theme' && <div className="market-theme-preview" aria-label={text('主题配色', 'Theme palette')} style={{ background: installed.data.theme.colors.bg, color: installed.data.theme.colors.text }}><strong>{installed.name}</strong><p style={{color:installed.data.theme.colors.accent}}>Aa · Mandala</p></div>}
        {installed?.data.format === 'mandala-pet' && <div className="pet-preview-states" aria-label={text('桌宠状态预览', 'Pet state preview')}>{(['idle', 'working', 'waiting', 'error'] as const).map(state => <figure key={state}><PetFigure state={state} pack={installed.data.format === 'mandala-pet' ? installed.data : undefined} size={48} /><figcaption>{{ idle: text('待机', 'Idle'), working: text('忙碌', 'Working'), waiting: text('等你处理', 'Needs you'), error: text('出错', 'Error') }[state]}</figcaption></figure>)}</div>}
        <p className="field-hint">{text('安装不会自动切换当前外观或语言。', 'Installing does not switch your current appearance or language.')}</p>
        {item.kind === 'theme' && <p className="field-hint">{text('应用会使用主题的配色、字体选项和背景。卸载后，已应用的外观副本仍保留。', 'Applying uses the theme’s colors, font options and background. Uninstalling keeps the applied appearance copy.')}</p>}
        {item.kind === 'pet' && <p className="field-hint">{text('使用后，Mandala 面板顶部和桌面浮窗会换成这个形象；卸载正在使用的桌宠会恢复官方形象。', 'Using it replaces the figure in the Mandala panel and the desktop window. Uninstalling the pet in use restores the official figure.')}</p>}
        {item.kind === 'language' && <p className="field-hint">{text('未翻译的文字显示英文；卸载正在使用的语言包会恢复英文。', 'Missing translations use English. Uninstalling the active language restores English.')}</p>}
        <a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">{t('查看源目录')}</a>
      </>}
    </div>
    <footer className="market-drawer-footer">
      {packageInstalled && <Button disabled={busy || !snapshot} onClick={() => void action(async () => { update(await api<ExtensionSnapshot>('/market/extensions/uninstall', 'POST', { catalogId: item.catalogId, revision: snapshot!.revision })); onClose(); })}>{t('卸载')}</Button>}
      {(!packageInstalled || changed) && <Button className="primary" disabled={busy || !snapshot || !metadata || !!detail?.unsupported} onClick={() => void install()}>{changed ? text('更新', 'Update') : t('安装')}</Button>}
      {installed && <Button className="primary" disabled={busy} onClick={() => void apply(installed)}>{item.kind === 'theme' ? text('应用主题', 'Apply theme') : item.kind === 'pet' ? text('使用此桌宠', 'Use this pet') : text('使用此语言', 'Use this language')}</Button>}
    </footer>
  </Dialog>;
}
