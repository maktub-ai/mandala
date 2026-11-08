import React from 'react';
import { renderChineseMarkup } from './helpers/render-ui';
import { describe, expect, it } from 'vitest';
import { useLanguage } from '../src/i18n';

describe('Chinese team terminology', () => {
  it('localizes interface terms while preserving user-provided names', () => {
    function Labels() {
      const { t } = useLanguage();
      return React.createElement('p', null, t('Agent 设置'), ' · ', t('查看智能体：{name}', { name: 'Agent A' }));
    }
    expect(renderChineseMarkup(React.createElement(Labels))).toBe('<p>智能体 设置 · 查看智能体：Agent A</p>');
  });
});
