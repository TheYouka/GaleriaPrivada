// Verificación visual de la presentación (docs/PLAN.md 4.6): capturas en los dos temas, en
// tests/.tmp/screenshots/fase-4/: el diálogo de inicio (presentation-setup-<tema>.png) y una
// presentación a mitad de una diapositiva con sus controles a la vista (presentation-slide-<tema>.png).
// La diapositiva no depende del tema; el diálogo y la barra sí. Se revisan a mano. Ventana discreta
// (nota 135), pantalla completa simulada, fotos sintéticas y tonos de ffmpeg bajo tests/.tmp/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT, unlockProfile } from './helpers/launch';
import {
  expectItemCount,
  importAndSummarize,
  importMusic,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
  writeTone,
} from './helpers/library';
import { clickSelect, imagesLoaded } from './helpers/playlists';
import {
  controlsBar,
  installFullscreenDouble,
  presentation,
  saveDefaults,
  setupDialog,
  startPresentation,
  waitState,
} from './helpers/presentation';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-4');

async function snap(page: Page, name: string): Promise<void> {
  // Las animaciones de entrada y el fundido del tema ya han terminado.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, name) });
}

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas de la presentación en el tema ${displayName}`, async () => {
    test.setTimeout(300_000);
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
      for (let i = 0; i < 6; i += 1) {
        const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
        await writePhoto(path, i + 5, {
          width: 960,
          height: 600,
          mtime: new Date(2025, 5, 3 + i, 12),
        });
        paths.push(path);
      }
      expect((await importAndSummarize(page, app, paths, 'files', 120_000)).imported).toBe(6);
      await expectItemCount(page, 6);
      await imagesLoaded(page.getByRole('grid', { name: 'Galería' }));
      const tone1 = join(src, 'Pista de prueba uno.wav');
      const tone2 = join(src, 'Pista de prueba dos.wav');
      writeTone(tone1, 30);
      writeTone(tone2, 30);
      const music = await importMusic(app, page, [tone1, tone2]);
      expect(music.imported).toHaveLength(2);
      await installFullscreenDouble(app);

      // Valores por defecto de la captura: ventana (se ve la barra de título del tema), las dos
      // pistas elegidas y música de fondo.
      await saveDefaults(
        page,
        { startFullscreen: false, musicEnabled: true, slideMs: 20_000, musicVolume: 0.5 },
        music.imported.map((t) => t.id),
      );

      // Diálogo de inicio con la selección.
      await clickSelect(page, [0, 1, 2, 3, 4, 5]);
      await page
        .getByRole('region', { name: 'Selección' })
        .getByRole('button', { name: 'Presentación' })
        .click();
      await expect(setupDialog(page)).toBeVisible();
      await expect(
        setupDialog(page).getByRole('checkbox', { name: /Pista de prueba uno/ }),
      ).toBeChecked();
      await page.mouse.move(5, 5);
      await snap(page, `presentation-setup-${label}.png`);

      // Una diapositiva con los controles a la vista (el ratón los mantiene visibles).
      await startPresentation(page);
      await waitState(page, (s) => s.phase === 'showing' && s.slideIndex === 0, 'primera foto');
      await imagesLoaded(presentation(page));
      await page.mouse.move(640, 600);
      await expect(controlsBar(page)).toHaveAttribute('data-visible', 'true');
      await waitState(
        page,
        (s) => (s.musicGain ?? 0) > 0.3 && !s.musicPaused,
        'la música sube',
        15_000,
      );
      await snap(page, `presentation-slide-${label}.png`);
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
