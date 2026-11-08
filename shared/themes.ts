export type Variant = 'light' | 'dark';
export type ThemeMode = Variant | 'system';
export type Palette = { id: string; name: string; variant: Variant; colors: { bg: string; surface: string; text: string; accent: string; success: string; danger: string; keyword: string; string: string; brand?: string } };
export type Appearance = { uiFont: string; codeFont: string; fontSize: number; codeSize: number; radius: number; density: 'comfortable' | 'compact'; contrast: number };
export type Background = { image: string; scope: 'app' | 'chat'; position: 'center' | 'top' | 'bottom'; size: 'cover' | 'contain'; zoom: number; blur: number; overlay: number };
export type ThemePreferences = { version: 1; mode: ThemeMode; light: string; dark: string; custom: Palette[]; appearance: Appearance; background: Background };
export const themeStorageKey = 'mandala-appearance-v1';
export const maxImageBytes = 2 * 1024 * 1024;
export const maxPackageBytes = 4 * 1024 * 1024;
const palette = (id: string, name: string, variant: Variant, colors: string[]): Palette => ({ id, name, variant, colors: Object.fromEntries(['bg','surface','text','accent','success','danger','keyword','string','brand'].slice(0,colors.length).map((key,i) => [key,colors[i]])) as Palette['colors'] });
export const presets: Palette[] = [
  palette('mandala-light','Mandala Light','light',['#f7f8fa','#ffffff','#1b1d22','#4f5ae6','#168a4e','#cf3a3a','#5b4fc4','#28634a','#1b1d22']),
  palette('mandala-dark','Mandala Dark','dark',['#121317','#18191d','#e4e6ea','#7c86ff','#4ccb85','#f07575','#b3a9f5','#9cc5ae','#e4e6ea']),
  palette('github-light','GitHub Light','light',['#ffffff','#f6f8fa','#1f2328','#0969da','#1a7f37','#cf222e','#cf222e','#0a3069']),
  palette('github-dark','GitHub Dark','dark',['#0d1117','#161b22','#e6edf3','#58a6ff','#3fb950','#f85149','#ff7b72','#a5d6ff']),
  palette('catppuccin-latte','Catppuccin Latte','light',['#eff1f5','#e6e9ef','#4c4f69','#8839ef','#40a02b','#d20f39','#8839ef','#286b1e']),
  palette('catppuccin-mocha','Catppuccin Mocha','dark',['#1e1e2e','#181825','#cdd6f4','#cba6f7','#a6e3a1','#f38ba8','#cba6f7','#a6e3a1']),
  palette('nord-dark','Nord Dark','dark',['#2e3440','#3b4252','#eceff4','#88c0d0','#a3be8c','#bf616a','#b48ead','#a3be8c']),
];
// New installations follow the system appearance; an explicit legacy light/dark choice is kept.
export function defaultPreferences(legacy?: string): ThemePreferences {
  return { version: 1, mode: legacy === 'dark' ? 'dark' : legacy === 'light' ? 'light' : 'system', light: 'mandala-light', dark: 'mandala-dark', custom: [], appearance: { uiFont: 'geist', codeFont: 'geist', fontSize: 13, codeSize: 13, radius: 8, density: 'compact', contrast: 50 }, background: { image: '', scope: 'chat', position: 'center', size: 'cover', zoom: 100, blur: 0, overlay: 75 } };
}
export const allPalettes = (p: ThemePreferences) => [...presets, ...p.custom];
export function resolvePalette(p: ThemePreferences, systemDark: boolean, variant?: Variant): Palette {
  const mode = variant ?? (p.mode === 'system' ? systemDark ? 'dark' : 'light' : p.mode);
  return allPalettes(p).find(item => item.id === p[mode] && item.variant === mode) ?? presets[mode === 'light' ? 0 : 1];
}
const rgb = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
export function mix(a: string, b: string, weight: number): string {
  const other = rgb(b); return '#' + rgb(a).map((v,i) => Math.round(v*(1-weight)+other[i]*weight).toString(16).padStart(2,'0')).join('');
}
export function contrastRatio(a: string, b: string): number {
  const luminance = (color: string) => rgb(color).map(v => { const n=v/255; return n<=.04045?n/12.92:((n+.055)/1.055)**2.4; }).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
export const uiFonts: Record<string,string> = { geist: "'Geist', 'PingFang SC', 'Noto Sans SC', sans-serif", system: "'Inter Variable', 'PingFang SC', 'Noto Sans SC', sans-serif", serif: "'EB Garamond', 'Songti SC', serif", rounded: "ui-rounded, 'PingFang SC', sans-serif" };
export const codeFonts: Record<string,string> = { geist: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", system: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', menlo: 'Menlo, Consolas, monospace', monaco: 'Monaco, Consolas, monospace' };
// Only the built-in Mandala palettes use authored chrome; imported palettes retain derived surfaces.
const mandalaChrome: Record<string,{panel:string;raised:string;muted:string;border:string;soft:string;strong:string;selected:string;focus:string;pending:string}> = {
  'mandala-light': {panel:'#f0f1f4',raised:'#eceef2',muted:'#5d616a',border:'#d9dce2',soft:'#e7e9ed',strong:'#9a9ea7',selected:'#ebedfb',focus:'#5a64ea',pending:'#a0650b'},
  'mandala-dark': {panel:'#0e0f12',raised:'#1f2126',muted:'#989ca5',border:'#2e3138',soft:'#23252b',strong:'#4d515a',selected:'#1f2240',focus:'#8a94ff',pending:'#e2ac4c'},
};
export function themeTokens(p: Palette, a: Appearance): Record<string,string> {
  const c=p.colors, chrome=mandalaChrome[p.id], panel=chrome?.panel??c.surface, raised=chrome?.raised??mix(c.surface,c.text,.08);
  const surfaces=[c.bg,c.surface,panel,raised];
  const readable = (color: string) => { let result=color; for(let i=0;i<=20&&surfaces.some(surface=>contrastRatio(result,surface)<4.5);i++) result=mix(color,c.text,i/20); return result; };
  const adjusted = (color:string) => mix(color,a.contrast>=50?c.text:c.bg,Math.abs(a.contrast-50)*.004);
  const brandAccent = c.brand ?? c.accent;
  const muted=readable(chrome?adjusted(chrome.muted):mix(c.text,c.bg,.28 - a.contrast*.0015));
  return { '--bg':c.bg,'--surface':c.surface,'--panel':panel,'--raised':raised,'--text':c.text,'--heading':c.text,'--muted':muted,'--subtle':muted,
    '--border':chrome?adjusted(chrome.border):mix(c.bg,c.text,.22 + a.contrast*.002),'--border-soft':chrome?.soft??mix(c.bg,c.text,.12),'--border-strong':chrome?.strong??mix(c.bg,c.text,.5),'--accent':c.accent,'--accent-bg':chrome?.selected??mix(c.bg,c.accent,.12),
    '--brand-accent':readable(brandAccent),'--brand-on-accent':contrastRatio(readable(brandAccent),'#ffffff')>contrastRatio(readable(brandAccent),'#000000')?'#ffffff':'#000000',
    '--button':c.accent,'--button-text':contrastRatio(c.accent,'#ffffff')>contrastRatio(c.accent,'#000000')?'#ffffff':'#000000','--focus':readable(chrome?.focus??brandAccent),'--link':readable(c.accent),'--secondary':raised,
    '--success':readable(c.success),'--danger':readable(c.danger),'--warning':readable(chrome?.pending??(p.variant==='dark'?'#e4b565':'#8a5817')),'--status-active':readable(c.success),'--status-running':readable(p.variant==='dark'?'#91baff':'#285ca7'),'--status-pending':readable(chrome?.pending??(p.variant==='dark'?'#e4b565':'#8a5817')),
    '--terminal-selection':mix(c.surface,c.accent,.3),'--theme-code-keyword':readable(c.keyword),'--theme-code-string':readable(c.string),'--theme-code-number':readable(p.variant==='dark'?'#edbd8c':'#955320'),
    '--font-ui':uiFonts[a.uiFont],'--font-mono':codeFonts[a.codeFont],'--theme-font-size':a.fontSize+'px','--code-font-size':a.codeSize+'px',
    '--control-font-size':a.fontSize+'px','--input-font-size':a.fontSize+'px','--nav-font-size':a.fontSize+'px','--workspace-radius':(a.radius===0?0:Math.max(12,a.radius))+'px','--control-radius':a.radius+'px','--panel-radius':a.radius+'px','--dialog-radius':Math.max(8,a.radius)+'px','--pill-radius':a.radius+'px',
    '--nav-height':a.density==='compact'?'32px':'36px','--control-height':a.density==='compact'?'32px':'36px','--card-padding':a.density==='compact'?'16px':'24px','--page-gutter':a.density==='compact'?'20px':'24px',
  };
}
function object(value: unknown, keys: string[]): Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) throw Error('Invalid theme fields');
  return value as Record<string,unknown>;
}
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (!values.includes(v as T)) throw Error('Invalid theme option'); return v as T; }
function number(v: unknown,min: number,max: number): number { if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('Invalid theme value');return v; }
function text(v: unknown,max=80): string { if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid theme name');return v.trim(); }
function parsePalette(value: unknown): Palette {
  const p=object(value,['id','name','variant','colors']), colors=object(p.colors,['bg','surface','text','accent','success','danger','keyword','string','brand']);
  for(const key of ['bg','surface','text','accent','success','danger','keyword','string']) if(typeof colors[key]!=='string'||!/^#[0-9a-fA-F]{6}$/.test(colors[key] as string))throw Error('Invalid theme color');
  if (colors.brand !== undefined && (typeof colors.brand !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(colors.brand))) throw Error('Invalid brand color');
  return {id:text(p.id),name:text(p.name),variant:choice(p.variant,['light','dark']),colors:colors as Palette['colors']};
}
function parseAppearance(value: unknown): Appearance {
  const a=object(value,['uiFont','codeFont','fontSize','codeSize','radius','density','contrast']);
  return {uiFont:choice(a.uiFont,Object.keys(uiFonts)),codeFont:choice(a.codeFont,Object.keys(codeFonts)),fontSize:number(a.fontSize,12,18),codeSize:number(a.codeSize,11,20),radius:number(a.radius,0,16),density:choice(a.density,['comfortable','compact']),contrast:number(a.contrast,0,100)};
}
export function parseBackground(value: unknown): Background {
  const b=object(value,['image','scope','position','size','zoom','blur','overlay']);
  if(typeof b.image!=='string' || b.image.length>Math.ceil(maxImageBytes/3)*4+40 || (b.image!==''&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(b.image)))throw Error('Invalid background image');
  return {image:b.image,scope:choice(b.scope,['app','chat']),position:choice(b.position,['center','top','bottom']),size:choice(b.size,['cover','contain']),zoom:number(b.zoom,100,200),blur:number(b.blur,0,24),overlay:number(b.overlay,0,95)};
}
export function parsePreferences(raw: string|null,legacy?: string): ThemePreferences {
  try {
    const p=object(JSON.parse(raw??''),['version','mode','light','dark','custom','appearance','background']);
    if(p.version!==1||!Array.isArray(p.custom)||p.custom.length>20)throw Error('Invalid preferences');
    const custom=p.custom.map(parsePalette), ids=[...presets,...custom].map(item=>item.id);
    if(new Set(ids).size!==ids.length)throw Error('Duplicate theme');
    for(const variant of ['light','dark'] as const) if(![...presets,...custom].some(item=>item.id===p[variant]&&item.variant===variant))throw Error('Missing theme');
    return {version:1,mode:choice(p.mode,['light','dark','system']),light:p.light as string,dark:p.dark as string,custom,appearance:parseAppearance(p.appearance),background:parseBackground(p.background)};
  } catch { return defaultPreferences(legacy); }
}
export function exportThemePackage(p: ThemePreferences, variant: Variant): string {
  return JSON.stringify({format:'mandala-theme',version:1,theme:resolvePalette(p,false,variant),appearance:p.appearance,background:p.background},null,2);
}
export function parseThemePackage(raw: string): {theme:Palette;appearance:Appearance;background:Background} {
  if(raw.length>maxPackageBytes)throw Error('Theme package too large');
  const p=object(JSON.parse(raw),['format','version','theme','appearance','background']);
  if(p.format!=='mandala-theme'||p.version!==1)throw Error('Unsupported theme format');
  return {theme:parsePalette(p.theme),appearance:parseAppearance(p.appearance),background:parseBackground(p.background)};
}
