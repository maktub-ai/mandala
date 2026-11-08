import Button from './ui/Button';
import { modelOptions } from "../shared/chat-input";
import type { ModelChoice } from '../shared/types';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
import Select from './ui/Select';

export type ModelCatalog = { choices: ModelChoice[]; loading: boolean; error: string };
export default function ModelCatalogPicker({ catalog, value, onChange, onRefresh, disabled = false, ariaLabel, defaultLabel }: {
  catalog: ModelCatalog; value: string; onChange: (value: string) => void; onRefresh: () => void; disabled?: boolean; ariaLabel?: string; defaultLabel?: string;
}) {
  const { t, errorText } = useLanguage();
  const choices = modelOptions(catalog.choices);
  choices[0] = {value:"",label:defaultLabel ?? t("留空，沿用原生默认模型")};
  if (value && !choices.some(m => m.value === value)) choices.push({ value, label: value });
  return <div className="model-catalog-picker">
    <div className="model-catalog-controls"><Select icon="sparkles" ariaLabel={ariaLabel ?? t('模型')} allowCustom value={value} disabled={disabled}
      onChange={onChange} options={choices} />
      <Button type="button" aria-label={t('刷新模型目录')} title={t('刷新模型目录')} disabled={catalog.loading} onClick={onRefresh}><Icon name="refresh" size={16} /></Button></div>
    <p className="field-hint" role="status">{catalog.loading ? t('正在读取模型候选…') : catalog.error ? errorText(catalog.error) :
      catalog.choices.length ? t('已读取 {count} 个候选', { count: catalog.choices.length }) : t('CLI 未返回模型候选；可输入自定义模型 ID。')}</p>
  </div>;
}
