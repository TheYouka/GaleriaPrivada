// Galería (docs/PLAN.md 2.13; docs/DESIGN.md §14.6): agrupación por mes, búsqueda con acentos,
// filtros de tipo y fecha, los cinco órdenes (y que se guarda), selección con Ctrl, Shift, Ctrl+A y
// teclado, renombrar con F2 y borrar con Supr y confirmación (los objetos desaparecen del disco).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  cellNames,
  copyFixture,
  expectItemCount,
  filesUnder,
  fixture,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
} from './helpers/library';
import {
  lockAndGetNewWindow,
  readProfilesJson,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';

test.describe.configure({ mode: 'serial' });

interface Photo {
  file: string;
  name: string;
  date: Date;
  format: 'jpeg' | 'png';
}

// La ventana es alta para que la rejilla virtualizada monte todas las filas de este conjunto pequeño.
// Las fechas de captura salen del mtime (las fotos sintéticas no llevan EXIF): hora de pared local.
const PHOTOS: Photo[] = [
  {
    file: 'Álbum de Sevilla.jpg',
    name: 'Álbum de Sevilla',
    date: new Date(2022, 0, 15, 10),
    format: 'jpeg',
  },
  { file: 'Playa.jpg', name: 'Playa', date: new Date(2023, 2, 5, 10), format: 'jpeg' },
  { file: 'Cumpleaños.png', name: 'Cumpleaños', date: new Date(2023, 2, 20, 10), format: 'png' },
  { file: 'Zorro.jpg', name: 'Zorro', date: new Date(2024, 4, 17, 10), format: 'jpeg' },
  { file: 'Atardecer 2.jpg', name: 'Atardecer 2', date: new Date(2024, 4, 30, 10), format: 'jpeg' },
  {
    file: 'Atardecer 10.jpg',
    name: 'Atardecer 10',
    date: new Date(2025, 11, 1, 10),
    format: 'jpeg',
  },
];

let launched: LaunchedApp;
let page: Page;
let src: string;
/** Tamaño en bytes de cada medio por nombre (para comprobar el orden por tamaño). */
const sizes = new Map<string, number>();

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const VIDEO = 'video-vp9-opus';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  launched = await launchUnlocked({}, { width: 1280, height: 1300 });
  page = launched.page;
  src = newSourceDir();
  const paths: string[] = [];
  for (const [i, photo] of PHOTOS.entries()) {
    const path = join(src, photo.file);
    await writePhoto(path, i + 3, { mtime: photo.date, format: photo.format });
    sizes.set(photo.name, statSync(path).size);
    paths.push(path);
  }
  // Fotos primero y vídeos después: la fecha de importación separa los dos grupos.
  expect((await importAndSummarize(page, launched.app, paths)).imported).toBe(6);
  await page.waitForTimeout(50);
  const videos = [copyFixture('mp4Vp9Opus', src), copyFixture('webmVp9Opus', src)];
  sizes.set(VIDEO, fixture('mp4Vp9Opus').bytes);
  expect((await importAndSummarize(page, launched.app, videos)).imported).toBe(2);
  await expectItemCount(page, 8);
});

test.afterAll(async () => {
  removeDir(src);
  await launched?.close();
});

const search = (): ReturnType<Page['getByRole']> => page.getByRole('searchbox', { name: 'Buscar' });

async function chooseSort(label: string): Promise<void> {
  await page.getByRole('button', { name: 'Ordenar' }).click();
  await page.getByRole('menuitemradio', { name: label }).click();
}

async function setSort(field: string, dir: 'Ascendente' | 'Descendente'): Promise<void> {
  await chooseSort(field);
  await chooseSort(dir);
}

test('por defecto ordena por fecha de captura (descendente) y agrupa por mes', async () => {
  const names = await cellNames(page);
  expect(names.slice(2)).toEqual([
    'Atardecer 10',
    'Atardecer 2',
    'Zorro',
    'Cumpleaños',
    'Playa',
    'Álbum de Sevilla',
  ]);
  const grid = page.getByRole('grid', { name: 'Galería' });
  for (const month of ['diciembre de 2025', 'mayo de 2024', 'marzo de 2023', 'enero de 2022']) {
    await expect(grid.getByRole('rowheader', { name: month })).toBeVisible();
  }
  // Una sola parada de Tab (roving tabindex).
  await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  await expect(grid).toHaveAttribute('aria-multiselectable', 'true');
});

test('búsqueda sin distinguir acentos ni mayúsculas, con debounce, y Esc la limpia', async () => {
  await search().fill('album');
  await expectItemCount(page, 1);
  await expect.poll(() => cellNames(page)).toEqual(['Álbum de Sevilla']);
  await search().fill('ATARDECER');
  await expectItemCount(page, 2);
  await search().fill('cumpleanos');
  await expect.poll(() => cellNames(page)).toEqual(['Cumpleaños']);
  await search().fill('zzz-no-existe');
  await expect(page.getByText('No hay ningún elemento que coincida')).toBeVisible();
  await search().press('Escape');
  await expect(search()).toHaveValue('');
  await expectItemCount(page, 8);
});

test('filtros de tipo y de fechas, con chips que se quitan', async () => {
  await page.getByRole('button', { name: /^Filtros/ }).click();
  const popover = page.getByRole('dialog', { name: 'Filtros de la galería' });
  await popover.getByRole('radio', { name: 'Vídeos' }).click();
  await expectItemCount(page, 2);
  await expect(
    page.getByRole('list', { name: 'Filtros activos' }).getByText('Vídeos'),
  ).toBeVisible();
  await popover.getByRole('radio', { name: 'Fotos' }).click();
  await expectItemCount(page, 6);

  await popover.getByLabel('Desde').fill('2023-03-01');
  await popover.getByLabel('Hasta').fill('2023-12-31');
  await expectItemCount(page, 2);
  await expect.poll(async () => (await cellNames(page)).sort()).toEqual(['Cumpleaños', 'Playa']);
  const chips = page.getByRole('list', { name: 'Filtros activos' });
  await expect(chips.getByText('Desde 1 de marzo de 2023')).toBeVisible();

  // "Desde" posterior a "hasta" no se envía y avisa.
  await popover.getByLabel('Desde').fill('2024-01-01');
  await expect(popover.getByRole('alert')).toBeVisible();
  await popover.getByLabel('Desde').fill('2023-03-01');

  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await chips.getByRole('button', { name: /Quitar filtro: Desde/ }).click();
  await chips.getByRole('button', { name: /Quitar filtro: Hasta/ }).click();
  await chips.getByRole('button', { name: /Quitar filtro: Fotos/ }).click();
  await expectItemCount(page, 8);
  await expect(chips).toBeHidden();
});

test('los cinco órdenes, ascendente y descendente (las fotos sin duración van al final en los dos sentidos)', async () => {
  const all = [...PHOTOS.map((p) => p.name), VIDEO, VIDEO];
  const sizeOf = (names: string[]): number[] => names.map((n) => sizes.get(n) ?? 0);

  // Nombre (orden natural en español: "Atardecer 2" antes que "Atardecer 10").
  await setSort('Nombre', 'Ascendente');
  const byName = [...all].sort(collator.compare);
  await expect.poll(() => cellNames(page)).toEqual(byName);
  expect(byName.slice(0, 3)).toEqual(['Álbum de Sevilla', 'Atardecer 2', 'Atardecer 10']);
  await setSort('Nombre', 'Descendente');
  await expect.poll(() => cellNames(page)).toEqual([...byName].reverse());

  // Tamaño.
  const ascending = sizeOf(all).sort((a, b) => a - b);
  await setSort('Tamaño', 'Ascendente');
  await expect.poll(async () => sizeOf(await cellNames(page))).toEqual(ascending);
  await setSort('Tamaño', 'Descendente');
  await expect.poll(async () => sizeOf(await cellNames(page))).toEqual([...ascending].reverse());

  // Duración: los dos vídeos (4 s) y después las fotos (sin duración), en los dos sentidos.
  for (const dir of ['Ascendente', 'Descendente'] as const) {
    await setSort('Duración', dir);
    await expect.poll(async () => (await cellNames(page)).slice(0, 2)).toEqual([VIDEO, VIDEO]);
    expect((await cellNames(page)).slice(2)).toHaveLength(6);
  }

  // Fecha de importación: las fotos se importaron antes que los vídeos.
  await setSort('Fecha de importación', 'Descendente');
  await expect.poll(async () => (await cellNames(page)).slice(0, 2)).toEqual([VIDEO, VIDEO]);
  // Con este orden se agrupa por mes de importación (una sola cabecera: todo se importó hoy).
  await expect(page.getByRole('grid', { name: 'Galería' }).getByRole('rowheader')).toHaveCount(1);
  await setSort('Fecha de importación', 'Ascendente');
  await expect.poll(async () => (await cellNames(page)).slice(-2)).toEqual([VIDEO, VIDEO]);

  // Fecha de captura.
  await setSort('Fecha de captura', 'Ascendente');
  await expect
    .poll(async () => (await cellNames(page)).slice(0, 5))
    .toEqual(['Álbum de Sevilla', 'Playa', 'Cumpleaños', 'Zorro', 'Atardecer 2']);
  await setSort('Fecha de captura', 'Descendente');
  await expect
    .poll(async () => (await cellNames(page)).slice(2))
    .toEqual(['Atardecer 10', 'Atardecer 2', 'Zorro', 'Cumpleaños', 'Playa', 'Álbum de Sevilla']);
});
test('el tamaño de las miniaturas cambia las columnas', async () => {
  const width = async (): Promise<number> =>
    (await gridCells(page).first().boundingBox())?.width ?? 0;
  expect(await width()).toBe(180);
  await page.getByRole('button', { name: 'Tamaño' }).click();
  await page.getByRole('menuitemradio', { name: 'Pequeño' }).click();
  await expect.poll(width).toBe(120);
  await page.getByRole('button', { name: 'Tamaño' }).click();
  await page.getByRole('menuitemradio', { name: 'Grande' }).click();
  await expect.poll(width).toBe(260);
  await page.getByRole('button', { name: 'Tamaño' }).click();
  await page.getByRole('menuitemradio', { name: 'Mediano' }).click();
  await expect.poll(width).toBe(180);
});

test('selección con clic, Ctrl, Shift y Ctrl+A; Esc la limpia', async () => {
  const cells = gridCells(page);
  const selected = page.getByRole('gridcell', { selected: true });
  // Un clic abre el visor (§14.6): la selección se hace con Ctrl+clic, la casilla o Espacio.
  await cells.nth(2).click({ modifiers: ['Control'] });
  await expect(selected).toHaveCount(1);
  await cells.nth(4).click({ modifiers: ['Control'] });
  await expect(selected).toHaveCount(2);
  await cells.nth(2).click({ modifiers: ['Control'] });
  await expect(selected).toHaveCount(1);
  await expect(page.getByText('1 seleccionado', { exact: true })).toBeVisible();

  // Mayús+clic: el rango desde el ancla (la última celda tocada con Ctrl, la 2), en el orden actual.
  await cells.nth(7).click({ modifiers: ['Shift'] });
  await expect(selected).toHaveCount(6);
  await expect(cells.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(cells.nth(7)).toHaveAttribute('aria-selected', 'true');
  await expect(cells.nth(1)).toHaveAttribute('aria-selected', 'false');

  await cells.nth(0).focus();
  await page.keyboard.press('Control+A');
  await expect(selected).toHaveCount(8);
  await expect(page.getByText('8 seleccionados', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(selected).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Selección' })).toBeHidden();
});

test('selección con el teclado: flechas, Espacio y Mayús+flechas', async () => {
  const cells = gridCells(page);
  const selected = page.getByRole('gridcell', { selected: true });
  await cells.nth(0).click({ modifiers: ['Control'] });
  await page.keyboard.press('Escape');
  await expect(selected).toHaveCount(0);
  await expect(cells.nth(0)).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(cells.nth(1)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(cells.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(selected).toHaveCount(3); // el rango 1..3 desde el ancla
  await expect(cells.nth(3)).toBeFocused();
  await page.keyboard.press('Control+End');
  await expect(cells.nth(7)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('gridcell').and(page.locator(':focus'))).toHaveCount(1);
  await page.keyboard.press('Control+Home');
  await expect(cells.nth(0)).toBeFocused();
  await page.keyboard.press('Escape');

  // Presentación y Vídeo dual no están disponibles todavía: deshabilitados con su tooltip.
  await cells.nth(0).click({ modifiers: ['Control'] });
  const presentation = page.getByRole('button', { name: 'Presentación' });
  await expect(presentation).toHaveAttribute('aria-disabled', 'true');
  await presentation.focus();
  await expect(page.getByRole('tooltip', { name: 'Disponible próximamente' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Selección' }).getByRole('button', { name: 'Vídeo dual' }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await cells.nth(0).click({ modifiers: ['Control'] });
  await page.keyboard.press('Escape');
});

test('renombrar con F2: el diálogo valida y guarda con Enter', async () => {
  const zorro = page.getByRole('gridcell', { name: 'Zorro', exact: true });
  await zorro.focus();
  await page.keyboard.press('F2');
  const dialog = page.getByRole('dialog', { name: 'Renombrar' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel('Nombre');
  await expect(input).toHaveValue('Zorro');
  await expect(input).toBeFocused();
  await expect(dialog.getByText('.jpg')).toBeVisible();

  await input.fill('   ');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('Escribe un nombre.');
  await input.fill('Zorro rojo');
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: 'Zorro rojo', exact: true })).toBeVisible();
  // El foco vuelve a la rejilla.
  await expect(page.getByRole('grid', { name: 'Galería' }).locator(':focus')).toHaveCount(1);
  // La búsqueda ve el nombre nuevo.
  await search().fill('rojo');
  await expectItemCount(page, 1);
  await search().press('Escape');
  await expectItemCount(page, 8);

  // Con la barra de selección también, y solo con un elemento.
  await page
    .getByRole('gridcell', { name: 'Zorro rojo', exact: true })
    .click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Renombrar' }).click();
  await dialog.getByLabel('Nombre').fill('Zorro');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('gridcell', { name: 'Zorro', exact: true })).toBeVisible();
  await gridCells(page)
    .nth(3)
    .click({ modifiers: ['Control'] });
  await expect(page.getByRole('button', { name: 'Renombrar' })).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('borrar con Supr: confirmación con el foco en "Cancelar", permanente, y los objetos desaparecen del disco', async () => {
  const profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
  const vault = join(launched.dataDir, 'vaults', profileId);
  const count = (dir: string): number => filesUnder(join(vault, dir)).length;
  expect(count('objects')).toBe(8);
  expect(count('thumbs')).toBe(8);

  const cells = gridCells(page);
  await cells.nth(2).click({ modifiers: ['Control'] });
  await cells.nth(3).click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('alertdialog', { name: '¿Eliminar 2 elementos?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await expect(dialog.getByText(/permanente/)).toBeVisible();

  // Cancelar (Esc) no borra nada y el foco vuelve a la rejilla.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expectItemCount(page, 8);
  expect(count('objects')).toBe(8);
  await expect(page.getByRole('grid', { name: 'Galería' }).locator(':focus')).toHaveCount(1);

  await page.keyboard.press('Delete');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Eliminar' }).click();
  await expect(dialog).toBeHidden();
  await expectItemCount(page, 6);
  await expect(page.getByText('6 elementos')).toBeVisible();
  await expect.poll(() => count('objects')).toBe(6);
  await expect.poll(() => count('thumbs')).toBe(6);
  // El foco queda en una celda que existe.
  await expect(page.getByRole('grid', { name: 'Galería' }).locator(':focus')).toHaveCount(1);
});

test('menú contextual: clic derecho selecciona y ofrece las acciones; Eliminar pide confirmación', async () => {
  const cell = gridCells(page).nth(1);
  await cell.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^Renombrar/ })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: /^Eliminar/ })).toBeVisible();
  // Con el menú abierto el resto de la página queda oculto para los roles: se mira por CSS.
  await expect(page.locator('[role="gridcell"]').nth(1)).toHaveAttribute('aria-selected', 'true');
  await menu.getByRole('menuitem', { name: /^Eliminar/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expectItemCount(page, 6);
  await page.keyboard.press('Escape');
});

test('el orden elegido se guarda en las preferencias del perfil (sobrevive a bloquear y desbloquear)', async () => {
  await chooseSort('Nombre');
  await page.getByRole('button', { name: 'Ordenar' }).click();
  await page.getByRole('menuitemradio', { name: 'Ascendente' }).click();
  await page.keyboard.press('Escape');

  page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
  await unlockProfile(page, PROFILE, PASSWORD);
  await expectItemCount(page, 6);
  await page.getByRole('button', { name: 'Ordenar' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Nombre' })).toBeChecked();
  await expect(page.getByRole('menuitemradio', { name: 'Ascendente' })).toBeChecked();
  await page.keyboard.press('Escape');
});
