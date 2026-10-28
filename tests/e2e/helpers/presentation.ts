// Ayudantes de los E2E de la presentación (docs/PLAN.md 4.6 y 4.7; docs/DESIGN.md §17, §23.2):
// medios sintéticos (fotos con sharp, un vídeo con audio y un tono con el ffmpeg empaquetado, todo
// bajo tests/.tmp/), el doble de la pantalla completa (la real traería la ventana discreta, nota 135,
// delante del usuario: se sustituyen setFullScreen e isFullScreen como en player.spec.ts), la lectura
// del estado de audio y de capas que expone el renderer solo en pruebas (`__galeriaPresentation`) y
// los motivos de pausa del auto-bloqueo de main.
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  importAndSummarize,
  importMusic,
  launchUnlocked,
  newSourceDir,
  writeLongVideo,
  writePhoto,
  writeTone,
  type ImportedTrack,
} from './library';
import type { LaunchedApp } from './launch';
import { clickSelect, invokeIpc } from './playlists';

/** Estado que expone el renderer solo en pruebas (presentation-runtime.ts, `testState`). */
export interface PresentationState {
  phase: string;
  slideIndex: number | null;
  total: number;
  paused: boolean;
  finished: boolean;
  slideKind: 'photo' | 'video' | null;
  audio: 'webaudio' | 'direct';
  audioContext: string;
  audioMode: 'video' | 'music' | 'both' | 'mute';
  musicEnabled: boolean;
  musicVolume: number;
  videoVolume: number;
  musicFadeMs: number;
  transitionSetting: string;
  transitionMs: number;
  slideMs: number;
  loop: boolean;
  animations: boolean;
  plan: { music: 'sound' | 'silent'; videoAudio: 'sound' | 'silent' } | null;
  musicTarget: number | null;
  videoTarget: number | null;
  musicGain: number | null;
  videoGains: (number | null)[];
  trackId: string | null;
  musicPaused: boolean;
  musicTime: number;
  videoPlaying: boolean[];
  transition: { type: string; durationMs: number } | null;
  layers: { index: number; role: string; ready: boolean; slot: number | null }[];
  fullscreen: boolean;
}

export const PHOTO_NAMES = ['Foto A', 'Foto B', 'Foto C'] as const;
export const VIDEO_NAME = 'Video corto';
/** Orden de la galería (captura descendente): Foto C, Video, Foto B, Foto A. */
export const GALLERY_ORDER = ['Foto C', VIDEO_NAME, 'Foto B', 'Foto A'] as const;
/** Duración del vídeo de prueba (s): da tiempo a comprobar las ganancias sin que acabe. */
export const VIDEO_SECONDS = 12;

export interface PresentationFixture {
  launched: LaunchedApp;
  page: Page;
  app: ElectronApplication;
  src: string;
  track: ImportedTrack;
  track2: ImportedTrack;
}

/**
 * Perfil desbloqueado con 3 fotos y 1 vídeo con audio importados y dos pistas de música (tonos),
 * y el doble de la pantalla completa instalado.
 */
export async function launchWithMedia(
  size = { width: 1280, height: 800 },
  extraEnv?: Record<string, string>,
): Promise<PresentationFixture> {
  const launched = await launchUnlocked(extraEnv ? { env: extraEnv } : {}, size);
  const { page, app } = launched;
  const src = newSourceDir();
  const paths: string[] = [];
  const dates = [new Date(2025, 5, 1, 12), new Date(2025, 5, 2, 12), new Date(2025, 5, 4, 12)];
  for (const [i, name] of PHOTO_NAMES.entries()) {
    const path = join(src, `${name}.jpg`);
    await writePhoto(path, i + 11, {
      width: 640,
      height: 400,
      mtime: dates[i] ?? new Date(2025, 5, 1),
    });
    paths.push(path);
  }
  const video = join(src, `${VIDEO_NAME}.mp4`);
  writeLongVideo(video, VIDEO_SECONDS);
  utimesSync(video, new Date(2025, 5, 3, 12), new Date(2025, 5, 3, 12));
  paths.push(video);
  const counts = await importAndSummarize(page, app, paths, 'files', 120_000);
  expect(counts.imported).toBe(4);
  await expect(page.getByText('4 elementos', { exact: true })).toBeVisible();
  const tone = join(src, 'Tono uno.wav');
  const tone2 = join(src, 'Tono dos.wav');
  writeTone(tone, 40);
  writeTone(tone2, 40);
  const music = await importMusic(app, page, [tone, tone2]);
  expect(music.failed).toEqual([]);
  expect(music.imported).toHaveLength(2);
  const [track, track2] = music.imported as [ImportedTrack, ImportedTrack];
  await installFullscreenDouble(app);
  return { launched, page, app, src, track, track2 };
}

/** Pantalla completa simulada (nota 157): guarda las llamadas y emite enter/leave-full-screen. */
export async function installFullscreenDouble(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    let on = false;
    const calls: boolean[] = [];
    (globalThis as unknown as { __fullscreenCalls: boolean[] }).__fullscreenCalls = calls;
    win.isFullScreen = () => on;
    win.setFullScreen = (value: boolean) => {
      calls.push(value);
      on = value;
      win.emit(value ? 'enter-full-screen' : 'leave-full-screen');
    };
  });
}

export function fullscreenCalls(app: ElectronApplication): Promise<boolean[]> {
  return app.evaluate(() =>
    (globalThis as unknown as { __fullscreenCalls: boolean[] }).__fullscreenCalls.slice(),
  );
}

export function autoLockReasons(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __galeriaAutoLockReasons: string[] }).__galeriaAutoLockReasons,
  );
}

export function displayBlocked(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __galeriaDisplaySleepBlocked: boolean })
        .__galeriaDisplaySleepBlocked,
  );
}

/** El estado de la presentación en curso (null si no hay ninguna). */
export function presState(page: Page): Promise<PresentationState | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __galeriaPresentation?: PresentationState }).__galeriaPresentation ??
      null,
  );
}

export async function waitState(
  page: Page,
  predicate: (s: PresentationState) => boolean,
  description: string,
  timeout = 30_000,
): Promise<PresentationState> {
  let last: PresentationState | null = null;
  try {
    await expect
      .poll(
        async () => {
          last = await presState(page);
          return last !== null && predicate(last);
        },
        { message: `esperando: ${description}`, timeout, intervals: [50, 100, 100, 200] },
      )
      .toBe(true);
  } catch (error) {
    // Deja en el fallo lo último que vio el renderer (sin datos de la bóveda).
    console.log(`[e2e] sin cumplirse «${description}»; último estado: ${JSON.stringify(last)}`);
    throw error;
  }
  return last as unknown as PresentationState;
}

export const setupDialog = (page: Page): Locator => page.locator('[data-presentation-setup]');
export const presentation = (page: Page): Locator => page.locator('[data-presentation]');
export const controlsBar = (page: Page): Locator => page.locator('[data-presentation-controls]');

/** Selecciona estos índices de la galería y abre el diálogo de inicio con «Presentación». */
export async function openSetupFromSelection(page: Page, indexes: number[]): Promise<void> {
  // Una selección anterior (la presentación no la borra) se descarta antes.
  const cancel = page
    .getByRole('region', { name: 'Selección' })
    .getByRole('button', { name: 'Cancelar selección' });
  if (await cancel.isVisible()) await cancel.click();
  await clickSelect(page, indexes);
  await page
    .getByRole('region', { name: 'Selección' })
    .getByRole('button', { name: 'Presentación' })
    .click();
  await expect(setupDialog(page)).toBeVisible();
}

export async function startPresentation(page: Page): Promise<void> {
  await setupDialog(page).getByRole('button', { name: 'Iniciar presentación' }).click();
  await expect(presentation(page)).toBeVisible();
  await expect(setupDialog(page)).toBeHidden();
}

/** Ajustes predeterminados de la presentación (por IPC) sobre los valores de fábrica. */
export async function saveDefaults(
  page: Page,
  patch: Record<string, unknown>,
  trackIds: string[] = [],
): Promise<void> {
  const cfg = await invokeIpc<{ settings: Record<string, unknown> }>(
    page,
    'presentation:getConfig',
    {},
  );
  await invokeIpc(page, 'presentation:saveDefaults', {
    settings: { ...cfg.settings, ...patch, trackIds },
  });
}

/** Cierra la presentación con Esc y espera a que desaparezca. */
export async function exitPresentation(page: Page): Promise<void> {
  if ((await presentation(page).count()) === 0) return;
  await page.keyboard.press('Escape');
  await expect(presentation(page)).toHaveCount(0);
}
