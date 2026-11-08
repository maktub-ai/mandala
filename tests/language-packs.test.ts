import { expect, it } from 'vitest';
import { localizeMessage, parseLanguagePack } from '../shared/ui-extensions';
const arabic = { format: 'mandala-language', version: 1, locale: 'ar', name: 'العربية', direction: 'rtl', messages: { '市场': 'السوق', '安装 {name}': 'تثبيت {name}' } };
it('loads community translations, preserves parameters, and falls back to English without displaying unknown keys', () => {
  const pack = parseLanguagePack(arabic);
  expect(localizeMessage('ar', pack, '市场', 'Market')).toBe('السوق');
  expect(localizeMessage('ar', pack, '安装 {name}', 'Install {name}', { name: 'Paper' })).toBe('تثبيت Paper');
  expect(localizeMessage('ar', pack, '重试', 'Retry')).toBe('Retry');
  expect(localizeMessage('en', pack, '市场', 'Market')).toBe('Market');
});
it.each([
  { ...arabic, locale: 'en' }, { ...arabic, locale: 'invalid-locale-@' }, { ...arabic, direction: 'sideways' },
  { ...arabic, script: 'alert(1)' }, { ...arabic, messages: { '安装 {name}': 'تثبيت' } },
  { ...arabic, messages: JSON.parse('{"__proto__":"bad"}') },
])('rejects malformed or executable language data', value => { expect(() => parseLanguagePack(value)).toThrow(/invalid/); });
