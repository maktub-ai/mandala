import { describe, expect, it } from 'vitest';
import { modelOptions, modelShortLabel, providerGroups } from '../shared/chat-input';

describe('composer model providers', () => {
  const mixed = [
    { id: 'magpie/astra', label: 'magpie / GPT-6.2 Astra · OpenAI', provider: 'magpie', shortLabel: 'GPT-6.2 Astra · OpenAI', isDefault: true },
    { id: 'openai/astra', label: 'openai / GPT-6.2 Astra', provider: 'openai' },
  ];
  it('groups options by provider only when a runtime offers more than one', () => {
    expect(providerGroups(mixed)).toBe(true);
    expect(modelOptions(mixed).slice(1).map(option => option.group)).toEqual(['magpie', 'openai']);
    const single = [{ id: 'gpt', label: 'GPT', provider: 'openai' }, { id: 'mini', label: 'Mini', provider: 'openai' }];
    expect(providerGroups(single)).toBe(false);
    expect(modelOptions(single).some(option => 'group' in option)).toBe(false);
  });
  it('shows a short name without the provider prefix', () => {
    expect(modelShortLabel(mixed[0])).toBe('GPT-6.2 Astra · OpenAI');
    expect(modelShortLabel(mixed[1])).toBe('GPT-6.2 Astra');
    expect(modelShortLabel({ id: 'x', label: 'Plain' })).toBe('Plain');
  });
});
