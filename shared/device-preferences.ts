// Device UI choices and bounded manual command checkpoints only. Credentials and request bodies stay outside this store.
export const devicePreferenceKeys = [
  'mandala-schedule-command-checkpoints','mana-language','mana-sidebar-layout','mana-sidebar-modules','mana-sidebar-module-order',
  'mana-progress-view','mana-team-view-v2','mana-chat-preferences','mana-chat','mana-project',
  'mana-project-agents','mana-view','mana-sort','mana-content-width','mana-market-sources','mana-command-history',
  'mana-sidebar-more', 'mandala-pet', // Retained for preference files written by older desktop versions.
] as const;
export type DevicePreferenceKey = typeof devicePreferenceKeys[number];
export type DevicePreferenceValues = Partial<Record<DevicePreferenceKey,string>>;
export const isDevicePreferenceKey = (key: unknown): key is DevicePreferenceKey => typeof key === 'string' && (devicePreferenceKeys as readonly string[]).includes(key);
