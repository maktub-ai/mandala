import { devicePreferences } from './devicePreferences';
import type { Message } from './i18n';
import type { IconName } from './ui/Icon';

export const sidebarItems: { id: string; label: Message; icon: IconName; href: string; defaultPinned?: boolean }[] = [
  { id: 'tasks', label: '任务', icon: 'plan', href: '/tasks', defaultPinned: true },
  { id: 'projects', label: '项目', icon: 'project', href: '/projects', defaultPinned: true },
  { id: 'agents', label: '智能体', icon: 'agent', href: '/agents', defaultPinned: true },
  { id: 'market', label: '市场', icon: 'market', href: '/market' },
  { id: 'library', label: '资料库', icon: 'book', href: '/library' },
  { id: 'memory', label: '记忆', icon: 'memory', href: '/mana?tab=memory' },
  { id: 'schedules', label: '自动化', icon: 'schedule', href: '/schedules' },
  { id: 'usage', label: '用量', icon: 'usage', href: '/usage' },
  { id: 'settings', label: '设置', icon: 'settings', href: '/settings/general' },
];
export type ModulePins = Record<string, boolean>;
export const modulePinsKey = 'mana-sidebar-modules';
export const moduleOrderKey = 'mana-sidebar-module-order';
export function readModulePins(): ModulePins {
  try {
    const saved: unknown = JSON.parse(devicePreferences.getItem(modulePinsKey) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved)
      ? Object.fromEntries(Object.entries(saved).map(([id, value]) => [id === 'assets' ? 'library' : id, value]).filter(([, value]) => typeof value === 'boolean')) : {};
  } catch { return {}; }
}
const normalizeOrder = (value: unknown) => [...new Set([...(Array.isArray(value) ? value.map(id => id === 'assets' ? 'library' : id).filter(id => sidebarItems.some(item => item.id === id)) : []), ...sidebarItems.map(item => item.id)])] as string[];
export function readModuleOrder(): string[] {
  try { return normalizeOrder(JSON.parse(devicePreferences.getItem(moduleOrderKey) ?? '[]')); }
  catch { return normalizeOrder([]); }
}
export function orderedSidebarItems(order: string[]) {
  return normalizeOrder(order).map(id => sidebarItems.find(item => item.id === id)!);
}
export function moveSidebarItem(order: string[], id: string, offset: number) {
  const index = order.indexOf(id), target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order]; next.splice(index,1); next.splice(target,0,id); return next;
}
export function modulePinned(module: typeof sidebarItems[number], pins: ModulePins) {
  return pins[module.id] ?? module.defaultPinned ?? false;
}
