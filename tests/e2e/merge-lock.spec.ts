// Fusión y bloqueo (docs/PLAN.md 5.3 y 5.5; docs/DESIGN.md §18.1, §18.7, §13.3; D18 confirmada por
// el usuario). Con GALERIA_E2E=1:
//   - durante la fusión `__galeriaAutoLockReasons` contiene 'job' (el bloqueo por inactividad está
//     en pausa) y al terminar ya no;
//   - `powerMonitor.emit('suspend')` a mitad bloquea al momento (claves a cero en ≤ 200 ms), cancela
//     la fusión, no deja `.part` en tmp/ y, al volver a entrar, el vídeo fusionado no existe.
// La pantalla de vídeo dual (5.4) aún no existe: la fusión se lanza por el preload real.
import { expect, test } from '@playwright/test';
import {
  expectItemCount,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
} from './helpers/library';
import {
  lockAndGetNewWindow,
  readProfilesJson,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';
import {
  expectMerged,
  mediaIdByName,
  partsIn,
  startMerge,
  waitMergeDone,
  writeMergeInputs,
} from './helpers/merge';
import { autoLockReasons } from './helpers/presentation';

let launched: LaunchedApp;
let src: string;
let leftId: string;
let rightId: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  launched = await launchUnlocked();
  src = newSourceDir();
  // 40 s a baja resolución: la fusión dura varios segundos (VP9 en CPU), lo justo para bloquear a mitad.
  const { left, right } = writeMergeInputs(src, {
    left: { name: 'Lado A', seconds: 40 },
    right: { name: 'Lado B', seconds: 40 },
  });
  const counts = await importAndSummarize(launched.page, launched.app, [left, right]);
  expect(counts).toEqual({ imported: 2, duplicates: 0, skipped: 0, failed: 0 });
  leftId = await mediaIdByName(launched.page, 'Lado A');
  rightId = await mediaIdByName(launched.page, 'Lado B');
});

test.afterAll(async () => {
  removeDir(src);
  await launched?.close();
});

test("D18: durante la fusión __galeriaAutoLockReasons contiene 'job' y al terminar ya no", async () => {
  test.setTimeout(300_000);
  const { page, app } = launched;
  const start = await startMerge(page, {
    leftId,
    rightId,
    audio: 'left',
    duration: 'shortest',
    resolution: 'auto',
    name: 'Fusión D18',
  });
  expect(start.ok, JSON.stringify(start)).toBe(true);
  const jobId = (start as { ok: true; data: { jobId: string } }).data.jobId;
  expect(await autoLockReasons(app)).toContain('job');
  // Una segunda fusión mientras tanto → BUSY (§12.11).
  const second = await startMerge(page, {
    leftId: rightId,
    rightId: leftId,
    audio: 'none',
    duration: 'shortest',
    resolution: 'auto',
    name: 'Otra',
  });
  expect(second).toEqual({ ok: false, error: { code: 'BUSY' } });
  const { result, progress } = await waitMergeDone(page, jobId, 240_000);
  const merged = expectMerged({ jobId, start, result, progress });
  expect(merged.existed).toBe(false);
  await expect.poll(() => autoLockReasons(app)).not.toContain('job');
  await expectItemCount(page, 3);
});

test('suspend a mitad de la fusión: bloqueo inmediato, claves a cero, sin .part y sin vídeo fusionado', async () => {
  test.setTimeout(300_000);
  const { app } = launched;
  let { page } = launched;
  const profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
  const start = await startMerge(page, {
    leftId,
    rightId,
    audio: 'mix',
    duration: 'longest',
    resolution: 'auto',
    name: 'Fusión interrumpida',
  });
  expect(start.ok, JSON.stringify(start)).toBe(true);
  // Ya hay salida cifrada en tmp/<id>.part y progreso.
  await expect
    .poll(() => partsIn(launched.dataDir, profileId).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __mergeEvents: { progress: number[] } }).__mergeEvents.progress
              .length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  expect(await autoLockReasons(app)).toContain('job');

  page = await lockAndGetNewWindow(app, () =>
    app.evaluate(({ powerMonitor }) => {
      (powerMonitor as unknown as { emit(e: string): boolean }).emit('suspend');
    }),
  );
  const zeroizeMs = await app.evaluate(
    () => (globalThis as unknown as { __galeriaLastZeroizeMs?: number }).__galeriaLastZeroizeMs,
  );
  console.log(`[e2e] fusión + suspend: __galeriaLastZeroizeMs = ${zeroizeMs}`);
  expect(zeroizeMs).toBeDefined();
  expect(zeroizeMs as number).toBeLessThanOrEqual(200);
  expect(await autoLockReasons(app)).toEqual([]);

  // El .part se borra sin claves (KeylessCleanup) aunque la sesión siga bloqueada.
  await expect.poll(() => partsIn(launched.dataDir, profileId), { timeout: 30_000 }).toEqual([]);

  // Al volver a entrar: los dos de antes y la fusión del primer test; la interrumpida no existe.
  await unlockProfile(page, PROFILE, PASSWORD);
  await expectItemCount(page, 3);
  const names = await page.evaluate(async () => {
    const api = (window as unknown as { galeria: import('@shared/ipc-contract').GaleriaApi })
      .galeria;
    const listed = await api.invoke('media:list', {
      kind: 'all',
      sort: { field: 'name', dir: 'asc' },
    });
    return listed.ok ? listed.data.items.map((i) => i.name) : [];
  });
  expect(names).not.toContain('Fusión interrumpida');
  expect(partsIn(launched.dataDir, profileId)).toEqual([]);
});
