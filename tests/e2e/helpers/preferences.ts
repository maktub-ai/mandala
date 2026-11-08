import { productEnv } from '../../../cli/product-env.mjs';

// Existing scenarios exercise an explicit UI preference; first-visit tests use empty state.
export function storedUiState(language = 'zh-CN') {
  return { cookies: [], origins: [{ origin: `http://127.0.0.1:${productEnv('E2E_PORT') ?? 4318}`, localStorage: [
    { name: 'mana-language', value: language }, { name: 'mana-team-view', value: 'graph' }, { name: 'mana-progress-view', value: 'list' },
  ] }] };
}
