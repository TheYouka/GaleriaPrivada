// Verificación visual de las playlists (docs/PLAN.md 4.4): capturas en los dos temas, en
// tests/.tmp/screenshots/fase-4/: la pantalla Playlists (playlists-<tema>.png), el menú «Añadir a
// playlist» de la barra de selección (add-to-playlist-<tema>.png), el detalle con la lista
// reordenable (playlist-detail-<tema>.png) y Ajustes → Música (music-settings-<tema>.png).
// Se revisan a mano; no se comparan con referencias (eso es la Fase 6). Ventana discreta (nota 135),
// fotos sintéticas y tonos de ffmpeg bajo tests/.tmp/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT, unlockProfile } from './helpers/launch';
import {
  expectItemCount,
  importAndSummarize,
  mockOpenDialog,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
  writeTone,
} from './helpers/library';
import {
  addSelectionToNewPlaylist,
  clickSelect,
  imagesLoaded,
  openPlaylistDetail,
  openPlaylistsScreen,
  selectionBar,
} from './helpers/playlists';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-4');

/** Cierra los avisos que dejó la preparación (con un menú abierto no se puede: cerraría el menú). */
async function dismissToasts(page: Page): Promise<void> {
  const close = page
    .getByRole('region', { name: /^Notificaciones/ })
    .getByRole('button', { name: 'Cerrar' });
  for (let i = 0; i < 6 && (await close.count()) > 0; i += 1) {
    await close.first().click();
    await page.waitForTimeout(150);
  }
  await expect(close).toHaveCount(0);
  await page.mouse.move(5, 5);
}

async function snap(page: Page, name: string, dismiss = true): Promise<void> {
  if (dismiss) await dismissToasts(page);
  // Las animaciones de entrada y el fundido del tema ya han terminado.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, name) });
}

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas de playlists y música en el tema ${displayName}`, async () => {
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
      for (let i = 0; i < 8; i += 1) {
        const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
        await writePhoto(path, i + 21, { mtime: new Date(2025, 5, 3 + i, 12) });
        paths.push(path);
      }
      expect((await importAndSummarize(page, app, paths, 'files', 120_000)).imported).toBe(8);
      await expectItemCount(page, 8);

      // Dos playlists con contenido: «Vacaciones» (4 fotos) y «Cumpleaños» (2).
      await clickSelect(page, [0, 1, 2, 3]);
      await addSelectionToNewPlaylist(page, 'Vacaciones');
      await selectionBar(page).getByRole('button', { name: 'Cancelar selección' }).click();
      await clickSelect(page, [5, 6]);
      await addSelectionToNewPlaylist(page, 'Cumpleaños');

      // Menú «Añadir a playlist» con las dos playlists y «Nueva playlist…» (sin avisos residuales).
      await dismissToasts(page);
      await selectionBar(page).getByRole('button', { name: 'Añadir a playlist' }).click();
      await expect(page.getByRole('menuitem', { name: 'Nueva playlist…' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Vacaciones/ })).toBeVisible();
      await page.mouse.move(5, 5);
      await snap(page, `add-to-playlist-${label}.png`, false);
      await page.keyboard.press('Escape');

      // Pantalla Playlists.
      await openPlaylistsScreen(page);
      await expect(
        page.locator('main').getByRole('list', { name: 'Playlists' }).getByRole('listitem'),
      ).toHaveCount(2);
      await imagesLoaded(page.locator('main').getByRole('list', { name: 'Playlists' }));
      await page.mouse.move(5, 5);
      await snap(page, `playlists-${label}.png`);

      // Detalle con la lista reordenable.
      await openPlaylistDetail(page, 'Vacaciones');
      await imagesLoaded(page.getByRole('list', { name: /^Elementos de «/ }));
      await page.mouse.move(5, 5);
      await snap(page, `playlist-detail-${label}.png`);

      // Ajustes → Música con dos pistas.
      const tone1 = join(src, 'Pista de prueba uno.wav');
      const tone2 = join(src, 'Pista de prueba dos.wav');
      writeTone(tone1, 2);
      writeTone(tone2, 3);
      await page.keyboard.press('Control+,');
      await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
      await page.getByRole('tab', { name: 'Música' }).click();
      await mockOpenDialog(app, [tone1, tone2]);
      await page.getByRole('button', { name: 'Importar música…' }).click();
      await expect(
        page.getByRole('region', { name: 'Resumen de la importación de música' }),
      ).toContainText('Se añadieron 2 pistas.');
      await page.mouse.move(5, 5);
      await snap(page, `music-settings-${label}.png`);
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
