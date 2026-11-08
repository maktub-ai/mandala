// Render approved vector artwork; no image generation or resampling of the reference PNG.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const destination = 'docs/design/brand/assets';
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const name of ['logo-on-light', 'logo-on-dark', 'logo-black', 'logo-white', 'logo-small']) {
    const svg = await readFile(`src/assets/${name}.svg`, 'utf8');
    await writeFile(`${destination}/${name}.svg`, svg);
    for (const size of name === 'logo-small' ? [16, 24, 32, 48, 64] : [64, 128, 256, 512, 1024]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent;color:#000}svg{display:block;width:100%;height:100%}</style>${svg}`);
      await page.screenshot({ path: `${destination}/${name}-${size}.png`, omitBackground: true });
    }
  }
} finally { await browser.close(); }
console.log(`Exported transparent logo assets to ${destination}`);
