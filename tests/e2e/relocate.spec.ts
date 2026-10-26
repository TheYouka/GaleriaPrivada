// Traslado de la bóveda (docs/PLAN.md 2.13; docs/DESIGN.md §8.7 y §14.9): mover la bóveda a otra
// carpeta de tests/.tmp y volver a la ubicación predeterminada desde Ajustes → Almacenamiento; la
// galería sigue igual (mismos elementos, miniaturas y vídeos que se reproducen) tras cada traslado.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  cellNames,
  copyFixture,
  expectItemCount,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  mockOpenDialog,
  newSourceDir,
  removeDir,
} from './helpers/library';
import { ROOT, readProfilesJson, type LaunchedApp } from './helpers/launch';

let launched: LaunchedApp;
let src: string;
let target: string;

test.beforeEach(async () => {
  launched = await launchUnlocked();
  src = newSourceDir();
  // La carpeta que devolvería el diálogo nativo: tiene que existir.
  target = join(ROOT, 'tests', '.tmp', 'e2e-reloc', `destino-${Date.now()}`);
  mkdirSync(target, { recursive: true });
});

test.afterEach(async () => {
  removeDir(src);
  removeDir(target);
  await launched?.close();
});

async function thumbnailsLoaded(page: Page): Promise<boolean> {
  return page.getByRole('grid', { name: 'Galería' }).evaluate((grid) => {
    const imgs = Array.from(grid.querySelectorAll('img'));
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  });
}

async function openStorage(page: Page): Promise<void> {
  await page.keyboard.press('Control+Comma');
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
  await page.getByRole('tab', { name: 'Almacenamiento' }).click();
  await expect(page.getByText('Espacio libre')).toBeVisible();
}

test('mover la bóveda a otra carpeta y volver a la predeterminada deja la galería igual', async () => {
  test.setTimeout(120_000);
  const { page, app, dataDir } = launched;
  const profileId = readProfilesJson(dataDir).profiles[0]?.id ?? '';
  const defaultVault = join(dataDir, 'vaults', profileId);

  const paths = ['jpeg', 'png', 'webp', 'mp4Vp9Opus'].map((k) => copyFixture(k, src));
  expect((await importAndSummarize(page, app, paths)).imported).toBe(4);
  await expectItemCount(page, 4);
  const before = (await cellNames(page)).sort();
  await expect.poll(() => thumbnailsLoaded(page)).toBe(true);
  expect(existsSync(join(defaultVault, 'vault.json'))).toBe(true);

  // Ida: a una carpeta elegida con el diálogo nativo (simulado).
  await openStorage(page);
  await expect(page.getByText('Predeterminada', { exact: true })).toBeVisible();
  await mockOpenDialog(app, [target]);
  await page.getByRole('button', { name: 'Mover bóveda…' }).click();
  await expect(page.getByText('La bóveda se ha movido.', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Personalizada', { exact: true })).toBeVisible();
  const moved = readdirSync(target).filter((n) => n.startsWith('Galeria-'));
  expect(moved).toHaveLength(1);
  const movedDir = join(target, moved[0] as string);
  expect(existsSync(join(movedDir, 'vault.json'))).toBe(true);
  expect(existsSync(join(movedDir, 'library.db'))).toBe(true);
  expect(existsSync(defaultVault)).toBe(false);
  await expect(page.getByText(movedDir, { exact: true })).toBeVisible();

  // La galería sigue igual: mismos elementos, con miniatura.
  await page.getByRole('button', { name: 'Todo', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  await expectItemCount(page, 4);
  expect((await cellNames(page)).sort()).toEqual(before);
  await expect(gridCells(page)).toHaveCount(4);
  await expect.poll(() => thumbnailsLoaded(page)).toBe(true);

  // Vuelta: a la ubicación predeterminada.
  await openStorage(page);
  await page.getByRole('button', { name: 'Volver a la ubicación predeterminada' }).click();
  await expect(page.getByText('La bóveda se ha movido.', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Predeterminada', { exact: true })).toBeVisible();
  expect(existsSync(join(defaultVault, 'vault.json'))).toBe(true);
  expect(existsSync(movedDir)).toBe(false);

  await page.getByRole('button', { name: 'Todo', exact: true }).click();
  await expectItemCount(page, 4);
  expect((await cellNames(page)).sort()).toEqual(before);
  await expect.poll(() => thumbnailsLoaded(page)).toBe(true);
});
