import { describe, it, expect } from 'vitest';
import { presets, defaultPreferences, resolvePalette, parseThemePackage, exportThemePackage, themeTokens, contrastRatio, parsePreferences } from '../src/themes';

describe('theme contract', () => {
  it('has seven presets and distinct system selections', () => {
    expect(presets).toHaveLength(7);
    const p = defaultPreferences('light'); p.mode = 'system';
    expect(resolvePalette(p, true).variant).toBe('dark');
    expect(resolvePalette(p, false).variant).toBe('light');
  });
  it('uses the v2 cool-neutral identity without resetting saved theme choices', () => {
    const saved = defaultPreferences(); saved.mode = 'light';
    const light = themeTokens(resolvePalette(saved, false), saved.appearance);
    expect(light['--bg']).toBe('#f7f8fa');
    expect(light['--panel']).toBe('#f0f1f4');
    expect(light['--button']).toBe('#4f5ae6');
    expect(light['--brand-accent']).toBe('#1b1d22');
    saved.mode = 'dark';
    const dark = themeTokens(resolvePalette(saved, false), saved.appearance);
    expect(dark['--bg']).toBe('#121317');
    expect(dark['--panel']).toBe('#0e0f12');
    expect(dark['--surface']).toBe('#18191d');
    expect(dark['--button']).toBe('#7c86ff');
    expect(dark['--brand-accent']).toBe('#e4e6ea');
    for (const tokens of [light, dark]) {
      expect(contrastRatio(tokens['--brand-accent'], tokens['--bg'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--brand-accent'], tokens['--surface'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--focus'], tokens['--bg'])).toBeGreaterThanOrEqual(3);
    }
    expect(themeTokens(presets[2], { ...saved.appearance, radius: 0 })['--panel-radius']).toBe('0px');
    saved.light = 'github-light';
    const restored = parsePreferences(JSON.stringify(saved));
    expect(restored.light).toBe('github-light');
    expect(themeTokens(resolvePalette(restored, false, 'light'), restored.appearance)['--accent']).toBe('#0969da');
  });
  it('defaults new users to compact controls while preserving explicit appearance and background preferences', () => {
    const defaults = defaultPreferences();
    expect(defaults.appearance).toMatchObject({ uiFont:'geist', codeFont:'geist', fontSize:13, radius:8, density:'compact' });
    expect(defaults.mode).toBe('system');
    expect(defaultPreferences('dark').mode).toBe('dark');
    expect(defaultPreferences('light').mode).toBe('light');
    expect(themeTokens(presets[0],defaults.appearance)['--control-height']).toBe('32px');
    const saved = { ...defaults, mode:'system' as const, light:'personal-light', custom:[{ ...presets[2], id:'personal-light', name:'Personal theme' }],
      appearance:{ ...defaults.appearance, uiFont:'serif', codeFont:'monaco', fontSize:17, codeSize:16, radius:0, density:'comfortable' as const, contrast:80 },
      background:{ ...defaults.background, image:'data:image/png;base64,iVBORw0KGgo=', scope:'app' as const, blur:4, overlay:60 } };
    const restored = parsePreferences(JSON.stringify(saved));
    expect(restored).toEqual(saved);
    const tokens = themeTokens(resolvePalette(restored,false),restored.appearance);
    expect(tokens['--control-height']).toBe('36px');
    expect(tokens['--panel-radius']).toBe('0px');
    expect(tokens['--workspace-radius']).toBe('0px');
    expect(tokens['--theme-font-size']).toBe('17px');
    expect(tokens['--accent']).toBe('#0969da');
    expect(tokens['--panel']).toBe(presets[2].colors.surface);
  });
  it('retains contrast adjustment and readable secondary text on every built-in surface', () => {
    for (const palette of presets.slice(0,2)) {
      const appearance = defaultPreferences().appearance;
      const normal = themeTokens(palette,appearance);
      expect(themeTokens(palette,{...appearance,contrast:100})['--border']).not.toBe(normal['--border']);
      for(const contrast of [0,50,100]) {
        const tokens = themeTokens(palette,{...appearance,contrast});
        for(const surface of ['--bg','--surface','--panel','--raised']) {
          for(const text of ['--muted','--subtle','--success','--danger','--status-pending','--link']) {
            expect(contrastRatio(tokens[text],tokens[surface])).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });
  it('keeps chrome cool-neutral and reserves indigo for actions, focus and selection', () => {
    const hue = (hex: string) => { const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)); return { r, g, b, spread: Math.max(r,g,b)-Math.min(r,g,b) }; };
    for (const palette of presets.slice(0,2)) {
      const tokens=themeTokens(palette,defaultPreferences().appearance);
      for(const role of ['--bg','--panel','--surface','--raised','--text','--muted','--border']) {
        const { r, b, spread } = hue(tokens[role]);
        expect(spread).toBeLessThanOrEqual(16);
        expect(b).toBeGreaterThanOrEqual(r);
      }
      for(const role of ['--button','--focus','--accent']) {
        const { r, g, b } = hue(tokens[role]);
        expect(b).toBeGreaterThan(r); expect(b).toBeGreaterThan(g);
      }
      expect(contrastRatio(tokens['--button'],tokens['--button-text'])).toBeGreaterThanOrEqual(4.5);
      expect(tokens['--brand-accent']).toBe(tokens['--text']);
      expect(tokens['--success']).not.toBe(tokens['--text']);
    }
  });
  it('round trips a self contained image package', () => {
    const p = defaultPreferences();
    p.background.image = 'data:image/png;base64,iVBORw0KGgo=';
    const result = parseThemePackage(exportThemePackage(p, 'light'));
    expect(result.background).toEqual(p.background);
    expect(result.theme.colors).toEqual(presets[0].colors);
    result.theme.id = 'imported-copy';
    result.theme.name = 'Renamed custom copy';
    expect(themeTokens(result.theme, result.appearance)['--brand-accent']).toBe('#1b1d22');
  });
  it('rejects executable styles, external images and unsupported versions', () => {
    const original = JSON.parse(exportThemePackage(defaultPreferences(), 'light'));
    for (const patch of [{theme:{...original.theme,colors:{...original.theme.colors,brand:'red;display:none'}}},{version:2},{css:'body{display:none}'},{theme:{...original.theme,colors:{...original.theme.colors,accent:'red;display:none'}}},{background:{...original.background,image:'https://example.com/x.png'}},{background:{...original.background,image:'data:image/svg+xml;base64,PHN2Zz4='}}]) {
      expect(() => parseThemePackage(JSON.stringify({...original,...patch}))).toThrow();
    }
  });
  it('rejects invalid preference references and falls back safely', () => {
    expect(parsePreferences('{bad', 'dark')).toEqual(defaultPreferences('dark'));
    expect(parsePreferences(JSON.stringify({...defaultPreferences(),light:'missing'}))).toEqual(defaultPreferences());
  });
  it('ships readable presets and derives semantic tokens', () => {
    for(const palette of presets) {
      expect(contrastRatio(palette.colors.text, palette.colors.bg)).toBeGreaterThanOrEqual(7);
      const tokens = themeTokens(palette, defaultPreferences().appearance);
      expect(contrastRatio(tokens['--muted'], tokens['--bg'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--muted'], tokens['--surface'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--theme-code-keyword'], tokens['--surface'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--button-text'], tokens['--button'])).toBeGreaterThanOrEqual(4.5);
    }
  });
});
