// Verificación visual de la Fase 2: capturas de la galería con elementos (y una selección), del
// diálogo de renombrar, del de eliminar, de la confirmación de conversiones (D8) y del panel de
// importación (en curso y con el resumen), en los dos temas, en tests/.tmp/screenshots/fase-2/
// (<pantalla>-<tema>.png). Se revisan a mano; no se comparan con referencias (eso es la Fase 6).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT, unlockProfile } from './helpers/launch';
import {
  closeSummary,
  copyFixture,
  expectItemCount,
  gridCells,
  importAndSummarize,
  importPanel,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  startImportFromMenu,
  waitForSummary,
  writePhoto,
} from './helpers/library';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-2');

async function snap(page: Page, name: string): Promise<void> {
  // Las animaciones de entrada y el fundido del tema ya han terminado.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, name) });
}

async function thumbnailsLoaded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.getByRole('grid', { name: 'Galería' }).evaluate((grid) => {
        const imgs = Array.from(grid.querySelectorAll('img'));
        return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
      }),
    )
    .toBe(true);
}

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas de la galería y la importación en el tema ${displayName}`, async () => {
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

      // Galería vacía.
      await snap(page, `gallery-empty-${label}.png`);

      // Contenido variado: fotos sintéticas de colores con fechas de varios meses, los fixtures de
      // foto y dos vídeos.
      const paths: string[] = [];
      const months = [0, 0, 1, 1, 1, 2, 4, 4, 7, 9, 10, 11];
      for (const [i, month] of months.entries()) {
        const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
        await writePhoto(path, i + 11, { mtime: new Date(2025, month, 3 + i, 12) });
        paths.push(path);
      }
      for (const key of ['png', 'webp', 'gif', 'avif', 'mp4Vp9Opus', 'webmVp9Opus']) {
        paths.push(copyFixture(key, src));
      }
      const counts = await importAndSummarize(page, app, paths, 'files', 120_000);
      expect(counts.imported).toBe(paths.length);
      await expectItemCount(page, paths.length);
      await thumbnailsLoaded(page);

      // Galería con elementos y dos seleccionados (el último foco queda en una celda).
      const cells = gridCells(page);
      await cells.nth(1).click({ modifiers: ['Control'] });
      await cells.nth(3).click(); // ya en modo selección: un clic simple marca
      await expect(page.getByText('2 seleccionados', { exact: true })).toBeVisible();
      await page.mouse.move(5, 5);
      await snap(page, `gallery-${label}.png`);

      // Renombrar (F2 sobre un único elemento).
      await page.keyboard.press('Escape');
      await cells.nth(2).click({ modifiers: ['Control'] });
      await page.keyboard.press('F2');
      const rename = page.getByRole('dialog', { name: 'Renombrar' });
      await expect(rename).toBeVisible();
      await snap(page, `rename-${label}.png`);
      await page.keyboard.press('Escape');
      await expect(rename).toBeHidden();

      // Eliminar (Supr con dos elementos): el foco inicial está en "Cancelar".
      await cells.nth(4).click();
      await page.keyboard.press('Delete');
      const del = page.getByRole('alertdialog');
      await expect(del.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      await snap(page, `delete-${label}.png`);
      await page.keyboard.press('Escape');
      await expect(del).toBeHidden();
      await page.keyboard.press('Escape');

      // Confirmación de conversiones (D8): "Omitir esos vídeos" con el foco.
      const mov = copyFixture('movMpeg4', src);
      await startImportFromMenu(page, app, [mov]);
      const reencode = page.getByRole('alertdialog', { name: 'Convertir vídeos' });
      await expect(reencode.getByRole('button', { name: 'Omitir esos vídeos' })).toBeFocused();
      await snap(page, `reencode-${label}.png`);
      await reencode.getByRole('button', { name: 'Omitir esos vídeos' }).click();
      expect((await waitForSummary(page)).skipped).toBe(1);
      await closeSummary(page);

      // Panel de importación en curso: un lote grande de fotos con ruido (pesan ~1,5 MB cada una),
      // más un BMP para que el resumen tenga un fallo.
      const sharp = (await import('sharp')).default;
      const batch: string[] = [];
      for (let i = 0; i < 70; i += 1) {
        const path = join(src, `Lote ${String(i).padStart(3, '0')}.jpg`);
        await sharp({
          create: {
            width: 2000,
            height: 1500,
            channels: 3,
            background: { r: (i * 37) % 256, g: (i * 71) % 256, b: (i * 113) % 256 },
            noise: { type: 'gaussian', mean: 128, sigma: 40 },
          },
        })
          .jpeg({ quality: 90 })
          .toFile(path);
        batch.push(path);
      }
      batch.push(copyFixture('bmp', src));
      await startImportFromMenu(page, app, batch);
      const panel = importPanel(page);
      await expect(panel.getByText(/^\d+ de \d+$/)).toBeVisible({ timeout: 60_000 });
      await page.mouse.move(5, 5);
      await page.screenshot({ path: join(OUT, `import-progress-${label}.png`) });
      const summary = await waitForSummary(page, 240_000);
      expect(summary.imported).toBe(70);
      expect(summary.failed).toBe(1);
      await snap(page, `import-summary-${label}.png`);
      await closeSummary(page);

      // Ayuda (F1), con los límites y los atajos.
      await page.keyboard.press('F1');
      await expect(page.getByRole('heading', { level: 1, name: 'Ayuda' })).toBeVisible();
      await expect(
        page.getByText(
          'Algunos vídeos de cámara (H.264 de 10 bits o 4:2:2/4:4:4) podrían no reproducirse en Galería después de importarlos.',
        ),
      ).toBeVisible();
      if (id === 'ps3') {
        // La barra XMB sigue a la pantalla activa aunque el cambio venga de un atajo global.
        const helpCategory = page
          .getByRole('navigation', { name: 'Navegación principal' })
          .getByRole('list', { name: 'Categorías' })
          .getByRole('button', { name: 'Ayuda' });
        await expect(helpCategory).toHaveAttribute('aria-current', 'true');
        await expect(helpCategory).toHaveAttribute('tabindex', '0');
      }
      await snap(page, `help-${label}.png`);
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
