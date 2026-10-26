// Importación (docs/PLAN.md 2.13; docs/DESIGN.md §12, §14.6 y §22): con el botón y arrastrando, el
// original solo desaparece después de verificar; los fallos y los formatos rechazados lo dejan
// intacto; duplicados; confirmación de conversiones (D8); y nada en claro bajo la raíz de datos.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  closeSummary,
  copyFixture,
  fixture,
  fixtureNeedles,
  gridCells,
  importAndSummarize,
  importPanel,
  launchUnlocked,
  mockOpenDialog,
  newSourceDir,
  PROFILE,
  removeDir,
  scanForNeedles,
  sha256File,
  startImportFromMenu,
  waitForSummary,
} from './helpers/library';
import { lockAndGetNewWindow, readProfilesJson, type LaunchedApp } from './helpers/launch';

let launched: LaunchedApp;
let src: string;

test.beforeEach(async () => {
  launched = await launchUnlocked();
  src = newSourceDir();
});

test.afterEach(async () => {
  removeDir(src);
  await launched?.close();
});

/** Todas las miniaturas de la rejilla cargaron (hay imagen decodificada). */
async function expectThumbnailsLoaded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.getByRole('grid', { name: 'Galería' }).evaluate((grid) => {
          const imgs = Array.from(grid.querySelectorAll('img'));
          return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}

test('importar archivos y una carpeta con el botón: aparecen con miniatura y los originales desaparecen', async () => {
  const { page, app } = launched;
  const files = ['jpeg', 'png', 'webp'].map((k) => copyFixture(k, src));
  const counts = await importAndSummarize(page, app, files);
  expect(counts).toEqual({ imported: 3, duplicates: 0, skipped: 0, failed: 0 });
  for (const f of files) expect(existsSync(f), f).toBe(false);
  await expect(gridCells(page)).toHaveCount(3);

  const folder = join(src, 'vacaciones');
  mkdirSync(join(folder, 'dentro'), { recursive: true });
  const nested = [
    copyFixture('gif', folder),
    copyFixture('avif', folder),
    copyFixture('mp4Vp9Opus', join(folder, 'dentro')),
  ];
  const second = await importAndSummarize(page, app, [folder], 'folder');
  expect(second).toEqual({ imported: 3, duplicates: 0, skipped: 0, failed: 0 });
  for (const f of nested) expect(existsSync(f), f).toBe(false);
  await expect(gridCells(page)).toHaveCount(6);
  await expect(page.getByText('6 elementos')).toBeVisible();
  // El vídeo lleva la insignia de duración.
  await expect(page.getByRole('gridcell', { name: /vídeo, 0:04$/ })).toBeVisible();
  await expectThumbnailsLoaded(page);
});

test('arrastrar y soltar: la capa aparece al arrastrar, un archivo soltado y una carpeta se importan', async () => {
  const { page, app } = launched;

  // Un archivo con ruta real (setInputFiles) soltado sobre la ventana: pasa por importDropped.
  const dropped = copyFixture('jpeg', src);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'e2e-drop-source';
    document.body.appendChild(input);
  });
  await page.setInputFiles('#e2e-drop-source', [dropped]);
  const dispatch = (type: string): Promise<void> =>
    page.evaluate((eventType) => {
      const input = document.getElementById('e2e-drop-source') as HTMLInputElement;
      const dt = new DataTransfer();
      for (const f of Array.from(input.files ?? [])) dt.items.add(f);
      window.dispatchEvent(
        new DragEvent(eventType, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }, type);

  await dispatch('dragenter');
  await expect(page.getByText('Suelta para importar', { exact: true }).first()).toBeVisible();
  await dispatch('drop');
  await expect(page.getByText('Suelta para importar', { exact: true })).toBeHidden();
  const counts = await waitForSummary(page);
  expect(counts.imported).toBe(1);
  await closeSummary(page);
  expect(existsSync(dropped)).toBe(false);
  await expect(gridCells(page)).toHaveCount(1);

  // Un arrastre que no lleva archivos no enseña la capa.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hola');
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  });
  await expect(page.getByText('Suelta para importar', { exact: true })).toBeHidden();

  // Una carpeta: Playwright no puede soltar una carpeta del SO sobre la ventana, así que se usa el
  // gancho de E2E que recorre el mismo camino de main que un arrastre (import:paths, nota 108).
  const folder = join(src, 'carpeta-soltada');
  mkdirSync(folder);
  const inside = [copyFixture('png', folder), copyFixture('webp', folder)];
  const result = await app.evaluate(
    (_electron, paths) =>
      (
        globalThis as unknown as {
          __galeriaTestImportPaths(p: string[]): Promise<{ ok: boolean }>;
        }
      ).__galeriaTestImportPaths(paths),
    [folder],
  );
  expect(result.ok).toBe(true);
  const second = await waitForSummary(page);
  expect(second.imported).toBe(2);
  await closeSummary(page);
  for (const f of inside) expect(existsSync(f), f).toBe(false);
  await expect(gridCells(page)).toHaveCount(3);
});

test('BMP, HEIC y CR3 se rechazan y sus originales quedan intactos', async () => {
  const { page, app } = launched;
  const keys = ['bmp', 'heic', 'cr3'];
  const paths = keys.map((k) => copyFixture(k, src));
  const before = paths.map(sha256File);

  await startImportFromMenu(page, app, paths);
  const counts = await waitForSummary(page);
  expect(counts).toEqual({ imported: 0, duplicates: 0, skipped: 0, failed: 3 });
  const panel = importPanel(page);
  for (const key of keys) await expect(panel.getByText(fixture(key).file)).toBeVisible();
  await expect(panel.getByText('Formato no compatible').first()).toBeVisible();
  await closeSummary(page);

  expect(paths.map(sha256File)).toEqual(before);
  expect(paths.map(sha256File)).toEqual(keys.map((k) => fixture(k).sha256));
  await expect(page.getByText('Tu bóveda está vacía.')).toBeVisible();
});

test.describe('fallos inyectados en el pipeline', () => {
  for (const point of ['begin', 'step0', 'step2', 'step3', 'step4', 'step5', 'step6', 'step6b']) {
    test(`un fallo en ${point} deja el original intacto y la bóveda vacía`, async () => {
      const { page, app } = launched;
      const original = copyFixture('jpeg', src);
      const hash = sha256File(original);
      const armed = await app.evaluate(
        (_e, p) =>
          (
            globalThis as unknown as { __galeriaTestFailImportAt(p: string): boolean }
          ).__galeriaTestFailImportAt(p),
        point,
      );
      expect(armed).toBe(true);

      await startImportFromMenu(page, app, [original]);
      const counts = await waitForSummary(page);
      expect(counts).toEqual({ imported: 0, duplicates: 0, skipped: 0, failed: 1 });
      await closeSummary(page);

      expect(existsSync(original)).toBe(true);
      expect(sha256File(original)).toBe(hash);
      await expect(page.getByText('Tu bóveda está vacía.')).toBeVisible();
    });
  }

  test('un fallo antes de borrar el original (paso 8): la copia queda en la bóveda y se avisa con la ruta', async () => {
    const { page, app } = launched;
    const original = copyFixture('jpeg', src);
    const hash = sha256File(original);
    await app.evaluate(() =>
      (
        globalThis as unknown as { __galeriaTestFailImportAt(p: string): boolean }
      ).__galeriaTestFailImportAt('step8'),
    );
    await startImportFromMenu(page, app, [original]);
    const counts = await waitForSummary(page);
    expect(counts.imported).toBe(1);
    const panel = importPanel(page);
    await expect(panel.getByText('Originales que no se pudieron borrar')).toBeVisible();
    await expect(panel.getByText(original, { exact: true })).toBeVisible();
    await closeSummary(page);
    expect(sha256File(original)).toBe(hash);
    await expect(gridCells(page)).toHaveCount(1);
  });
});

test('reimportar el mismo archivo cuenta como duplicado y borra el original', async () => {
  const { page, app } = launched;
  const first = copyFixture('png', src);
  expect((await importAndSummarize(page, app, [first])).imported).toBe(1);
  const again = copyFixture('png', src);
  const counts = await importAndSummarize(page, app, [again]);
  expect(counts).toEqual({ imported: 0, duplicates: 1, skipped: 0, failed: 0 });
  expect(existsSync(again)).toBe(false);
  await expect(gridCells(page)).toHaveCount(1);
});

test('un MKV remultiplexado, reimportado, cuenta como duplicado y no como sustitución', async () => {
  const { page, app } = launched;
  const first = copyFixture('mkvVp9Opus', src);
  expect((await importAndSummarize(page, app, [first])).imported).toBe(1);
  expect(existsSync(first)).toBe(false);
  await expect(gridCells(page)).toHaveCount(1);

  const again = copyFixture('mkvVp9Opus', src);
  const counts = await importAndSummarize(page, app, [again]);
  expect(counts).toEqual({ imported: 0, duplicates: 1, skipped: 0, failed: 0 });
  expect(existsSync(again)).toBe(false);
  await expect(gridCells(page)).toHaveCount(1);
});

test.describe('confirmación de conversiones (D8)', () => {
  const dialog = (page: Page) => page.getByRole('alertdialog', { name: 'Convertir vídeos' });

  test('el foco inicial está en "Omitir esos vídeos"; omitir deja el original; Esc cancela; convertir borra el original', async () => {
    const { page, app } = launched;
    const original = copyFixture('movMpeg4', src);
    const hash = sha256File(original);

    // 1. Omitir (Enter sobre el foco inicial).
    await startImportFromMenu(page, app, [original]);
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByText(
        /1 vídeo \(.+\) se convertirá a un formato compatible, con pérdida de calidad, y su original se borrará al terminar\./,
      ),
    ).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Omitir esos vídeos' })).toBeFocused();
    await expect(
      dialog(page).getByRole('button', { name: 'Convertir y borrar originales' }),
    ).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Cancelar importación' })).toBeVisible();
    await page.keyboard.press('Enter');
    let counts = await waitForSummary(page);
    expect(counts).toEqual({ imported: 0, duplicates: 0, skipped: 1, failed: 0 });
    await closeSummary(page);
    expect(sha256File(original)).toBe(hash);

    // 2. Esc equivale a "Cancelar importación": no se toca nada.
    await startImportFromMenu(page, app, [original]);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      importPanel(page).getByRole('heading', { name: 'Importación cancelada' }),
    ).toBeVisible({ timeout: 30_000 });
    await closeSummary(page);
    expect(sha256File(original)).toBe(hash);
    await expect(page.getByText('Tu bóveda está vacía.')).toBeVisible();

    // 3. Convertir y borrar originales: se importa (VP9 en MP4 fragmentado) y el original se borra.
    await startImportFromMenu(page, app, [original]);
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Convertir y borrar originales' }).click();
    counts = await waitForSummary(page, 120_000);
    expect(counts).toEqual({ imported: 1, duplicates: 0, skipped: 0, failed: 0 });
    await closeSummary(page);
    expect(existsSync(original)).toBe(false);
    await expect(page.getByRole('gridcell', { name: /vídeo, 0:0[3-5]$/ })).toBeVisible();
  });
});

test('nada en claro bajo la raíz de datos: ni el marcador, ni los primeros 64 bytes, ni los nombres', async () => {
  test.setTimeout(120_000);
  const { page, app } = launched;
  const keys = ['jpeg', 'png', 'webp', 'gif', 'avif', 'mp4Vp9Opus', 'mkvVp9Opus', 'webmVp9Opus'];
  const paths = keys.map((k) => copyFixture(k, src));
  // El marcador viaja en el EXIF y el nombre del JPEG y en los píxeles y el nombre del PNG.

  const counts = await importAndSummarize(page, app, paths);
  expect(counts.imported).toBe(keys.length);
  await expect(gridCells(page)).toHaveCount(keys.length);
  await mockOpenDialog(app, []);

  // Bloquear con Ctrl+L, cerrar la app y analizar el disco.
  await lockAndGetNewWindow(app, () => page.keyboard.press('Control+L'));
  await launched.quit();

  const needles = fixtureNeedles(keys);
  const roots = [launched.dataDir, `${launched.dataDir}.electron`];
  const { scanned, hits, files } = scanForNeedles(roots, needles, launched.dataDir);
  console.log(`[e2e] archivos analizados: ${scanned}`);
  expect(scanned).toBeGreaterThan(10);
  // Se analizaron los objetos cifrados de la bóveda (no solo los archivos de configuración).
  const profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
  expect(files.filter((f) => f.includes(join('vaults', profileId, 'objects'))).length).toBe(
    keys.length,
  );
  // Control positivo: el nombre del perfil sí está en claro en profiles.json, por diseño.
  const control = scanForNeedles(
    roots,
    [{ label: 'perfil', bytes: Buffer.from(PROFILE) }],
    launched.dataDir,
  );
  expect(control.hits.length).toBeGreaterThan(0);
  expect(hits).toEqual([]);
});
