import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, test} from 'vitest';
import QueuedMessages from '../src/QueuedMessages';
import type {QueuedInput} from '../shared/tasks';

const saved:QueuedInput={id:'first',conversationId:'chat',text:'Original request',state:'queued',createdAt:''};
const render=(...inputs:QueuedInput[])=>renderToStaticMarkup(createElement(QueuedMessages,{inputs,onSend:()=>{},onCancel:()=>{},onCopy:()=>{},onReuse:()=>{}}));

test.each([
  ['starting','Starting your request'],
  ['connecting','Connecting to the remote computer'],
  ['remote_unavailable','Remote computer unavailable'],
  [undefined,'Saved requests'],
] as const)('does not render a saved %s input as waiting in line', (admission, label)=>{
  const html=render({...saved,admission});
  expect(html).toContain('aria-label="'+label+'"');
  expect(html).not.toContain('aria-label="Queued messages"');
});

test('keeps real waiting separate from the starting request above it',()=>{
 const html=render({...saved,admission:'starting'},{...saved,id:'second',text:'Second request',admission:'waiting'});
 expect(html).toContain('aria-label="Starting your request"');
 expect(html).toContain('aria-label="Queued messages"');
 expect(html).toContain('aria-label="Resume sending"');
});
