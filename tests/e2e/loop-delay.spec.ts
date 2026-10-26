// Carga del hilo main durante importaciones grandes (docs/PLAN.md 2.14, R6). Solo con
// GALERIA_SLOW_TESTS=1: con el medidor `perf_hooks.monitorEventLoopDelay()` (activo solo con
// GALERIA_E2E=1, session-manager.ts) importa 500 fotos y el MP4 de más de 1 GiB y escribe el p99 y el
// máximo en tests/.tmp/loop-delay.json para anotarlos en "Notas sobre el diseño". Si algún bloqueo
// supera 100 ms seguidos, el plan B de §3 (utilityProcess) se abre como tarea nueva (no se implementa).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import {
  FIXTURES_DIR,
  importAndSummarize,
  launchUnlocked,
  loadFixtures,
  newSourceDir,
  removeDir,
  writePhoto,
} from './helpers/library';
import { ROOT } from './helpers/launch';

test.skip(process.env.GALERIA_SLOW_TESTS !== '1', 'solo con GALERIA_SLOW_TESTS=1');

interface LoopDelay {
  count: number;
  resolutionMs: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  maxMs: number;
  blockedMs: number;
}

async function resetLoopDelay(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (globalThis as unknown as { __galeriaLoopDelay: { reset(): void } }).__galeriaLoopDelay.reset();
  });
}

async function readLoopDelay(app: ElectronApplication): Promise<LoopDelay> {
  return app.evaluate(
    () =>
      (
        globalThis as unknown as { __galeriaLoopDelay: { snapshot(): LoopDelay } }
      ).__galeriaLoopDelay.snapshot() as LoopDelay,
  );
}

test('R6: p99 y máximo del bucle de eventos del main al importar 500 fotos y 1 GiB de vídeo', async () => {
  test.setTimeout(45 * 60_000);
  const slow = loadFixtures().slow;
  expect(
    slow,
    'falta video-grande.mp4: node tests/fixtures/generate.mjs con GALERIA_SLOW_TESTS=1',
  ).toBeTruthy();
  const launched = await launchUnlocked();
  const src = newSourceDir();
  try {
    const { page, app } = launched;
    const hook = await app.evaluate(
      () => typeof (globalThis as { __galeriaLoopDelay?: unknown }).__galeriaLoopDelay,
    );
    expect(hook, 'el medidor solo existe con GALERIA_E2E=1').toBe('object');

    // 500 fotos (JPEG de 2000×1500, color y tamaño distintos para que ninguna sea duplicada).
    const photosDir = join(src, 'fotos');
    mkdirSync(photosDir, { recursive: true });
    const photos: string[] = [];
    for (let i = 0; i < 500; i++) {
      const p = join(photosDir, `foto-${String(i).padStart(3, '0')}.jpg`);
      await writePhoto(p, i + 1, { width: 2000, height: 1500 });
      photos.push(p);
    }

    await resetLoopDelay(app);
    const photoCounts = await importAndSummarize(page, app, [photosDir], 'folder', 20 * 60_000);
    const photoDelay = await readLoopDelay(app);
    console.log(`[e2e] 500 fotos: ${JSON.stringify(photoDelay)} ${JSON.stringify(photoCounts)}`);
    expect(photoCounts).toEqual({ imported: 500, duplicates: 0, skipped: 0, failed: 0 });
    for (const p of photos) expect(existsSync(p), p).toBe(false);

    // MP4 de más de 1 GiB.
    const video = join(src, 'video-grande.mp4');
    copyFileSync(join(FIXTURES_DIR, (slow as { file: string }).file), video);
    await resetLoopDelay(app);
    const videoCounts = await importAndSummarize(page, app, [video], 'files', 30 * 60_000);
    const videoDelay = await readLoopDelay(app);
    console.log(`[e2e] vídeo 1 GiB: ${JSON.stringify(videoDelay)} ${JSON.stringify(videoCounts)}`);
    expect(videoCounts).toEqual({ imported: 1, duplicates: 0, skipped: 0, failed: 0 });
    expect(existsSync(video)).toBe(false);

    const out = join(ROOT, 'tests', '.tmp', 'loop-delay.json');
    writeFileSync(
      out,
      JSON.stringify(
        { photos: { ...photoDelay, files: 500 }, video: { ...videoDelay, bytes: slow?.bytes } },
        null,
        2,
      ),
    );
    // El umbral de R6 no hace fallar el test: la cifra se anota y, si lo supera, se abre el plan B.
    console.log(
      `[e2e] bloqueo máximo: fotos ${photoDelay.blockedMs} ms, vídeo ${videoDelay.blockedMs} ms (umbral 100 ms)`,
    );
  } finally {
    removeDir(src);
    await launched.close();
  }
});
