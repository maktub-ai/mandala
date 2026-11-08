import { useEffect, useRef, useState } from 'react';
import { maxPetPackBytes } from '../shared/mandala-pet';
import type { ExtensionSnapshot } from '../shared/ui-extensions';
import { api } from './api';
import { useLanguage } from './i18n';
import { useUiExtensions } from './UiExtensions';
import { PetFigure, desktopPet, usePetPreference } from './MandalaPet';
import Button from './ui/Button';
import Input from './ui/Input';
import SegmentedControl from './ui/SegmentedControl';
import './mandala-pet.css';

/** Chooses the Mandala pet on this device: the official figure, a Market pet or one imported from a file. */
export default function PetSettings({ onBrowse }: { onBrowse: () => void }) {
  const { text } = useLanguage();
  const { snapshot, refresh, update } = useUiExtensions();
  const [preference, setPreference] = usePetPreference();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null), desktop = desktopPet();
  useEffect(() => { if (!snapshot) void refresh(); }, [snapshot, refresh]);
  const pets = (snapshot?.items ?? []).filter(item => item.data.format === 'mandala-pet');
  const importPet = async (picked?: File) => {
    if (!picked || !snapshot) return;
    setBusy(true); setError('');
    try {
      if (picked.size > maxPetPackBytes) throw Error('size');
      const next = await api<ExtensionSnapshot>('/market/extensions/import-pet', 'POST', { raw: await picked.text(), revision: snapshot.revision });
      update(next);
      const added = next.items.filter(item => item.data.format === 'mandala-pet').sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0];
      if (added) setPreference({ ...preference, figure: added.catalogId });
    } catch { setError(text('无法导入：请使用有效的 Mandala 桌宠文件（JSON，最大 4 MiB，至少包含待机、忙碌、等你处理和出错四种状态）。', 'Import failed. Use a valid Mandala pet file (JSON, up to 4 MiB, with at least the idle, working, waiting and error states).')); await refresh(); }
    finally { setBusy(false); }
  };
  const choices = [{ id: 'official', name: text('花瓣精灵', 'Petal'), note: text('官方 · 跟随主题', 'Official · follows the theme'), pack: undefined }, ...pets.map(item => ({ id: item.catalogId, name: item.name, note: item.publisher === 'Local' ? text('从文件导入', 'Imported') : item.publisher, pack: item.data.format === 'mandala-pet' ? item.data : undefined }))];
  return <section className="pet-settings" aria-label={text('桌宠', 'Pet')}>
    <strong>{text('桌宠', 'Pet')}</strong>
    <p className="field-hint">{text('显示在 Mandala 面板顶部，用动作提示当前状态。只保存在这台设备上。', 'Shown at the top of the Mandala panel; its motion shows the current state. Saved on this device only.')}</p>
    <div className="pet-settings-list" role="group" aria-label={text('选择桌宠', 'Choose a pet')}>
      {choices.map(choice => <button key={choice.id} type="button" className="pet-choice" aria-pressed={preference.figure === choice.id || (choice.id === 'official' && !choices.some(other => other.id === preference.figure))} onClick={() => setPreference({ ...preference, figure: choice.id })}>
        <PetFigure state="idle" pack={choice.pack} size={52} />
        <span>{choice.name}</span><small>{choice.note}</small>
      </button>)}
    </div>
    <div className="pet-settings-actions">
      <Button disabled={busy || !snapshot} busy={busy} onClick={() => file.current?.click()}>{text('从文件导入', 'Import from file')}</Button>
      <Button variant="ghost" onClick={onBrowse}>{text('在市场浏览更多', 'Browse the Market')}</Button>
      <Input ref={file} type="file" hidden accept=".json,application/json" aria-label={text('导入桌宠文件', 'Import pet file')} onChange={event => { void importPet(event.target.files?.[0]); event.target.value = ''; }} />
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {desktop && <div className="pet-settings-actions"><span className="field-hint">{text('显示位置', 'Placement')}</span>
      <SegmentedControl label={text('显示位置', 'Placement')} value={preference.placement} onChange={value => { const placement = value === 'desktop' ? 'desktop' : 'panel'; setPreference({ ...preference, placement }); void (placement === 'desktop' ? desktop.show() : desktop.hide()).catch(() => {}); }}
        options={[{ value: 'panel', label: text('面板顶部', 'Panel') }, { value: 'desktop', label: text('桌面浮窗', 'Desktop window') }]} />
    </div>}
  </section>;
}
