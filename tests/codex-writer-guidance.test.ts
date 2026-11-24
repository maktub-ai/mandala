import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TurnProcess from '../src/TurnProcess';
import { groupChatTurns } from '../src/chatTurns';
import type { DisplayEvent } from '../shared/types';
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

describe('Codex mailbox preparation guidance',()=>{
 const renderRun=(data:Record<string,unknown>,chinese:boolean)=>{
  const events:DisplayEvent[]=[
    {id:1,conversationId:'chat',kind:'user',data:{runId:'run',text:'Draft text'},createdAt:'2026-11-24T00:00:00Z'},
    {id:2,conversationId:'chat',kind:'error',data:{runId:'run',message:'Untrusted raw native detail',...data},createdAt:'2026-11-24T00:00:01Z'},
    {id:3,conversationId:'chat',kind:'status',data:{runId:'run',status:'error'},createdAt:'2026-11-24T00:00:02Z'},
  ];
  const element=React.createElement(TurnProcess,{turn:groupChatTurns(events)[0],onInspect(){}});
  return chinese ? renderChineseMarkup(element) : renderToStaticMarkup(element);
 };
 it.each([
  ['codex_mailbox_path_invalid', 'private mailbox directory', '专用通信目录'],
  ['codex_mailbox_setup_failed', 'Windows sandbox', 'Windows 沙箱'],
  ['codex_mailbox_capability_unverified', 'Codex capability', 'Codex 访问身份'],
  ['codex_mailbox_permissions_unverified', 'mailbox permissions', '通信目录权限'],
 ])('localizes safe and actionable guidance for %s',(code,enStage,zhStage)=>{
  const en=renderRun({code,nativeTurnSubmitted:false},false), zh=renderRun({code,nativeTurnSubmitted:false},true);
  expect(en).toContain(enStage);
  expect(en).toContain('not sent to Codex');
  expect(en).toContain('review the saved request');
  expect(zh).toContain(zhStage);
  expect(zh).toContain('消息未发送到 Codex');
  expect(zh).toContain('检查已保存的请求');
  for(const display of [en,zh]) expect(display).not.toContain('Untrusted raw native detail');
 });
 it('does not assert non-submission on an unknown or potentially submitted turn',()=>{
  for(const data of [
   {code:'codex_mailbox_setup_failed',nativeTurnSubmitted:true},
   {code:'codex_mailbox_setup_failed'},
   {code:'codex_mailbox_unknown',nativeTurnSubmitted:false},
  ]) expect(renderRun(data,false)).not.toContain('not sent to Codex');
 });
});

it('localizes the known-unsent queue receipt without implying a resend',()=>{
 const text='消息未发送到 Codex；原请求已保存。';
 expect(render(text)).toBe('<p>The message was not sent to Codex. The original request was saved.</p>');
 expect(render(text,true)).toBe('<p>'+text+'</p>');
});
