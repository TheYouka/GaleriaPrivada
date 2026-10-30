// Diálogo de fusión por la interfaz (docs/PLAN.md 5.4 y 5.5; docs/DESIGN.md §18.1 y §18.7): valores
// por defecto (audio «Mezcla», duración «La del más corto», nombre «Fusión AAAA-MM-DD HH.mm» y la
// resolución de salida), progreso, el vídeo nuevo en la galería con la duración del más corto, «Ya
// existía un vídeo idéntico» al repetirla, BUSY con otra fusión en curso y «Cancelar fusión» sin
// dejar nada (ni vídeo ni `.part`). Además, por la interfaz: el vídeo fusionado se reproduce y busca,
// durante la fusión `__galeriaAutoLockReasons` contiene 'job', `powerMonitor.emit('suspend')` a mitad
// la cancela (claves a cero rápido, sin `.part`, sin vídeo) y, con la app cerrada, ningún archivo bajo
// la raíz de datos contiene los primeros 64 bytes de los vídeos de prueba ni de la salida descifrada.
// El backend (comando, loopback, bloqueo) lo prueban también merge-fmp4, merge-lock y los unitarios.
//
// Vídeos de prueba cortos y de baja resolución bajo tests/.tmp/. Ventana discreta (nota 135).
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  lockAndGetNewWindow,
  readProfilesJson,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';
import {
  autoLockReasons,
  dualScreen,
  LEFT_NAME,
  LEFT_SECONDS,
  nav,
  openDualFromNav,
  pickVideo,
  RIGHT_NAME,
  RIGHT_SECONDS,
  waitVideosReady,
} from './helpers/dual';
import {
  fixtureNeedles,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  scanForNeedles,
  type Needle,
} from './helpers/library';
import {
  decryptedHead,
  headOf,
  mediaIdByName,
  partsIn,
  playAndSeek,
  startMerge,
  waitMergeDone,
  writeMergeInputs,
} from './helpers/merge';

test.describe('fusión de vídeos', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;
  let src: string;
  let quitted = false;
  /** Vídeos de la galería antes de fusionar nada (los 2 de la fusión y los 2 de la prueba de suspend). */
  const BASE_VIDEOS = 4;
  const needles: Needle[] = [];

  const dialog = (): Locator => page.getByRole('dialog', { name: 'Crear vídeo fusionado' });
  const openMergeDialog = async (): Promise<void> => {
    await dualScreen(page)
      .getByRole('button', { name: 'Crear vídeo fusionado', exact: true })
      .click();
    await expect(dialog()).toBeVisible();
  };
  const videoCount = async (): Promise<number> => {
    const res = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          galeria: {
            invoke(c: string, r: unknown): Promise<{ ok: boolean; data?: { items: unknown[] } }>;
          };
        }
      ).galeria;
      return api.invoke('media:list', { kind: 'video', sort: { field: 'name', dir: 'asc' } });
    });
    return res.data?.items.length ?? -1;
  };

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    launched = await launchUnlocked({}, { width: 1280, height: 800 });
    page = launched.page;
    src = newSourceDir();
    const main = writeMergeInputs(src, {
      left: { name: LEFT_NAME, seconds: LEFT_SECONDS },
      right: { name: RIGHT_NAME, seconds: RIGHT_SECONDS },
    });
    // 40 s: la fusión dura lo bastante (VP9 en CPU) para suspender a mitad.
    const long = writeMergeInputs(src, {
      left: { name: 'Lado A', seconds: 40 },
      right: { name: 'Lado B', seconds: 40 },
    });
    const paths = [main.left, main.right, long.left, long.right];
    for (const path of paths) needles.push({ label: `64 bytes de ${path}`, bytes: headOf(path) });
    const counts = await importAndSummarize(page, launched.app, paths, 'files', 240_000);
    expect(counts).toEqual({ imported: 4, duplicates: 0, skipped: 0, failed: 0 });
    await openDualFromNav(page);
    await pickVideo(page, 'left', LEFT_NAME);
    await pickVideo(page, 'right', RIGHT_NAME);
    await waitVideosReady(page);
    expect(await videoCount()).toBe(BASE_VIDEOS);
  });

  test.afterAll(async () => {
    if (quitted) launched?.cleanup();
    else await launched?.close();
    if (src) removeDir(src);
  });

  test('valores por defecto, progreso y el vídeo nuevo en la galería con la duración del más corto', async () => {
    test.setTimeout(240_000);
    await openMergeDialog();
    const d = dialog();
    await expect(d.getByRole('radio', { name: 'Mezcla' })).toBeChecked();
    await expect(d.getByRole('radio', { name: 'Izquierdo' })).toBeEnabled();
    await expect(d.getByRole('radio', { name: 'Derecho' })).toBeEnabled();
    await expect(d.getByRole('radio', { name: 'Ninguno' })).toBeEnabled();
    await expect(d.getByRole('radio', { name: 'La del más corto' })).toBeChecked();
    await expect(d.getByRole('radio', { name: 'La del más largo' })).not.toBeChecked();
    await expect(d.getByLabel('Nombre')).toHaveValue(/^Fusión \d{4}-\d{2}-\d{2} \d{2}\.\d{2}$/);
    // 320×180 + 240×180 → 560×180 (altura común del más bajo).
    await expect(d.locator('[data-merge-size]')).toHaveAttribute('data-merge-size', '560 × 180');
    await expect(d).toContainText(`Izquierdo: ${LEFT_NAME}`);
    await expect(d).toContainText(`Derecho: ${RIGHT_NAME}`);

    // Un nombre vacío no se envía.
    await d.getByLabel('Nombre').fill('   ');
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.getByText('Escribe un nombre.')).toBeVisible();
    await d.getByLabel('Nombre').fill('Fusión E2E uno');

    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.getByRole('progressbar')).toBeVisible();
    await expect(d.getByRole('button', { name: 'Cancelar fusión' })).toBeVisible();
    // Durante la fusión ni Esc cierra el diálogo.
    await page.keyboard.press('Escape');
    await expect(d).toBeVisible();

    await expect(d.locator('[data-merge-result]')).toHaveText('Vídeo fusionado creado', {
      timeout: 180_000,
    });
    await d.getByRole('button', { name: 'Ver en la galería' }).click();
    await expect(d).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Vídeos' })).toBeVisible();
    // Aparece como un vídeo más de la galería con la duración del más corto (12 s).
    const merged = page.getByRole('gridcell', { name: /^Fusión E2E uno, vídeo, / });
    await expect(merged).toBeVisible({ timeout: 30_000 });
    await expect(merged).toHaveAttribute('aria-label', /, vídeo, 0:(11|12|13)$/);
    expect(await videoCount()).toBe(BASE_VIDEOS + 1);

    // El vídeo de la galería se reproduce y se busca (MP4 fragmentado por vault://media, §18.4).
    const mergedId = await mediaIdByName(page, 'Fusión E2E uno');
    const playback = await playAndSeek(page, mergedId);
    expect(Number.isFinite(playback.duration)).toBe(true);
    expect(Math.abs(playback.duration - Math.min(LEFT_SECONDS, RIGHT_SECONDS))).toBeLessThanOrEqual(
      0.5,
    );
    expect(playback.seekedMs).toBeLessThan(3_000);
    expect(playback.advanced).toBe(true);
    needles.push({
      label: '64 bytes descifrados de Fusión E2E uno',
      bytes: await decryptedHead(launched.app, mergedId),
    });
  });

  test('repetir la misma fusión muestra «Ya existía un vídeo idéntico» y no crea otro', async () => {
    test.setTimeout(240_000);
    await nav(page).getByRole('button', { name: 'Vídeo dual', exact: true }).first().click();
    await expect(dualScreen(page)).toBeVisible();
    await openMergeDialog();
    const d = dialog();
    await d.getByLabel('Nombre').fill('Fusión E2E dos');
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.locator('[data-merge-result]')).toHaveText('Ya existía un vídeo idéntico', {
      timeout: 180_000,
    });
    await d.getByRole('button', { name: 'Cerrar' }).click();
    await expect(d).toBeHidden();
    expect(await videoCount()).toBe(BASE_VIDEOS + 1);
  });

  test('con otra fusión en curso, «Crear vídeo fusionado» da el aviso de BUSY', async () => {
    test.setTimeout(240_000);
    await nav(page).getByRole('button', { name: 'Vídeo dual', exact: true }).first().click();
    await expect(dualScreen(page)).toBeVisible();
    await waitVideosReady(page);
    // Una fusión lanzada por el preload (la del más largo) ocupa el trabajo único.
    const leftId = await mediaIdByName(page, LEFT_NAME);
    const rightId = await mediaIdByName(page, RIGHT_NAME);
    const started = await startMerge(page, {
      leftId,
      rightId,
      audio: 'mix',
      duration: 'longest',
      resolution: 'auto',
      name: 'Fusión por el preload',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await openMergeDialog();
    const d = dialog();
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.getByRole('alert')).toHaveText(
      'Ya hay una fusión en curso. Espera a que termine.',
    );
    await expect(d.getByRole('progressbar')).toHaveCount(0);
    await d.getByRole('button', { name: 'Cancelar' }).click();
    await expect(d).toBeHidden();

    const done = await waitMergeDone(page, started.data.jobId, 180_000);
    expect(done.result?.ok).toBe(true);
    await expect.poll(videoCount, { timeout: 30_000 }).toBe(BASE_VIDEOS + 2);
  });

  test('elegir 360 px: el vídeo nuevo mide 360 de alto; repetir a 360 px es idéntico', async () => {
    test.setTimeout(360_000);
    await nav(page).getByRole('button', { name: 'Vídeo dual', exact: true }).first().click();
    await expect(dualScreen(page)).toBeVisible();
    await waitVideosReady(page);
    await openMergeDialog();
    let d = dialog();
    // Por defecto «Automática (recomendada)»; las alturas por encima del más alto (180) amplían.
    await expect(d.getByRole('radio', { name: 'Automática (recomendada)' })).toBeChecked();
    for (const name of [
      '360 px (amplía la imagen)',
      '480 px (amplía la imagen)',
      '720 px (amplía la imagen)',
      '1080 px (amplía la imagen)',
    ]) {
      await expect(d.getByRole('radio', { name })).not.toBeChecked();
    }
    await expect(d.locator('[data-merge-size]')).toHaveAttribute('data-merge-size', '560 × 180');
    await d.getByRole('radio', { name: '360 px (amplía la imagen)' }).click();
    // 320×180 y 240×180 escalados a 360 de alto: 640 + 480.
    await expect(d.locator('[data-merge-size]')).toHaveAttribute('data-merge-size', '1120 × 360');
    await d.getByLabel('Nombre').fill('Fusión E2E 360');
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.locator('[data-merge-result]')).toHaveText('Vídeo fusionado creado', {
      timeout: 240_000,
    });
    await d.getByRole('button', { name: 'Cerrar' }).click();
    await expect(d).toBeHidden();
    expect(await videoCount()).toBe(BASE_VIDEOS + 3);

    // El vídeo de la galería mide 360 de alto (y 1120 de ancho).
    const id360 = await mediaIdByName(page, 'Fusión E2E 360');
    const playback = await playAndSeek(page, id360);
    expect(playback.height).toBe(360);
    expect(playback.width).toBe(1120);
    expect(playback.advanced).toBe(true);

    // Repetir a 360 px: idéntico (la resolución es parte de los parámetros).
    await nav(page).getByRole('button', { name: 'Vídeo dual', exact: true }).first().click();
    await expect(dualScreen(page)).toBeVisible();
    await openMergeDialog();
    d = dialog();
    await d.getByRole('radio', { name: '360 px (amplía la imagen)' }).click();
    await d.getByLabel('Nombre').fill('Fusión E2E 360 otra vez');
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.locator('[data-merge-result]')).toHaveText('Ya existía un vídeo idéntico', {
      timeout: 240_000,
    });
    await d.getByRole('button', { name: 'Cerrar' }).click();
    await expect(d).toBeHidden();
    expect(await videoCount()).toBe(BASE_VIDEOS + 3);
  });

  test('«Cancelar fusión» no deja ningún vídeo ni `.part`', async () => {
    test.setTimeout(240_000);
    const profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
    expect(profileId).not.toBe('');
    await openMergeDialog();
    const d = dialog();
    // Audio solo del izquierdo, para no repetir una fusión anterior.
    await d.getByRole('radio', { name: 'Izquierdo' }).click();
    await d.getByLabel('Nombre').fill('Fusión cancelada');
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.getByRole('progressbar')).toBeVisible();
    // D18: con la fusión en curso el bloqueo por inactividad está en pausa.
    expect(await autoLockReasons(launched.app)).toContain('job');
    await d.getByRole('button', { name: 'Cancelar fusión' }).click();
    // Vuelve al formulario con el aviso; no hay vídeo nuevo ni restos en tmp/.
    await expect(d.locator('[data-merge-phase="form"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Fusión cancelada.').first()).toBeVisible();
    await expect.poll(() => partsIn(launched.dataDir, profileId), { timeout: 30_000 }).toEqual([]);
    await d.getByRole('button', { name: 'Cancelar' }).click();
    await expect(d).toBeHidden();
    expect(await videoCount()).toBe(BASE_VIDEOS + 3);
    await expect.poll(() => autoLockReasons(launched.app)).not.toContain('job');
  });

  test('suspend a mitad de una fusión hecha por la interfaz: bloqueo inmediato, claves a cero, sin .part y sin vídeo', async () => {
    test.setTimeout(300_000);
    const { app } = launched;
    const profileId = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
    // Los dos vídeos de 40 s a los lados.
    for (const side of ['left', 'right'] as const) {
      await page
        .getByRole('button', {
          name: `Cambiar el vídeo ${side === 'left' ? 'izquierdo' : 'derecho'}`,
        })
        .click();
      const picker = page.getByRole('dialog', { name: 'Elegir vídeo' });
      await expect(picker).toBeVisible();
      await picker
        .getByRole('button', { name: new RegExp(`^Lado ${side === 'left' ? 'A' : 'B'}`) })
        .click();
      await expect(picker).toBeHidden();
    }
    await waitVideosReady(page);
    await openMergeDialog();
    const d = dialog();
    await d.getByRole('radio', { name: 'La del más largo' }).click();
    await d.getByLabel('Nombre').fill('Fusión interrumpida');
    await d.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
    await expect(d.getByRole('progressbar')).toBeVisible();
    await expect
      .poll(() => partsIn(launched.dataDir, profileId).length, { timeout: 60_000 })
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
    console.log(`[e2e] fusión por la UI + suspend: __galeriaLastZeroizeMs = ${zeroizeMs}`);
    expect(zeroizeMs).toBeDefined();
    expect(zeroizeMs as number).toBeLessThanOrEqual(200);
    expect(await autoLockReasons(app)).toEqual([]);
    await expect.poll(() => partsIn(launched.dataDir, profileId), { timeout: 30_000 }).toEqual([]);

    await unlockProfile(page, PROFILE, PASSWORD);
    expect(await videoCount()).toBe(BASE_VIDEOS + 3);
    expect(partsIn(launched.dataDir, profileId)).toEqual([]);
  });

  test('§22: ningún archivo bajo la raíz de datos contiene los primeros 64 bytes de los vídeos de prueba ni de la fusión descifrada', async () => {
    test.setTimeout(120_000);
    expect(needles.length).toBe(5);
    // Con la app cerrada (Windows bloquea library.db y el log mientras está abierta).
    await launched.quit();
    quitted = true;
    const { scanned, hits } = scanForNeedles(
      [launched.dataDir, `${launched.dataDir}.electron`],
      [...needles, ...fixtureNeedles([])],
      launched.dataDir,
    );
    console.log(
      `[e2e] §22 fusión por la UI: ${scanned} archivos analizados, ${hits.length} aciertos`,
    );
    expect(scanned).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
});
