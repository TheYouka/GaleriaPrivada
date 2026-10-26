// Modo de ventana discreto de los tests (docs/PLAN.md, nota 135): con GALERIA_E2E=1 las ventanas
// (la primera y la que crea el bloqueo) nacen fuera de la pantalla, sin activarse (isFocused() es
// false), visibles de verdad (visibilityState = 'visible') y sin quitar el foco al usuario.
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { launchApp, lockAndGetNewWindow, type LaunchedApp } from './helpers/launch';
import { launchUnlocked } from './helpers/library';

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched?.close();
});

async function windowInfo(app: ElectronApplication): Promise<{
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}> {
  return app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const win = wins.sort((a, b) => b.id - a.id)[0];
    if (!win) throw new Error('sin ventana');
    const b = win.getBounds();
    return {
      count: wins.length,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      focused: win.isFocused(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
    };
  });
}

test('la ventana nace fuera de la pantalla, visible y sin foco', async () => {
  const { page, app } = launched;
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const info = await windowInfo(app);
  expect(info.visible).toBe(true);
  expect(info.minimized).toBe(false);
  expect(info.focused).toBe(false);
  expect(info.x).toBeLessThanOrEqual(-30000);
  expect(info.y).toBeLessThanOrEqual(-30000);
  expect(info.width).toBe(1280);
  expect(info.height).toBe(800);
  // Visible de verdad para Chromium: las ondas, los vídeos y las capturas dependen de ello.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
});

test('la ventana nueva que crea el bloqueo también es discreta', async () => {
  await launched.close();
  launched = await launchUnlocked();
  const { page, app } = launched;
  const next = await lockAndGetNewWindow(app, () => page.keyboard.press('Control+L'));
  const info = await windowInfo(app);
  expect(info.count).toBe(1);
  expect(info.visible).toBe(true);
  expect(info.focused).toBe(false);
  expect(info.x).toBeLessThanOrEqual(-30000);
  expect(info.y).toBeLessThanOrEqual(-30000);
  expect(await next.evaluate(() => document.visibilityState)).toBe('visible');
});
