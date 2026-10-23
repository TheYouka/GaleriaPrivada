// Fondo de ondas (docs/DESIGN.md §15.7 y §15.11): se anima sin movimiento reducido, es un único
// fotograma estático con `prefers-reduced-motion: reduce` (emulado), se pausa con la ventana
// minimizada y trabaja a media resolución.
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';

let launched: LaunchedApp;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar tema' }).click();
  await page.getByRole('menuitemradio', { name: 'Ondas' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ps3');
});

test.afterAll(async () => {
  await launched?.close();
});

const canvas = () => page.locator('canvas[data-waves]');

/** Dos capturas del canvas separadas `ms`. */
async function twoFrames(ms: number): Promise<[string, string]> {
  const a = await canvas().evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(ms);
  const b = await canvas().evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  return [a, b];
}

test('sin movimiento reducido, las ondas se animan a media resolución', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'false');
  await expect(canvas()).toHaveAttribute('data-animating', 'true');
  const [a, b] = await twoFrames(400);
  expect(a).not.toBe(b);
  const size = await canvas().evaluate((c) => {
    const el = c as HTMLCanvasElement;
    return { w: el.width, h: el.height, cw: el.clientWidth, ch: el.clientHeight };
  });
  expect(size.w).toBe(Math.round(size.cw / 2));
  expect(size.h).toBe(Math.round(size.ch / 2));
  // Canvas 2D (no WebGL).
  expect(await canvas().evaluate((c) => (c as HTMLCanvasElement).getContext('webgl'))).toBeNull();
});

test('con prefers-reduced-motion: reduce, las ondas son un fotograma estático', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(canvas()).toHaveAttribute('data-animating', 'false');
  const [a, b] = await twoFrames(500);
  expect(a).toBe(b);
  const [c, d] = await twoFrames(300);
  expect(c).toBe(a);
  expect(d).toBe(a);
});

test('vuelve a animarse al quitar el movimiento reducido', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(canvas()).toHaveAttribute('data-animating', 'true');
  const [a, b] = await twoFrames(400);
  expect(a).not.toBe(b);
});

test('con la ventana minimizada el fondo se pausa (sin bucle de fotogramas) y se reanuda', async () => {
  const host = page.locator('[data-background="waves"]');
  await expect(host).toHaveAttribute('data-paused', 'false');
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.minimize();
  });
  await expect(host).toHaveAttribute('data-paused', 'true');
  await expect(canvas()).toHaveAttribute('data-animating', 'false');
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.restore();
  });
  await expect(host).toHaveAttribute('data-paused', 'false');
  await expect(canvas()).toHaveAttribute('data-animating', 'true');
});
