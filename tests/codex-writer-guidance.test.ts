import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useLanguage } from '../src/i18n';
import { renderChineseMarkup } from './helpers/render-ui';

const modern = 'Codex conversation is open in another client';
const historical = 'thread private-id already has an active writer';
const unknown = modern + ' (unknown source)';

function render(message: string, chinese = false) {
  function ErrorText() {
    return React.createElement('p', null, useLanguage().errorText(message));
  }
  const element = React.createElement(ErrorText);
  return chinese ? renderChineseMarkup(element) : renderToStaticMarkup(element);
}

describe('Codex writer conflict guidance', () => {
  it('suggests a normal quit after saving and manual retry in the original chat', () => {
    expect(render(modern)).toContain('save your work and quit that Codex client normally');
    expect(render(modern)).toContain('send it again in this chat');
    expect(render(modern, true)).toContain('先保存工作，再正常退出那个 Codex 客户端');
    expect(render(modern, true)).toContain('在当前对话手动发送');
  });

  it('keeps historical advice neutral and does not expose the native thread ID', () => {
    expect(render(historical)).toBe('<p>Another Codex client is holding this conversation open.</p>');
    expect(render(historical, true)).toBe('<p>另一个 Codex 客户端仍占用此对话。</p>');
  });

  it('does not reinterpret an unrecognized error as a proven pre-submit conflict', () => {
    expect(render(unknown)).toBe('<p>' + unknown + '</p>');
    expect(render(unknown, true)).toBe('<p>' + unknown + '</p>');
  });
});
