import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RuntimeProbeSummary } from '../src/RuntimeSetup';
import type { CliStatus } from '../shared/types';

const diagnostics = {
  host: 'local', executable: 'missing', probe: 'acp', auth: 'not-verified', standaloneClaude: true,
} satisfies NonNullable<CliStatus['diagnostics']>;

it('does not show a missing adapter when the actual launcher probe succeeds', () => {
  const html = renderToStaticMarkup(createElement(RuntimeProbeSummary, {
    status: { status: 'ready', version: null, diagnostics },
  }));
  expect(html).toContain('Connection check passed');
  expect(html).not.toContain('adapter is not runnable');
});

it('explains that a standalone Claude installation does not supply the ACP adapter when launch fails', () => {
  const html = renderToStaticMarkup(createElement(RuntimeProbeSummary, {
    status: { status: 'unavailable', version: null, diagnostics: { ...diagnostics, probe: 'failed' } },
  }));
  expect(html).toContain('separate ACP adapter is not runnable');
});
