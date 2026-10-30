// Verificación previa del MP4 fragmentado de la fusión (docs/PLAN.md 5.1; docs/DESIGN.md §18.4,
// primera tarea obligatoria de la Fase 5, riesgo R4). Dos vídeos testsrc2 + sine de 20 s y 12 s se
// importan, se fusionan con la línea de comandos exacta de §18.3 (entradas por el loopback, salida
// VP9 + Opus en MP4 fragmentado por pipe:1 hacia el cifrador) y el resultado se reproduce en un
// <video> por vault://media con Range: `duration` finita e igual a D ± 0,5 s y `currentTime = 0,75·D`
// dispara `seeked` en menos de 3 s. Si esto falla, la fase se detiene y §18.4 se reabre.
//
// La pantalla de vídeo dual (5.4) aún no existe: la fusión se lanza por el preload real
// (`merge:start`) y se espera `merge:done`. Además: ningún archivo bajo la raíz de datos contiene los
// primeros 64 bytes de las entradas ni de la salida descifrada (§22).
import { expect, test } from '@playwright/test';
import {
  expectItemCount,
  fixtureNeedles,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  removeDir,
  scanForNeedles,
  type Needle,
} from './helpers/library';
import type { LaunchedApp } from './helpers/launch';
import {
  decryptedHead,
  expectMerged,
  headOf,
  mediaIdByName,
  mergeAndWait,
  playAndSeek,
  writeMergeInputs,
} from './helpers/merge';

let launched: LaunchedApp;
let src: string;
let leftId: string;
let rightId: string;
const needles: Needle[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  launched = await launchUnlocked();
  src = newSourceDir();
  const { left, right } = writeMergeInputs(src, {
    left: { name: 'Izquierdo largo', seconds: 20 },
    right: { name: 'Derecho corto', seconds: 12 },
  });
  needles.push(
    { label: '64 bytes de la entrada izquierda', bytes: headOf(left) },
    { label: '64 bytes de la entrada derecha', bytes: headOf(right) },
  );
  const counts = await importAndSummarize(launched.page, launched.app, [left, right]);
  expect(counts).toEqual({ imported: 2, duplicates: 0, skipped: 0, failed: 0 });
  await expectItemCount(launched.page, 2);
  leftId = await mediaIdByName(launched.page, 'Izquierdo largo');
  rightId = await mediaIdByName(launched.page, 'Derecho corto');
});

let quitted = false;

test.afterAll(async () => {
  removeDir(src);
  if (quitted) launched?.cleanup();
  else await launched?.close();
});

const CASES = [
  { duration: 'shortest', audio: 'mix', seconds: 12, name: 'Fusión corta' },
  { duration: 'longest', audio: 'left', seconds: 20, name: 'Fusión larga' },
] as const;

for (const c of CASES) {
  test(`fusión ${c.audio} + ${c.duration}: MP4 fragmentado con duración finita (${c.seconds} s ± 0,5) y búsqueda al 75 % en menos de 3 s`, async () => {
    test.setTimeout(300_000);
    const { page, app } = launched;
    const t0 = Date.now();
    const outcome = await mergeAndWait(page, {
      leftId,
      rightId,
      audio: c.audio,
      duration: c.duration,
      resolution: 'auto',
      name: c.name,
    });
    const merged = expectMerged(outcome);
    const mergeMs = Date.now() - t0;
    expect(merged.existed).toBe(false);
    expect(outcome.progress.length).toBeGreaterThan(0);
    expect(outcome.progress.at(-1)).toBe(1);

    const playback = await playAndSeek(page, merged.mediaId);
    console.log(
      `[e2e] 5.1 ${c.audio}+${c.duration}: fusión ${mergeMs} ms, ${JSON.stringify(playback)}`,
    );
    expect(playback.mime).toBe('video/mp4');
    expect(Number.isFinite(playback.duration)).toBe(true);
    expect(Math.abs(playback.duration - c.seconds)).toBeLessThanOrEqual(0.5);
    expect(playback.seekedMs).toBeLessThan(3_000);
    expect(Math.abs(playback.seekedTo - playback.duration * 0.75)).toBeLessThan(0.6);
    expect(playback.advanced).toBe(true);
    // hstack de 320×180 y 240×180 a H = 180.
    expect({ width: playback.width, height: playback.height }).toEqual({ width: 560, height: 180 });

    needles.push({
      label: `64 bytes descifrados de ${c.name}`,
      bytes: await decryptedHead(app, merged.mediaId),
    });
  });
}

test('§22: ningún archivo bajo la raíz de datos contiene los primeros 64 bytes de las entradas ni de las fusiones descifradas', async () => {
  test.setTimeout(120_000);
  expect(needles.length).toBe(4);
  // Con la app cerrada (Windows bloquea library.db y el log mientras está abierta).
  await launched.quit();
  quitted = true;
  const { scanned, hits } = scanForNeedles(
    [launched.dataDir, `${launched.dataDir}.electron`],
    [...needles, ...fixtureNeedles([])],
    launched.dataDir,
  );
  console.log(`[e2e] §22 fusión: ${scanned} archivos analizados, ${hits.length} aciertos`);
  expect(scanned).toBeGreaterThan(0);
  expect(hits).toEqual([]);
});
