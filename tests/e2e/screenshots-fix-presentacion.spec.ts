// Verificación visual del arreglo de las animaciones de la presentación (docs/PLAN.md notas 190 y
// 191), en los dos temas y con `prefers-reduced-motion: reduce` emulado (la elección del usuario se
// respeta): mitad de un fundido, mitad de un deslizamiento, Ken Burns al empezar y 4 s después, y el
// diálogo de inicio con el aviso. Capturas en tests/.tmp/screenshots/fix-presentacion/; se revisan a
// mano. Ventana discreta (nota 135), pantalla completa simulada, fotos sintéticas bajo tests/.tmp/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT, unlockProfile } from './helpers/launch';
import {
  expectItemCount,
  importAndSummarize,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
} from './helpers/library';
import { imagesLoaded } from './helpers/playlists';
import {
  exitPresentation,
  installFullscreenDouble,
  openSetupFromSelection,
  presentation,
  saveDefaults,
  setupDialog,
  startPresentation,
  waitState,
} from './helpers/presentation';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fix-presentacion');

const BASE = {
  transition: 'fade',
  randomPool: ['fade', 'slide', 'zoom', 'kenburns'],
  transitionMs: 3000,
  slideMs: 1000,
  loop: true,
  animations: true,
  startFullscreen: false,
  audioMode: 'video',
  musicEnabled: false,
  musicVolume: 0.7,
  videoVolume: 1,
  musicFadeMs: 300,
};

async function snap(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, name) });
}

/** Espera a que la diapositiva 1 esté entrando con `ok(opacidad, desplazamiento X, ancho)`. */
async function waitMidTransition(page: Page, kind: 'opacity' | 'translate'): Promise<void> {
  await page.waitForFunction(
    (k) => {
      const layer = document.querySelector<HTMLElement>(
        '[data-slide-layer="1"][data-slide-role="entering"]',
      );
      if (!layer) return false;
      const cs = getComputedStyle(layer);
      if (k === 'opacity') return Number(cs.opacity) > 0.4 && Number(cs.opacity) < 0.6;
      const tx = Math.abs(new DOMMatrix(cs.transform).m41);
      return tx > 0.35 * innerWidth && tx < 0.65 * innerWidth;
    },
    kind,
    { timeout: 30_000, polling: 'raf' },
  );
  // Espacio congela las animaciones en curso (§17.4): la captura es del instante elegido.
  await page.keyboard.press('Space');
  await expect(presentation(page)).toHaveAttribute('data-paused', 'true');
}

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas del movimiento de la presentación en el tema ${displayName}`, async () => {
    test.setTimeout(400_000);
    mkdirSync(OUT, { recursive: true });
    const launched = await launchApp();
    const src = newSourceDir();
    try {
      const { page, app } = launched;
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
      });
      await createProfile(page, PROFILE, PASSWORD);
      await choosePickerTheme(page, displayName);
      await expect(page.locator('html')).toHaveAttribute('data-theme', id);
      await unlockProfile(page, PROFILE, PASSWORD);
      await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();

      const paths: string[] = [];
      for (const [i, seed] of [5, 12, 20].entries()) {
        const path = join(src, `Foto ${i + 1}.jpg`);
        await writePhoto(path, seed, { width: 960, height: 600, mtime: new Date(2025, 5, 3 + i) });
        paths.push(path);
      }
      expect((await importAndSummarize(page, app, paths, 'files', 120_000)).imported).toBe(3);
      await expectItemCount(page, 3);
      await imagesLoaded(page.getByRole('grid', { name: 'Galería' }));
      await installFullscreenDouble(app);
      // El sistema pide reducir el movimiento: la elección del usuario manda.
      await page.emulateMedia({ reducedMotion: 'reduce' });

      // Aviso informativo en el diálogo de inicio (no desactiva nada).
      await saveDefaults(page, BASE);
      await openSetupFromSelection(page, [0, 1, 2]);
      await expect(setupDialog(page).locator('[data-reduced-motion-hint]')).toBeVisible();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(500);
      await snap(page, `aviso-movimiento-reducido-${label}.png`);
      await page.keyboard.press('Escape');
      await expect(setupDialog(page)).toBeHidden();

      // Mitad de un fundido de 3 s: las dos fotos mezcladas.
      await saveDefaults(page, { ...BASE, transition: 'fade' });
      await openSetupFromSelection(page, [0, 1, 2]);
      await startPresentation(page);
      await waitMidTransition(page, 'opacity');
      await snap(page, `transicion-fundido-${label}.png`);
      await exitPresentation(page);

      // Mitad de un deslizamiento: cada foto, parcial.
      await saveDefaults(page, { ...BASE, transition: 'slide' });
      await openSetupFromSelection(page, [0, 1, 2]);
      await startPresentation(page);
      await waitMidTransition(page, 'translate');
      await snap(page, `transicion-deslizar-${label}.png`);
      await exitPresentation(page);

      // Ken Burns con los valores por defecto (fundido + animaciones): la misma foto 4 s después.
      await saveDefaults(page, { ...BASE, transition: 'fade', transitionMs: 500, slideMs: 10_000 });
      await openSetupFromSelection(page, [0, 1, 2]);
      await startPresentation(page);
      await waitState(page, (s) => s.phase === 'showing' && s.slideIndex === 0, 'primera foto');
      await imagesLoaded(presentation(page));
      await page.mouse.move(5, 5);
      await snap(page, `kenburns-inicio-${label}.png`);
      await page.waitForTimeout(4000);
      await snap(page, `kenburns-despues-${label}.png`);
      await exitPresentation(page);
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
