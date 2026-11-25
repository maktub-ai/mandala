import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin' || !process.argv[2]) throw Error('Usage on macOS: node scripts/desktop-pet-smoke.mjs /path/to/Mandala.app');
const executablePath = join(resolve(process.argv[2]), 'Contents/MacOS/Mandala');
const home = await mkdtemp(join(tmpdir(), 'mandala-pet-smoke-'));
const application = await electron.launch({ executablePath, env: { ...process.env, MANDALA_HOME: home, OPEN_MANA_HOME: home, MANDALA_ACCOUNT_ORIGIN: 'http://127.0.0.1:1' } });
try {
  const main = await application.firstWindow();
  await main.waitForURL('http://127.0.0.1:**');
  const mainWindow = await application.browserWindow(main);
  const visible = () => mainWindow.evaluate(w => w.isVisible());
  const focused = () => mainWindow.evaluate(w => w.isFocused());
  const dockVisible = () => application.evaluate(({ app }) => app.dock.isVisible());
  const locked = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }).includes('"CGSSessionScreenIsLocked"=Yes');
  await expect.poll(visible).toBe(true);
  if (!locked) await expect.poll(focused).toBe(true);

  const petPage = application.waitForEvent('window');
  await main.evaluate(() => window.mandalaDesktop.pet.show());
  const pet = await petPage;
  await pet.waitForURL('**/pet');
  const petWindow = await application.browserWindow(pet);
  await expect.poll(() => petWindow.evaluate(w => w.isVisible() && w.isVisibleOnAllWorkspaces() && w.isAlwaysOnTop())).toBe(true);
  await expect.poll(dockVisible).toBe(true);
  if (!locked) await expect.poll(focused).toBe(true);

  for (const source of ['activate', 'pet']) {
    await mainWindow.evaluate(w => w.close());
    await expect.poll(visible).toBe(false);
    await expect.poll(dockVisible).toBe(true);
    if (source === 'activate') await application.evaluate(({ app }) => { app.emit('activate', {}, true); });
    else await pet.evaluate(() => window.mandalaDesktop.pet.open('/mandala'));
    await expect.poll(visible).toBe(true);
    if (!locked) await expect.poll(focused).toBe(true);
  }
  await main.evaluate(() => window.mandalaDesktop.pet.hide());
  await expect.poll(() => application.windows().length).toBe(1);
  await expect.poll(dockVisible).toBe(true);
  console.log(JSON.stringify({ dockVisibleThroughout: true, reopenedFromDockEventAndPet: true, focusVerified: !locked, screenLocked: locked }));
} finally {
  try {
    await Promise.all([
      application.waitForEvent('close', { timeout: 15000 }),
      application.evaluate(({ dialog, Menu }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
        Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Stop runtime and quit…').click();
      }),
    ]);
  } finally { await application.close(); }
}
