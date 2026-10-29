// Ayudantes de los E2E de la pantalla de vídeo dual y la fusión por la interfaz (docs/PLAN.md 5.4 y
// 5.5; docs/DESIGN.md §18.1). Los vídeos de prueba son cortos y de baja resolución, generados con el
// ffmpeg empaquetado (testsrc2 + sine) y solo existen en tests/.tmp/.
import { join } from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { importAndSummarize, writePhoto } from './library';
import { writeMergeInputs } from './merge';

export const LEFT_NAME = 'Largo izquierdo';
export const RIGHT_NAME = 'Corto derecho';
export const PHOTO_NAME = 'Foto suelta';
export const LEFT_SECONDS = 20;
export const RIGHT_SECONDS = 12;

/** Dos vídeos (20 s a 320×180 y 12 s a 240×180) y una foto, importados. Devuelve la carpeta de origen. */
export async function importDualFixtures(
  page: Page,
  app: ElectronApplication,
  dir: string,
  options: { photo?: boolean } = {},
): Promise<void> {
  const { left, right } = writeMergeInputs(dir, {
    left: { name: LEFT_NAME, seconds: LEFT_SECONDS },
    right: { name: RIGHT_NAME, seconds: RIGHT_SECONDS },
  });
  const paths = [left, right];
  if (options.photo) {
    const photo = join(dir, `${PHOTO_NAME}.jpg`);
    await writePhoto(photo, 9, { width: 320, height: 200 });
    paths.push(photo);
  }
  const counts = await importAndSummarize(page, app, paths, 'files', 180_000);
  expect(counts.imported).toBe(paths.length);
}

export function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Navegación principal' });
}

export function dualScreen(page: Page): Locator {
  return page.locator('[data-dual-screen]');
}

/** Navegación → Vídeo dual. */
export async function openDualFromNav(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'Vídeo dual', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Vídeo dual' })).toBeVisible();
}

/** «Elegir vídeo…» de un lado → el vídeo con ese nombre en el selector. */
export async function pickVideo(page: Page, side: 'left' | 'right', name: string): Promise<void> {
  await page
    .locator(`[data-dual-side="${side}"]`)
    .getByRole('button', { name: 'Elegir vídeo…' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Elegir vídeo' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(dialog).toBeHidden();
}

export interface VideoSnap {
  t: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  rate: number;
  readyState: number;
}

export interface DualSnap {
  left: VideoSnap | null;
  right: VideoSnap | null;
}

/** Estado de los dos <video> leídos en el mismo turno de JavaScript (la deriva no incluye ruido de lectura). */
export async function snapVideos(page: Page): Promise<DualSnap> {
  return page.evaluate(() => {
    const read = (side: string): VideoSnap | null => {
      const v = document.querySelector<HTMLVideoElement>(`video[data-dual-video="${side}"]`);
      return v
        ? {
            t: v.currentTime,
            duration: v.duration,
            paused: v.paused,
            ended: v.ended,
            muted: v.muted,
            volume: v.volume,
            rate: v.playbackRate,
            readyState: v.readyState,
          }
        : null;
    };
    return { left: read('left'), right: read('right') };
  });
}

/** Los dos vídeos tienen metadatos y un primer fotograma. */
export async function waitVideosReady(page: Page): Promise<void> {
  await expect(page.locator('[data-dual-side="left"]')).toHaveAttribute('data-ready', 'true', {
    timeout: 60_000,
  });
  await expect(page.locator('[data-dual-side="right"]')).toHaveAttribute('data-ready', 'true', {
    timeout: 60_000,
  });
  await expect
    .poll(async () => {
      const s = await snapVideos(page);
      return (
        s.left !== null &&
        s.right !== null &&
        Number.isFinite(s.left.duration) &&
        Number.isFinite(s.right.duration)
      );
    })
    .toBe(true);
}

/** Barra de controles: la sincronizada o la de un lado. */
export function controls(page: Page, scope: 'sync' | 'left' | 'right' = 'sync'): Locator {
  return page.locator(`[data-dual-controls="${scope}"]`);
}

/** Motivos de pausa del auto-bloqueo (gancho de E2E de la nota 156). */
export async function autoLockReasons(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __galeriaAutoLockReasons: string[] }).__galeriaAutoLockReasons,
  );
}

export async function displaySleepBlocked(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __galeriaDisplaySleepBlocked: boolean })
        .__galeriaDisplaySleepBlocked,
  );
}
