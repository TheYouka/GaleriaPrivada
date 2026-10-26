// Bloqueo durante una importación (docs/PLAN.md 2.13; docs/DESIGN.md §12.4 "Bloquear", §13.3 y
// [H3-6]). Solo con GALERIA_SLOW_TESTS=1: importa el MP4 de más de 1 GiB y, a mitad,
// `powerMonitor.emit('suspend')`. Las claves se ponen a cero en ≤ 200 ms, el original conserva su
// SHA-256, y tras desbloquear no quedan `.part` en tmp/ ni filas `pending` (se comprueba volviendo a
// importar el mismo archivo, que una fila `pending` con su content_hmac impediría) y el vídeo no aparece
// hasta que esa importación termina.
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  filesUnder,
  FIXTURES_DIR,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  loadFixtures,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  startImportFromMenu,
  importPanel,
  sha256File,
} from './helpers/library';
import { lockAndGetNewWindow, readProfilesJson, unlockProfile } from './helpers/launch';

test.skip(process.env.GALERIA_SLOW_TESTS !== '1', 'solo con GALERIA_SLOW_TESTS=1');

test('suspend a mitad de la importación de 1 GiB: claves a cero, original intacto y estado coherente al desbloquear', async () => {
  test.setTimeout(30 * 60_000);
  const slow = loadFixtures().slow;
  expect(
    slow,
    'falta video-grande.mp4: node tests/fixtures/generate.mjs con GALERIA_SLOW_TESTS=1',
  ).toBeTruthy();
  const launched = await launchUnlocked();
  const src = newSourceDir();
  try {
    const original = join(src, 'video-grande.mp4');
    copyFileSync(join(FIXTURES_DIR, (slow as { file: string }).file), original);
    const hash = sha256File(original);
    let { page } = launched;

    await startImportFromMenu(page, launched.app, [original]);
    // Ya está cifrando: el trabajo lleva su tiempo con 1 GiB.
    await expect(
      importPanel(page).locator('p[aria-hidden="true"]', { hasText: 'Cifrando…' }),
    ).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(1_500);
    await expect(importPanel(page).getByRole('button', { name: 'Cancelar' })).toBeVisible();

    page = await lockAndGetNewWindow(launched.app, () =>
      launched.app.evaluate(({ powerMonitor }) => {
        (powerMonitor as unknown as { emit(e: string): boolean }).emit('suspend');
      }),
    );
    const zeroizeMs = await launched.app.evaluate(
      () => (globalThis as unknown as { __galeriaLastZeroizeMs?: number }).__galeriaLastZeroizeMs,
    );
    console.log(`[e2e] __galeriaLastZeroizeMs = ${zeroizeMs}`);
    expect(zeroizeMs).toBeDefined();
    expect(zeroizeMs as number).toBeLessThanOrEqual(200);

    // El original no se tocó.
    expect(existsSync(original)).toBe(true);
    expect(sha256File(original)).toBe(hash);

    // Desbloquear: la reconciliación deja la bóveda coherente.
    await unlockProfile(page, PROFILE, PASSWORD);
    await expect(page.getByText('Tu bóveda está vacía.')).toBeVisible({ timeout: 60_000 });
    await expect(gridCells(page)).toHaveCount(0);
    const profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
    const tmp = join(launched.dataDir, 'vaults', profileId, 'tmp');
    await expect
      .poll(() => filesUnder(tmp).filter((f) => f.endsWith('.part')), { timeout: 60_000 })
      .toEqual([]);

    // Sin ninguna fila `pending` que estorbe: la misma importación vuelve a funcionar y borra el original.
    const counts = await importAndSummarize(page, launched.app, [original], 'files', 20 * 60_000);
    expect(counts).toEqual({ imported: 1, duplicates: 0, skipped: 0, failed: 0 });
    expect(existsSync(original)).toBe(false);
    await expect(gridCells(page)).toHaveCount(1);
  } finally {
    removeDir(src);
    await launched.close();
  }
});
