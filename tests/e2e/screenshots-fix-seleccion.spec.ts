// Verificación visual del modo selección (docs/PLAN.md notas 192–195), en los dos temas, en
// tests/.tmp/screenshots/fix-seleccion/: la galería en modo normal (sin casillas), la galería en modo
// selección (casillas visibles en todas las tarjetas y la barra con el contador) y el detalle de una
// playlist con dos filas marcadas. Se revisan a mano; no se comparan con referencias.
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
import {
  addSelectionToNewPlaylist,
  clickSelect,
  detailList,
  imagesLoaded,
  openPlaylistDetail,
  selectionBar,
} from './helpers/playlists';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fix-seleccion');

async function snap(page: Page, name: string): Promise<void> {
  // Las animaciones de entrada y el fundido del tema ya han terminado.
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, name) });
}

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas del modo selección en el tema ${displayName}`, async () => {
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

      // Doce fotos sintéticas de colores distintos, tres por mes.
      const paths: string[] = [];
      const months = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3];
      for (const [i, month] of months.entries()) {
        const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
        await writePhoto(path, i + 11, { mtime: new Date(2025, month, 3 + i, 12) });
        paths.push(path);
      }
      expect((await importAndSummarize(page, app, paths, 'files', 120_000)).imported).toBe(12);
      await expectItemCount(page, 12);
      await imagesLoaded(page.getByRole('grid', { name: 'Galería' }));

      // Modo normal: sin casillas, sin barra, el ratón fuera.
      await page.mouse.move(5, 5);
      await expect(page.locator('[data-gallery-grid]')).toHaveAttribute(
        'data-selection-mode',
        'false',
      );
      await snap(page, `galeria-normal-${label}.png`);

      // Modo selección: tres clics simples en cualquier parte de la tarjeta (nota 195).
      await clickSelect(page, [0, 2, 4]);
      await expect(selectionBar(page).getByText('3 seleccionados', { exact: true })).toBeVisible();
      await expect(page.locator('[data-gallery-grid]')).toHaveAttribute(
        'data-selection-mode',
        'true',
      );
      await page.mouse.move(5, 5);
      await snap(page, `galeria-seleccion-${label}.png`);

      // Detalle de una playlist con dos filas marcadas.
      await addSelectionToNewPlaylist(page, 'Vacaciones');
      await selectionBar(page).getByRole('button', { name: 'Cancelar selección' }).click();
      await clickSelect(page, [5, 6]);
      await addSelectionToNewPlaylist(page, 'Cumpleaños');
      await selectionBar(page).getByRole('button', { name: 'Cancelar selección' }).click();
      await openPlaylistDetail(page, 'Vacaciones');
      await imagesLoaded(detailList(page));
      const rows = detailList(page).getByRole('listitem');
      await rows.nth(0).getByRole('checkbox').click();
      await rows.nth(2).locator('img').click();
      await expect(selectionBar(page).getByText('2 seleccionados', { exact: true })).toBeVisible();
      await page.mouse.move(5, 5);
      await snap(page, `detalle-playlist-seleccion-${label}.png`);
    } finally {
      await launched.app.close().catch(() => undefined);
      launched.cleanup();
      removeDir(src);
    }
  });
}
