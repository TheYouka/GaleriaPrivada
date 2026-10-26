// Sin temporales en claro fuera de la bóveda (docs/PLAN.md 2.9 y 2.13; docs/DESIGN.md §12.4 y §22).
// La app arranca con TEMP/TMP/TMPDIR apuntando a una carpeta vacía propia; se importa un MP4 tal
// cual, un MKV remultiplexado, un MOV convertido (ffmpeg) y fotos (libvips), y al terminar no puede
// haber ninguna entrada nueva en esa carpeta (ni en `os.tmpdir()` de la app).
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  closeSummary,
  copyFixture,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  removeDir,
  startImportFromMenu,
  waitForSummary,
} from './helpers/library';
import { type LaunchedApp } from './helpers/launch';

const TEMP_ROOT = resolve(__dirname, '..', '.tmp', 'e2e-temp');

let launched: LaunchedApp;
let src: string;
let tempDir: string;

test.beforeEach(async () => {
  tempDir = join(TEMP_ROOT, randomUUID());
  mkdirSync(tempDir, { recursive: true });
  launched = await launchUnlocked({ env: { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir } });
  src = newSourceDir();
});

test.afterEach(async () => {
  removeDir(src);
  await launched?.close();
  removeDir(tempDir);
});

function listing(): string[] {
  return existsSync(tempDir) ? readdirSync(tempDir).sort() : [];
}

test('importar MP4, MKV remultiplexado, MOV convertido y fotos no deja temporales en TEMP', async () => {
  test.setTimeout(180_000);
  const { page, app } = launched;

  // La app usa de verdad esa carpeta como temporal (si no, la comprobación no demostraría nada).
  const appTmp = await app.evaluate(({ app: electronApp }) => electronApp.getPath('temp'));
  expect(resolve(appTmp).toLowerCase()).toBe(resolve(tempDir).toLowerCase());

  const before = listing();

  // MP4 tal cual, MKV remultiplexado y fotos: no piden confirmación.
  const plain = ['mp4Vp9Opus', 'mkvVp9Opus', 'jpeg', 'png'].map((k) => copyFixture(k, src));
  const counts = await importAndSummarize(page, app, plain);
  expect(counts).toEqual({ imported: 4, duplicates: 0, skipped: 0, failed: 0 });
  for (const f of plain) expect(existsSync(f), f).toBe(false);

  // MOV (MPEG-4): conversión con pérdida, con la confirmación de D8.
  const mov = copyFixture('movMpeg4', src);
  await startImportFromMenu(page, app, [mov]);
  const dialog = page.getByRole('alertdialog', { name: 'Convertir vídeos' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Convertir y borrar originales' }).click();
  const converted = await waitForSummary(page, 120_000);
  expect(converted).toEqual({ imported: 1, duplicates: 0, skipped: 0, failed: 0 });
  await closeSummary(page);
  expect(existsSync(mov)).toBe(false);
  await expect(gridCells(page)).toHaveCount(5);

  expect(listing()).toEqual(before);
});
