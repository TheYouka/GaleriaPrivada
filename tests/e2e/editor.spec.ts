// Editor (docs/PLAN.md 3.5 y 3.7; docs/DESIGN.md §16.3–§16.5): recortar + girar + voltear + guardar
// (thumbRev sube y la miniatura cambia), revertir (vuelve la original), el objeto original no cambia
// de SHA-256 en disco, un recorrido solo con teclado, y nada en claro tras editar y bloquear.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  choosePickerTheme,
  createProfile,
  launchApp,
  lockAndGetNewWindow,
  readProfilesJson,
  ROOT,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';
import {
  copyFixture,
  expectItemCount,
  fixtureNeedles,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  mediaIdOf,
  newSourceDir,
  objectHashes,
  PASSWORD,
  PROFILE,
  quadrantsOfPng,
  removeDir,
  savedEdits,
  scanForNeedles,
  thumbQuadrants,
  thumbRevOf,
  writePhoto,
  writeQuadrants,
  type QuadrantColor,
} from './helpers/library';

const SHOTS = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-3');
/** Cuatro puntos, uno en cada cuadrante de una imagen (o de la vista recortada). */
const POINTS = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;
const ORIGINAL: QuadrantColor[] = ['red', 'green', 'blue', 'yellow'];

const viewerDialog = (page: Page): Locator => page.locator('[data-viewer]');
/** La celda por id (CSS): con el visor abierto la rejilla está oculta para los roles. */
const tile = (page: Page, id: string): Locator => page.locator(`[data-media-id="${id}"]`);
const editorRoot = (page: Page): Locator => page.locator('[data-editor]');

async function waitViewerOpen(page: Page): Promise<void> {
  await expect(viewerDialog(page)).toHaveAttribute('data-viewer-state', 'open', {
    timeout: 10_000,
  });
}

async function openEditor(page: Page): Promise<void> {
  await waitViewerOpen(page);
  await page.keyboard.press('e');
  await expect(editorRoot(page)).toBeVisible();
  await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'edit');
  await waitEditorImage(page);
}

async function waitEditorImage(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator('[data-edited-image="editor"] img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
}

/** Colores de cuadrante de lo que pinta una imagen editada (captura del elemento). */
async function renderedQuadrants(
  page: Page,
  testId: 'editor' | 'viewer',
  points: readonly (readonly [number, number])[] = POINTS,
): Promise<{ aspect: number; colors: QuadrantColor[] }> {
  const png = await page.locator(`[data-edited-image="${testId}"]`).screenshot();
  const { width, height, colors } = await quadrantsOfPng(png, points);
  return { aspect: width / height, colors };
}

/** Tab hasta que el foco llega a un control con ese nombre accesible (solo teclado). */
async function tabTo(page: Page, label: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const name = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ??
        document.activeElement?.textContent?.trim(),
    );
    if (name === label) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`el foco no llegó a «${label}»`);
}

/** Coordenadas del centro de un elemento. */
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('elemento sin caja');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('editor', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;
  let src: string;
  let profileId: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    launched = await launchUnlocked({}, { width: 1280, height: 800 });
    page = launched.page;
    src = newSourceDir();
    // Dos imágenes asimétricas (la más reciente sale primero) y una foto de degradado.
    const q1 = join(src, 'Cuadrantes uno.png');
    const q2 = join(src, 'Cuadrantes dos.png');
    const g = join(src, 'Degradado.jpg');
    await writeQuadrants(q1, { mtime: new Date(2025, 6, 3, 12) });
    // Otro tamaño: si no, sería un duplicado del primero.
    await writeQuadrants(q2, { width: 440, height: 220, mtime: new Date(2025, 6, 2, 12) });
    await writePhoto(g, 5, { width: 640, height: 400, mtime: new Date(2025, 6, 1, 12) });
    expect((await importAndSummarize(page, launched.app, [q1, q2, g])).imported).toBe(3);
    await expectItemCount(page, 3);
    await expect
      .poll(() =>
        page
          .getByRole('grid', { name: 'Galería' })
          .evaluate((el) =>
            Array.from(el.querySelectorAll('img')).every((i) => i.naturalWidth > 0),
          ),
      )
      .toBe(true);
    profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
  });

  test.afterAll(async () => {
    await launched?.close();
    if (src) removeDir(src);
  });

  test('recortar + girar + voltear + guardar: sube thumbRev, cambia la miniatura y el original no cambia; revertir la devuelve', async () => {
    const cell = gridCells(page).nth(0);
    const id = await mediaIdOf(cell);
    const before = objectHashes(launched.dataDir, profileId);
    expect(Object.keys(before)).toHaveLength(3);
    expect(await thumbRevOf(tile(page, id))).toBe(0);
    const original = await thumbQuadrants(page, id, 0, POINTS);
    expect(original.colors).toEqual(ORIGINAL);
    expect(original.width / original.height).toBeCloseTo(2, 1);

    await cell.click();
    await openEditor(page);
    // Sin cambios no hay nada que guardar.
    await expect(page.getByRole('button', { name: 'Guardar' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.getByRole('button', { name: 'Girar a la derecha' }).click();
    await page.getByRole('button', { name: 'Voltear horizontalmente' }).click();
    // Girar a la derecha: arriba izquierda = azul, arriba derecha = rojo, abajo derecha = verde,
    // abajo izquierda = amarillo; voltear: izquierda ↔ derecha.
    await expect
      .poll(async () => (await renderedQuadrants(page, 'editor')).colors)
      .toEqual(['red', 'blue', 'green', 'yellow']);
    expect((await renderedQuadrants(page, 'editor')).aspect).toBeCloseTo(0.5, 1);

    // Recorte: se arrastra el asa derecha hasta el 75 % del ancho y se aplica.
    const box = await page.locator('[data-editor-box]').boundingBox();
    const handle = await centerOf(page.locator('[data-crop-handle="e"]'));
    if (!box) throw new Error('sin caja');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, handle.y, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Aplicar recorte' }).click();
    const cropped = [
      [0.25, 0.25],
      [0.9, 0.25],
      [0.25, 0.75],
      [0.9, 0.75],
    ] as const;
    await expect
      .poll(async () => (await renderedQuadrants(page, 'editor', cropped)).colors)
      .toEqual(['red', 'blue', 'green', 'yellow']);
    expect((await renderedQuadrants(page, 'editor')).aspect).toBeCloseTo(0.375, 1);

    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'view');
    await expect.poll(() => thumbRevOf(tile(page, id))).toBe(1);

    const edits = (await savedEdits(page, id)) as { t: string; q?: number; w?: number }[];
    expect(edits.map((e) => e.t)).toEqual(['rotate', 'flipH', 'crop']);
    expect(edits[0]?.q).toBe(1);
    expect(edits[2]?.w).toBeGreaterThan(0.72);
    expect(edits[2]?.w).toBeLessThan(0.78);

    // El visor pinta las ediciones guardadas con CSS (§16.3) y la miniatura de main coincide.
    await expect
      .poll(async () => (await renderedQuadrants(page, 'viewer', cropped)).colors)
      .toEqual(['red', 'blue', 'green', 'yellow']);
    expect((await renderedQuadrants(page, 'viewer')).aspect).toBeCloseTo(0.375, 1);
    const thumb = await thumbQuadrants(page, id, 1, cropped);
    expect(thumb.colors).toEqual(['red', 'blue', 'green', 'yellow']);
    expect(thumb.width / thumb.height).toBeCloseTo(0.375, 1);
    // El original almacenado no se tocó: los mismos archivos con el mismo SHA-256.
    expect(objectHashes(launched.dataDir, profileId)).toEqual(before);

    // Revertir: «Restablecer original» + «Guardar» vuelve a la imagen original.
    await openEditor(page);
    await page.getByRole('button', { name: 'Restablecer original' }).click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'view');
    await expect.poll(() => thumbRevOf(tile(page, id))).toBe(2);
    expect(await savedEdits(page, id)).toEqual([]);
    const reverted = await thumbQuadrants(page, id, 2, POINTS);
    expect(reverted.colors).toEqual(ORIGINAL);
    expect(reverted.width / reverted.height).toBeCloseTo(2, 1);
    await expect
      .poll(async () => (await renderedQuadrants(page, 'viewer')).colors)
      .toEqual(ORIGINAL);
    expect(objectHashes(launched.dataDir, profileId)).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveCount(0);
  });

  test('las proporciones del recorte fijan el rectángulo; Cancelar y Esc descartan los cambios', async () => {
    const cell = gridCells(page).nth(1);
    const id = await mediaIdOf(cell);
    await cell.click();
    await openEditor(page);

    await page.getByRole('combobox', { name: 'Proporción del recorte' }).click();
    await page.getByRole('option', { name: '1:1' }).click();
    const rect = await page.locator('[data-crop-rect]').boundingBox();
    expect(rect).toBeTruthy();
    if (rect) expect(rect.width / rect.height).toBeCloseTo(1, 1);
    await page.getByRole('combobox', { name: 'Proporción del recorte' }).click();
    await page.getByRole('option', { name: '16:9' }).click();
    const wide = await page.locator('[data-crop-rect]').boundingBox();
    if (wide) expect(wide.width / wide.height).toBeCloseTo(16 / 9, 1);

    // Cancelar descarta: nada guardado.
    await page.getByRole('button', { name: 'Girar a la izquierda' }).click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'view');
    expect(await savedEdits(page, id)).toEqual([]);
    expect(await thumbRevOf(tile(page, id))).toBe(0);

    // Esc también cancela el editor (y no cierra el visor).
    await openEditor(page);
    await page.getByRole('button', { name: 'Voltear verticalmente' }).click();
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'view');
    await expect(viewerDialog(page)).toHaveCount(1);
    expect(await savedEdits(page, id)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveCount(0);
  });

  test('recorrido solo con teclado: girar, voltear, deshacer/rehacer, asa del recorte con flechas, guardar', async () => {
    const cell = gridCells(page).nth(1);
    const id = await mediaIdOf(cell);
    await cell.focus();
    await page.keyboard.press('Enter');
    await openEditor(page);
    // Al entrar, el foco está en la primera herramienta.
    await expect(page.getByRole('combobox', { name: 'Proporción del recorte' })).toBeFocused();

    await tabTo(page, 'Girar a la derecha');
    await page.keyboard.press('Enter');
    await tabTo(page, 'Voltear horizontalmente');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await renderedQuadrants(page, 'editor')).colors)
      .toEqual(['red', 'blue', 'green', 'yellow']);

    // Ctrl+Z / Ctrl+Y.
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await renderedQuadrants(page, 'editor')).colors)
      .toEqual(['blue', 'red', 'yellow', 'green']);
    await expect(page.getByRole('button', { name: /^Rehacer/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Control+y');
    await expect
      .poll(async () => (await renderedQuadrants(page, 'editor')).colors)
      .toEqual(['red', 'blue', 'green', 'yellow']);

    // El asa derecha con Mayús+flecha izquierda (10 % cada vez) y Intro para aplicar.
    await tabTo(page, 'Borde derecho del recorte');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.getByRole('button', { name: 'Aplicar recorte' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Aplicar recorte' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect((await renderedQuadrants(page, 'editor')).aspect).toBeCloseTo(0.4, 1);

    // El rectángulo también se mueve con flechas (1 %), y «Guardar» con Intro.
    await tabTo(page, 'Guardar');
    await page.keyboard.press('Enter');
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'view');
    await expect.poll(() => thumbRevOf(tile(page, id))).toBe(1);
    const edits = (await savedEdits(page, id)) as { t: string; w?: number }[];
    expect(edits.map((e) => e.t)).toEqual(['rotate', 'flipH', 'crop']);
    expect(edits[2]?.w).toBeCloseTo(0.8, 5);
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveCount(0);
    await expect(cell).toBeFocused();
  });
});

test('nada en claro tras editar y bloquear: ni el marcador ni los nombres', async () => {
  test.setTimeout(120_000);
  const launched = await launchUnlocked({}, { width: 1280, height: 800 });
  const src = newSourceDir();
  try {
    const { page, app } = launched;
    const keys = ['jpeg', 'png'];
    const paths = keys.map((k) => copyFixture(k, src));
    expect((await importAndSummarize(page, app, paths)).imported).toBe(2);
    await expectItemCount(page, 2);
    for (const index of [0, 1]) {
      const cell = gridCells(page).nth(index);
      const id = await mediaIdOf(cell);
      await cell.click();
      await openEditor(page);
      await page.getByRole('button', { name: 'Girar a la derecha' }).click();
      await page.getByRole('button', { name: 'Voltear verticalmente' }).click();
      await page.getByRole('button', { name: 'Guardar' }).click();
      await expect(viewerDialog(page)).toHaveAttribute('data-viewer-mode', 'view');
      await expect.poll(() => thumbRevOf(tile(page, id))).toBe(1);
      await page.keyboard.press('Escape');
      await expect(viewerDialog(page)).toHaveCount(0);
    }
    await lockAndGetNewWindow(app, () => page.keyboard.press('Control+L'));
    await launched.quit();

    const roots = [launched.dataDir, `${launched.dataDir}.electron`];
    const { scanned, hits } = scanForNeedles(roots, fixtureNeedles(keys), launched.dataDir);
    expect(scanned).toBeGreaterThan(10);
    // Control positivo: el nombre del perfil sí está en claro, por diseño.
    const control = scanForNeedles(
      roots,
      [{ label: 'perfil', bytes: Buffer.from(PROFILE) }],
      launched.dataDir,
    );
    expect(control.hits.length).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  } finally {
    removeDir(src);
    // Como los demás E2E: cerrar otra vez espera a que el proceso termine de verdad y borra los datos.
    await launched.close();
  }
});

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`captura del editor con el recorte en el tema ${displayName}`, async () => {
    test.setTimeout(180_000);
    mkdirSync(SHOTS, { recursive: true });
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
      const photo = join(src, 'Paisaje.jpg');
      await writePhoto(photo, 9, { width: 800, height: 500 });
      expect((await importAndSummarize(page, app, [photo])).imported).toBe(1);
      await expect
        .poll(() =>
          page
            .getByRole('grid', { name: 'Galería' })
            .evaluate((el) =>
              Array.from(el.querySelectorAll('img')).every((i) => i.naturalWidth > 0),
            ),
        )
        .toBe(true);

      await gridCells(page).nth(0).click();
      await openEditor(page);
      // Un recorte con el teclado: la esquina inferior derecha, con el foco visible en esa asa.
      await tabTo(page, 'Esquina inferior derecha del recorte');
      for (let i = 0; i < 2; i += 1) {
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Shift+ArrowUp');
      }
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `editor-crop-${label}.png`) });
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
