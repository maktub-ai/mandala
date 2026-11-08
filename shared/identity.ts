export const projectIcons = ["project", "folder", "code", "terminal", "gitBranch", "database", "server", "network", "book", "globe", "workflow", "layers", "blocks", "flask", "compass", "palette", "penTool", "briefcase", "rocket", "target", "shield", "headphones", "users", "star",
  "cloud", "cpu", "smartphone", "monitor", "chartColumn", "chartPie", "wallet", "receipt", "cart", "building", "mail", "messageCircle", "calendar", "clipboard", "lightbulb", "bug", "wrench", "zap", "heart", "flag", "gamepad", "camera", "mapPin", "graduation"] as const;
export type ProjectIcon = typeof projectIcons[number];
/** Agents and Projects choose from the same glyph set; the container (circle vs. bare) tells them apart. */
export const identityIcons = projectIcons;
export type IdentityIcon = ProjectIcon;
export type IdentityAppearance = { id: string; color?: string; avatarSeed?: string; icon?: IdentityIcon; emoji?: string };
/** Exactly one emoji grapheme (flags, ZWJ sequences and skin tones included); never text or markup. */
export function isIdentityEmoji(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 32) return false;
  if (!/^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f\u20e3#*0-9]+$/u.test(value)) return false;
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)) return false;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1;
}
export type IdentityKind = "agent" | "project";
const colors = ["#5386d4", "#ac67c7", "#399a83", "#c17b47", "#cf6686", "#738e45", "#5b9ab1"];

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

export function identityColor(identity: IdentityAppearance, kind: IdentityKind): string {
  return identity.color ?? colors[hash(kind + ":" + identity.id) % colors.length];
}

export function identityCells(seed: string): { x: number; y: number }[] {
  const value = hash(seed);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if ((value >>> (y * 3 + x)) & 1) {
      cells.push({ x, y });
      if (x !== 2) cells.push({ x: 4 - x, y });
    }
  }
  return cells.length ? cells : [{ x: 2, y: 2 }];
}
