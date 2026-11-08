import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const svg = await readFile('src/assets/app-icon.svg', 'utf8');
const small = (await readFile('src/assets/logo-small.svg', 'utf8')).replaceAll('currentColor', '#ededf0');
const smallTile = svg.replace(/<g[\s\S]*<\/g>/, `<g transform="translate(16 16) scale(.68)">${small.replace(/<svg[^>]*>|<\/svg>/g, '')}</g>`);
const browser = await chromium.launch({ headless: true });
const images = new Map();
const opticalImages = new Map();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await mkdir('desktop/icons', { recursive: true });
  await page.setViewportSize({ width: 1024, height: 1024 });
  for (const [theme, background, foreground] of [['light', '#ffffff', '#232326'], ['dark', '#19191c', '#ededf0']]) {
    const themed = svg.replace('fill="#19191c"', `fill="${background}"`).replaceAll('fill="#ededf0"', `fill="${foreground}"`);
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${themed}`);
    await page.screenshot({ path: `desktop/icon-${theme}.png`, omitBackground: true });
  }
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>${size <= 32 ? smallTile : svg}`);
    images.set(size, await page.screenshot({ omitBackground: true }));
    if (size <= 32) opticalImages.set(size, images.get(size));
    if (size === 64) {
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>${smallTile}`);
      opticalImages.set(size, await page.screenshot({ omitBackground: true }));
    }
  }
  await writeFile('desktop/icons/icon.png', images.get(1024));
  await writeFile('desktop/tray-color.png', images.get(32));
  const sizes = [16, 32, 48, 256];
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map(size => { const png = images.get(size), entry = Buffer.alloc(16); entry[0] = entry[1] = size === 256 ? 0 : size; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12); offset += png.length; return entry; });
  await writeFile('desktop/icons/icon.ico', Buffer.concat([header, ...entries, ...sizes.map(size => images.get(size))]));
  await page.setViewportSize({ width: 32, height: 32 });
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent;color:#000}svg{width:100%;height:100%;display:block}</style>${small.replaceAll('#ededf0', '#000000')}`);
  await page.screenshot({ path: 'desktop/tray.png', omitBackground: true });
} finally { await browser.close(); }
if (process.platform === 'darwin') {
  const iconset = 'desktop/icons/mandala.iconset'; await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(`${iconset}/icon_${size}x${size}.png`, images.get(size));
    await writeFile(`${iconset}/icon_${size}x${size}@2x.png`, (size <= 32 ? opticalImages : images).get(size * 2));
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', 'desktop/icons/icon.icns']); await rm(iconset, { recursive: true });
}
console.log('Generated C / Open monochrome desktop and tray icons; small sizes use the six outer ribbons.');
