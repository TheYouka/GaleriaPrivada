// Reproductor de vídeo del visor (docs/PLAN.md 3.6 y 3.7; docs/DESIGN.md §16.6): reproducir y
// pausar, ±10 s, buscar con la barra (vault://media sirve Range), velocidad 0,25× y 2×, bucle, volumen y
// silencio, pantalla completa con F, un recorrido solo con teclado, controles que se ocultan a los
// 2,5 s, el motivo 'playback' del auto-bloqueo (globalThis.__galeriaAutoLockReasons) y las capturas
// en los dos temas (tests/.tmp/screenshots/fase-3/).
//
// Pantalla completa: la ventana de los tests vive fuera de la pantalla y sin robar el foco (nota 135);
// la pantalla completa real la traería delante del usuario. main sustituye setFullScreen e
// isFullScreen por un doble que guarda las llamadas y emite enter/leave-full-screen, así que el
// camino de la interfaz (F, el botón, window:state) es el real y la ventana no se mueve.
import { mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  choosePickerTheme,
  createProfile,
  launchApp,
  lockAndGetNewWindow,
  ROOT,
  unlockProfile,
} from './helpers/launch';
import {
  expectItemCount,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writeLongVideo,
  writePhoto,
} from './helpers/library';
import type { LaunchedApp } from './helpers/launch';

const SHOTS = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-3');
const VIDEO_SECONDS = 40;
const VIDEO_NAME = 'Video largo';

/** Una foto y el vídeo largo; la foto va antes por fecha, para probar ←/→ con el foco en la barra. */
async function writeMedia(dir: string): Promise<string[]> {
  const photo = join(dir, 'Foto previa.jpg');
  await writePhoto(photo, 5, { width: 640, height: 400, mtime: new Date(2025, 5, 1, 12) });
  const video = join(dir, `${VIDEO_NAME}.mp4`);
  writeLongVideo(video, VIDEO_SECONDS);
  utimesSync(video, new Date(2025, 5, 2, 12), new Date(2025, 5, 2, 12));
  return [photo, video];
}

const viewerDialog = (page: Page): Locator => page.locator('[data-viewer]');
const player = (page: Page): Locator => page.locator('[data-player]');
const controls = (page: Page): Locator => page.locator('[data-player-controls]');

interface VideoState {
  t: number;
  d: number;
  paused: boolean;
  ended: boolean;
  rate: number;
  loop: boolean;
  volume: number;
  muted: boolean;
  pitch: boolean;
}

async function videoState(page: Page): Promise<VideoState> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
    if (!v) throw new Error('sin <video>');
    return {
      t: v.currentTime,
      d: v.duration,
      paused: v.paused,
      ended: v.ended,
      rate: v.playbackRate,
      loop: v.loop,
      volume: v.volume,
      muted: v.muted,
      pitch: v.preservesPitch,
    };
  });
}

const timeOf = async (page: Page): Promise<number> => (await videoState(page)).t;

async function waitReady(page: Page): Promise<void> {
  await expect(viewerDialog(page)).toHaveAttribute('data-viewer-state', 'open', {
    timeout: 10_000,
  });
  await expect(player(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

/** Pausa con K (el vídeo empieza solo al abrirse: espera a que suene antes de pausarlo). */
async function pause(page: Page): Promise<void> {
  await expect(player(page)).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  await page.keyboard.press('k');
  await expect(player(page)).toHaveAttribute('data-playing', 'false');
}

test.describe('reproductor', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;
  let src: string;
  let videoIndex = 0;
  let videoLabel = '';
  const responses: { status: number; range?: string; contentRange?: string }[] = [];

  const reasons = (): Promise<string[]> =>
    launched.app.evaluate(
      () =>
        (globalThis as unknown as { __galeriaAutoLockReasons: string[] }).__galeriaAutoLockReasons,
    );
  const displayBlocked = (): Promise<boolean> =>
    launched.app.evaluate(
      () =>
        (globalThis as unknown as { __galeriaDisplaySleepBlocked: boolean })
          .__galeriaDisplaySleepBlocked,
    );
  const fullscreenCalls = (): Promise<boolean[]> =>
    launched.app.evaluate(() =>
      (globalThis as unknown as { __fullscreenCalls: boolean[] }).__fullscreenCalls.slice(),
    );

  async function openVideo(): Promise<void> {
    await gridCells(page).nth(videoIndex).dblclick();
    await waitReady(page);
    // El vídeo empieza solo (autoplay) una vez cargado.
    await expect(player(page)).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  }

  async function closeViewer(): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveCount(0);
  }

  /** Pulsa Tab hasta que el foco cae en `selector` (dentro del visor) y devuelve los nombres recorridos. */
  async function tabTo(selector: string, max = 24): Promise<string[]> {
    const visited: string[] = [];
    for (let i = 0; i < max; i += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate((sel) => {
        const active = document.activeElement;
        return {
          inside: !!active?.closest('[data-viewer]'),
          name: active?.getAttribute('aria-label') ?? active?.textContent ?? '',
          match: !!active?.matches(sel),
        };
      }, selector);
      expect(stop.inside).toBe(true);
      expect(stop.name.length).toBeGreaterThan(0);
      visited.push(stop.name);
      if (stop.match) return visited;
    }
    throw new Error(`Tab no llegó a ${selector}: ${visited.join(' > ')}`);
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    launched = await launchUnlocked({}, { width: 1280, height: 800 });
    page = launched.page;
    src = newSourceDir();
    const counts = await importAndSummarize(
      page,
      launched.app,
      await writeMedia(src),
      'files',
      120_000,
    );
    expect(counts.imported).toBe(2);
    await expectItemCount(page, 2);
    await expect
      .poll(() =>
        page
          .getByRole('grid', { name: 'Galería' })
          .evaluate((g) => Array.from(g.querySelectorAll('img')).every((i) => i.naturalWidth > 0)),
      )
      .toBe(true);
    const labels = await gridCells(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') ?? ''),
    );
    videoIndex = labels.findIndex((l) => l.includes(', vídeo'));
    expect(videoIndex).toBeGreaterThanOrEqual(0);
    videoLabel = labels[videoIndex] ?? '';
    expect(videoLabel).toContain(VIDEO_NAME);

    // Peticiones de vault://media (Range) y pantalla completa simulada (ver la cabecera).
    page.on('response', (response) => {
      if (!response.url().startsWith('vault://media/')) return;
      void response
        .allHeaders()
        .then((headers) =>
          responses.push({
            status: response.status(),
            range: response.request().headers()['range'],
            contentRange: headers['content-range'],
          }),
        )
        .catch(() => undefined);
    });
    await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      let on = false;
      const calls: boolean[] = [];
      (globalThis as unknown as { __fullscreenCalls: boolean[] }).__fullscreenCalls = calls;
      win.isFullScreen = () => on;
      win.setFullScreen = (value: boolean) => {
        calls.push(value);
        on = value;
        win.emit(value ? 'enter-full-screen' : 'leave-full-screen');
      };
    });
  });

  test.afterAll(async () => {
    await launched?.close();
    if (src) removeDir(src);
  });

  test('un doble clic abre el vídeo, empieza solo y pausar/reanudar con Espacio y K; el auto-bloqueo y los fondos lo notan', async () => {
    await expect.poll(reasons).toEqual([]);
    await openVideo();
    const dialog = viewerDialog(page);
    await expect(dialog).toHaveAccessibleName(VIDEO_NAME);
    await expect(page.locator('[data-viewer-thumb]')).toHaveCount(0); // el póster ya no tapa el vídeo
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    const state = await videoState(page);
    expect(Number.isFinite(state.d)).toBe(true);
    expect(Math.abs(state.d - VIDEO_SECONDS)).toBeLessThanOrEqual(0.6);
    await expect(player(page)).toHaveAttribute('data-duration', /^(39|40|41)\./);
    // Sin controles nativos, sin subtítulos, ni descarga ni imagen en imagen.
    const attrs = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
      return {
        controls: v?.controls,
        tracks: v?.querySelectorAll('track').length,
        textTracks: v?.textTracks.length,
        list: v?.getAttribute('controlslist'),
        pip: v?.disablePictureInPicture,
        remote: v?.disableRemotePlayback,
        src: v?.getAttribute('src')?.replace(/[0-9a-f]{32}/, '<id>'),
      };
    });
    expect(attrs).toEqual({
      controls: false,
      tracks: 0,
      textTracks: 0,
      list: 'nodownload noremoteplayback',
      pip: true,
      remote: true,
      src: 'vault://media/<id>',
    });

    // Mientras suena: pausa 'playback' del auto-bloqueo, la pantalla no se apaga y el fondo se pausa.
    await expect.poll(reasons).toContain('playback');
    await expect.poll(displayBlocked).toBe(true);
    await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'true');
    await expect.poll(() => timeOf(page)).toBeGreaterThan(0.3);

    // Espacio pausa: el motivo se suelta y el bloqueador también.
    await page.keyboard.press('Space');
    await expect(player(page)).toHaveAttribute('data-playing', 'false');
    await expect.poll(reasons).toEqual([]);
    await expect.poll(displayBlocked).toBe(false);
    await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'false');
    const frozen = await timeOf(page);
    await page.waitForTimeout(500);
    expect(await timeOf(page)).toBe(frozen);
    await expect(controls(page).getByRole('button', { name: 'Reproducir (K)' })).toBeVisible();

    // K reanuda (mismo motivo otra vez) y el botón pausa.
    await page.keyboard.press('k');
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    await expect.poll(reasons).toContain('playback');
    await expect.poll(() => timeOf(page)).toBeGreaterThan(frozen + 0.2);
    await page.keyboard.press('k');
    await expect(player(page)).toHaveAttribute('data-playing', 'false');
    await expect.poll(reasons).toEqual([]);

    // Reproduciendo y cerrando el visor, el motivo también se suelta.
    await page.keyboard.press('k');
    await expect.poll(reasons).toContain('playback');
    await closeViewer();
    await expect.poll(reasons).toEqual([]);
    await expect.poll(displayBlocked).toBe(false);
  });

  test('±10 s con J/L, Mayús+←/→ y los botones, sin pasar de los extremos', async () => {
    await openVideo();
    await pause(page);

    const t0 = await timeOf(page);
    await page.keyboard.press('l');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0 + 10, 0);
    await page.keyboard.press('j');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0, 0);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0 + 10, 0);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0, 0);
    // El visor no navegó con Mayús+flechas.
    await expect(viewerDialog(page)).toHaveAccessibleName(VIDEO_NAME);

    await controls(page)
      .getByRole('button', { name: /^Avanzar 10 s/ })
      .click();
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0 + 10, 0);
    await controls(page)
      .getByRole('button', { name: /^Retroceder 10 s/ })
      .click();
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0, 0);

    // Los extremos: no baja de 0 ni pasa de la duración.
    for (let i = 0; i < 3; i += 1)
      await controls(page)
        .getByRole('button', { name: /^Retroceder/ })
        .click();
    await expect.poll(() => timeOf(page)).toBe(0);
    await page.keyboard.press('j');
    await expect.poll(() => timeOf(page)).toBe(0);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('l');
    const end = (await videoState(page)).d;
    await expect.poll(() => timeOf(page)).toBeGreaterThan(end - 0.6);
    await expect(player(page)).toHaveAttribute('data-playing', 'false');
    await closeViewer();
  });

  test('buscar con la barra de progreso al centro: la búsqueda llega a ~20 s con peticiones Range (206) a vault://media', async () => {
    await openVideo();
    await pause(page);
    const bar = page.locator('[data-player-bar]');
    await expect(page.getByRole('slider', { name: 'Progreso' })).toBeVisible();
    // Los rangos cargados se dibujan en la barra.
    await expect.poll(() => page.locator('[data-player-buffered]').count()).toBeGreaterThan(0);

    // Tooltip con el tiempo al pasar el puntero por el centro.
    const box = await bar.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tooltip = page.locator('[data-player-tooltip]');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/^0:(19|20|21)$/);

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => timeOf(page), { timeout: 10_000 }).toBeGreaterThan(18.5);
    expect(await timeOf(page)).toBeLessThan(21.5);
    await expect(page.getByRole('slider', { name: 'Progreso' })).toHaveAttribute(
      'aria-valuetext',
      /^0:(19|20|21) de 0:40$/,
    );
    // Seguir reproduciendo desde ahí: el tiempo avanza.
    await page.keyboard.press('k');
    await expect.poll(() => timeOf(page), { timeout: 10_000 }).toBeGreaterThan(20.5);
    await page.keyboard.press('k');

    // vault://media atendió con Range: todas las respuestas con Range fueron 206 con Content-Range.
    const ranged = responses.filter((r) => r.range?.startsWith('bytes='));
    console.log(`[e2e] respuestas de vault://media: ${JSON.stringify(responses.slice(0, 12))}`);
    expect(ranged.length).toBeGreaterThan(0);
    for (const r of ranged) {
      expect(r.status).toBe(206);
      expect(r.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);
    }
    await closeViewer();
  });

  test('Inicio y Fin en la barra de progreso no la dejan atascada: ←/→ y el vídeo siguen moviéndola', async () => {
    test.setTimeout(120_000);
    await openVideo();
    await pause(page);
    const progress = page.getByRole('slider', { name: 'Progreso' });
    const valueNow = async (): Promise<number> =>
      Number(await progress.getAttribute('aria-valuenow'));
    await progress.focus();

    // Fin: la barra va al final; ← la retrocede 5 s (125 milésimas de 40 s).
    await page.keyboard.press('End');
    await expect.poll(() => timeOf(page), { timeout: 10_000 }).toBeGreaterThan(VIDEO_SECONDS - 1);
    await expect.poll(valueNow).toBeGreaterThan(990);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => timeOf(page), { timeout: 10_000 }).toBeLessThan(VIDEO_SECONDS - 4);
    await expect.poll(valueNow, { timeout: 10_000 }).toBeLessThan(900);
    await expect.poll(valueNow, { timeout: 10_000 }).toBeGreaterThan(800);

    // Inicio: la barra va a 0; → la avanza 5 s.
    await page.keyboard.press('Home');
    await expect.poll(() => timeOf(page), { timeout: 10_000 }).toBeLessThan(0.5);
    await expect.poll(valueNow).toBeLessThan(15);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => timeOf(page), { timeout: 10_000 }).toBeGreaterThan(4);
    await expect.poll(valueNow, { timeout: 10_000 }).toBeGreaterThan(100);
    await expect.poll(valueNow, { timeout: 10_000 }).toBeLessThan(160);

    // Y la barra sigue a la posición del vídeo cuando éste se mueve por otra vía (L = +10 s).
    await page.keyboard.press('l');
    await expect.poll(valueNow, { timeout: 10_000 }).toBeGreaterThan(340);
    await closeViewer();
  });

  test('velocidad 0,25× y 2× con el tono conservado, también con Mayús+, y Mayús+.; se recuerda en la sesión', async () => {
    await openVideo();
    await pause(page);
    const trigger = controls(page).getByRole('button', { name: /^Velocidad: / });
    await expect(trigger).toHaveAccessibleName('Velocidad: 1×');

    const measure = async (): Promise<{ rate: number; ratio: number }> => {
      await page.keyboard.press('k');
      await expect(player(page)).toHaveAttribute('data-playing', 'true');
      const result = await page.evaluate(async () => {
        const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
        if (!v) throw new Error('sin <video>');
        const t0 = v.currentTime;
        const w0 = performance.now();
        await new Promise((r) => setTimeout(r, 1500));
        return {
          rate: v.playbackRate,
          ratio: ((v.currentTime - t0) * 1000) / (performance.now() - w0),
        };
      });
      await page.keyboard.press('k');
      await expect(player(page)).toHaveAttribute('data-playing', 'false');
      return result;
    };

    await trigger.click();
    await page.getByRole('menuitemradio', { name: '0,25×', exact: true }).click();
    await expect(trigger).toHaveAccessibleName('Velocidad: 0,25×');
    await expect(player(page)).toHaveAttribute('data-speed', '0.25');
    expect((await videoState(page)).rate).toBe(0.25);
    expect((await videoState(page)).pitch).toBe(true);
    const slow = await measure();
    expect(slow.rate).toBe(0.25);
    expect(slow.ratio).toBeGreaterThan(0.1);
    expect(slow.ratio).toBeLessThan(0.45);

    await trigger.click();
    await page.getByRole('menuitemradio', { name: '2×', exact: true }).click();
    await expect(trigger).toHaveAccessibleName('Velocidad: 2×');
    expect((await videoState(page)).rate).toBe(2);
    expect((await videoState(page)).pitch).toBe(true);
    const fast = await measure();
    expect(fast.rate).toBe(2);
    expect(fast.ratio).toBeGreaterThan(1.4);
    expect(fast.ratio).toBeLessThan(2.8);

    // Mayús+, baja un paso (2× → 1,75×) y Mayús+. lo sube; en el extremo se queda.
    await page.keyboard.press('Shift+Comma');
    await expect(trigger).toHaveAccessibleName('Velocidad: 1,75×');
    await page.keyboard.press('Shift+Period');
    await page.keyboard.press('Shift+Period');
    await expect(trigger).toHaveAccessibleName('Velocidad: 2×');
    await page.keyboard.press('Shift+Comma');
    await page.keyboard.press('Shift+Comma');
    await page.keyboard.press('Shift+Comma');
    await expect(trigger).toHaveAccessibleName('Velocidad: 1,25×');

    // Se recuerda al cerrar y volver a abrir el vídeo (solo en memoria).
    await closeViewer();
    await openVideo();
    await expect(player(page)).toHaveAttribute('data-speed', '1.25');
    await expect.poll(async () => (await videoState(page)).rate).toBe(1.25);
    // Restablece 1× para el resto.
    await page.keyboard.press('Shift+Comma');
    await expect(player(page)).toHaveAttribute('data-speed', '1');
    await closeViewer();
  });

  test('bucle (R y el botón): al llegar al final vuelve a empezar; sin bucle se detiene', async () => {
    await openVideo();
    const loopButton = controls(page).getByRole('button', { name: /^Repetir en bucle/ });
    await expect(loopButton).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('r');
    await expect(player(page)).toHaveAttribute('data-loop', 'true');
    await expect(loopButton).toHaveAttribute('aria-pressed', 'true');
    expect((await videoState(page)).loop).toBe(true);

    // Salta al último segundo y espera: sigue sonando y el tiempo vuelve a empezar.
    await page.evaluate(
      (d) => {
        const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
        if (v) v.currentTime = d - 1;
      },
      (await videoState(page)).d,
    );
    await expect.poll(() => timeOf(page), { timeout: 15_000 }).toBeLessThan(10);
    await expect(player(page)).toHaveAttribute('data-playing', 'true');

    // Con el botón se apaga; al llegar al final se detiene.
    await page.mouse.move(640, 300);
    await loopButton.click();
    await expect(player(page)).toHaveAttribute('data-loop', 'false');
    expect((await videoState(page)).loop).toBe(false);
    await page.evaluate(
      (d) => {
        const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
        if (v) v.currentTime = d - 1;
      },
      (await videoState(page)).d,
    );
    await expect(player(page)).toHaveAttribute('data-playing', 'false', { timeout: 15_000 });
    expect((await videoState(page)).ended).toBe(true);
    await expect.poll(reasons).toEqual([]);
    await closeViewer();
  });

  test('volumen (↑/↓, la barra) y silencio (M y el botón); se recuerdan en la sesión', async () => {
    await openVideo();
    await pause(page);
    const muteButton = controls(page).getByRole('button', {
      name: /^(Silenciar|Activar el sonido)/,
    });
    await expect(player(page)).toHaveAttribute('data-volume', '1.00');
    expect((await videoState(page)).volume).toBe(1);

    await page.keyboard.press('ArrowDown');
    await expect(player(page)).toHaveAttribute('data-volume', '0.95');
    await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(0.95, 2);
    await page.keyboard.press('ArrowUp');
    await expect(player(page)).toHaveAttribute('data-volume', '1.00');
    // ↑/↓ no navegan ni desplazan: seguimos en el vídeo.
    await expect(viewerDialog(page)).toHaveAccessibleName(VIDEO_NAME);

    // M silencia y quita el silencio; el botón dice lo que hará.
    await expect(muteButton).toHaveAccessibleName('Silenciar (M)');
    await page.keyboard.press('m');
    await expect(player(page)).toHaveAttribute('data-muted', 'true');
    expect((await videoState(page)).muted).toBe(true);
    await expect(muteButton).toHaveAccessibleName('Activar el sonido (M)');
    await muteButton.click();
    await expect(player(page)).toHaveAttribute('data-muted', 'false');
    expect((await videoState(page)).muted).toBe(false);

    // La barra de volumen con el teclado: Inicio = 0 (queda a cero), Fin = 100 %.
    const slider = controls(page).getByRole('slider', { name: 'Volumen' });
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(player(page)).toHaveAttribute('data-volume', '0.00');
    await expect(muteButton).toHaveAccessibleName('Activar el sonido (M)');
    await page.keyboard.press('End');
    await expect(player(page)).toHaveAttribute('data-volume', '1.00');
    await expect(slider).toHaveAttribute('aria-valuetext', '100 %');
    // Con el sonido silenciado la barra marca 0; subirla lo reactiva (desde 0, un paso = 5 %).
    await page.keyboard.press('m');
    await expect(player(page)).toHaveAttribute('data-muted', 'true');
    await expect(slider).toHaveAttribute('aria-valuetext', '0 %');
    await page.keyboard.press('ArrowRight');
    await expect(player(page)).toHaveAttribute('data-muted', 'false');
    await expect(player(page)).toHaveAttribute('data-volume', '0.05');
    await page.keyboard.press('End');
    await expect(player(page)).toHaveAttribute('data-volume', '1.00');

    // Se recuerda: 50 % y vuelve a abrirse con ese volumen.
    await page.locator('[data-viewer]').focus();
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowDown');
    await expect(player(page)).toHaveAttribute('data-volume', '0.50');
    await closeViewer();
    await openVideo();
    await expect(player(page)).toHaveAttribute('data-volume', '0.50');
    await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(0.5, 2);
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowUp');
    await expect(player(page)).toHaveAttribute('data-volume', '1.00');
    await closeViewer();
  });

  test('F entra y sale de la pantalla completa (simulada); también el botón y el doble clic', async () => {
    await openVideo();
    await pause(page);
    const before = (await fullscreenCalls()).length;
    const fullButton = controls(page).getByRole('button', { name: /pantalla completa/i });
    await expect(fullButton).toHaveAccessibleName('Pantalla completa (F)');

    await page.keyboard.press('f');
    await expect.poll(async () => (await fullscreenCalls()).slice(before)).toEqual([true]);
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-fullscreen', 'true');
    await expect(fullButton).toHaveAccessibleName('Salir de pantalla completa (F)');
    await expect(player(page)).toBeVisible();

    await page.keyboard.press('f');
    await expect.poll(async () => (await fullscreenCalls()).slice(before)).toEqual([true, false]);
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-fullscreen', 'false');
    await expect(fullButton).toHaveAccessibleName('Pantalla completa (F)');

    await fullButton.click();
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-fullscreen', 'true');
    // Doble clic sobre el vídeo: sale (el primer clic pausa y reanuda, sin efecto neto).
    const stage = await page.locator('[data-viewer-stage]').boundingBox();
    expect(stage).toBeTruthy();
    if (stage) await page.mouse.dblclick(stage.x + stage.width / 2, stage.y + stage.height / 3);
    await expect(viewerDialog(page)).toHaveAttribute('data-viewer-fullscreen', 'false');
    expect((await fullscreenCalls()).slice(before)).toEqual([true, false, true, false]);
    await closeViewer();
  });

  test('los controles se ocultan a los 2,5 s sin movimiento mientras suena y siguen con el foco dentro', async () => {
    await openVideo();
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    const stage = await page.locator('[data-viewer-stage]').boundingBox();
    expect(stage).toBeTruthy();
    if (!stage) return;
    const away = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 3 };
    await page.mouse.move(away.x, away.y);
    await expect(player(page)).toHaveAttribute('data-controls-visible', 'true');
    const moved = Date.now();
    await expect(player(page)).toHaveAttribute('data-controls-visible', 'false', {
      timeout: 15_000,
    });
    expect(Date.now() - moved).toBeGreaterThanOrEqual(2_000);
    await expect(controls(page)).toHaveCSS('opacity', '0');

    // Un movimiento los devuelve; en pausa siempre están.
    await page.mouse.move(away.x + 20, away.y + 10);
    await expect(player(page)).toHaveAttribute('data-controls-visible', 'true');
    await expect(player(page)).toHaveAttribute('data-controls-visible', 'false', {
      timeout: 15_000,
    });

    // Con el foco dentro de los controles no se ocultan.
    await tabTo('[data-player-progress]');
    await expect(player(page)).toHaveAttribute('data-controls-visible', 'true');
    await page.waitForTimeout(3_500);
    await expect(player(page)).toHaveAttribute('data-controls-visible', 'true');
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    await page.keyboard.press('k');
    await closeViewer();
  });

  test('recorrido solo con teclado: Tab por los controles, ←/→ en la barra, Espacio en los botones, menú de velocidad', async () => {
    const cell = gridCells(page).nth(videoIndex);
    await cell.focus();
    await page.keyboard.press('Enter');
    await waitReady(page);
    const dialog = viewerDialog(page);
    await expect(dialog).toBeFocused();
    await pause(page);

    // Tab recorre las paradas y llega a la barra de progreso (con anillo de foco visible).
    const stops = await tabTo('[data-player-progress]');
    expect(stops).toEqual(expect.arrayContaining(['Cerrar', 'Progreso']));
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style).not.toBe('none');
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);

    // ←/→ con el foco en la barra la mueven (5 s; Mayús, 10 s) y NO cambian de elemento.
    const t0 = await timeOf(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0 + 5, 0);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0 + 15, 0);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => timeOf(page)).toBeCloseTo(t0 + 10, 0);
    await expect(dialog).toHaveAccessibleName(VIDEO_NAME);

    // Espacio en un botón enfocado lo activa una sola vez (no además la reproducción global).
    await tabTo('button[aria-label^="Reproducir"]');
    await page.keyboard.press('Space');
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(300);
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    await page.keyboard.press('Enter'); // Intro en el mismo botón pausa
    await expect(player(page)).toHaveAttribute('data-playing', 'false');

    // La barra de volumen: ← baja un paso.
    await tabTo('[role="slider"][aria-label="Volumen"]');
    await page.keyboard.press('ArrowLeft');
    await expect(player(page)).toHaveAttribute('data-volume', '0.95');

    // El menú de velocidad se abre con Intro y se maneja con flechas; sus teclas no llegan al visor.
    await tabTo('button[aria-label^="Velocidad"]');
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight'); // en el menú no navega al elemento anterior/siguiente
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(dialog).toHaveAccessibleName(VIDEO_NAME);
    await expect(player(page)).toHaveAttribute('data-volume', '0.95');
    const speed = Number(await player(page).getAttribute('data-speed'));
    expect(speed).not.toBe(1);
    await expect(controls(page).getByRole('button', { name: /^Velocidad: / })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape'); // Esc cierra el menú y no el visor
    await expect(menu).toBeHidden();
    await expect(dialog).toBeVisible();
    // Vuelve a 1× por teclado.
    await page.locator('[data-viewer]').focus();
    while (Number(await player(page).getAttribute('data-speed')) !== 1) {
      await page.keyboard.press(
        Number(await player(page).getAttribute('data-speed')) > 1 ? 'Shift+Comma' : 'Shift+Period',
      );
    }

    // Bucle y pantalla completa con Tab + Intro.
    await tabTo('button[aria-label^="Repetir"]');
    await page.keyboard.press('Enter');
    await expect(player(page)).toHaveAttribute('data-loop', 'true');
    await page.keyboard.press('Enter');
    await expect(player(page)).toHaveAttribute('data-loop', 'false');
    const calls = (await fullscreenCalls()).length;
    await tabTo('[data-player-controls] button[aria-label*="antalla completa"]');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveAttribute('data-viewer-fullscreen', 'true');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveAttribute('data-viewer-fullscreen', 'false');
    expect((await fullscreenCalls()).slice(calls)).toEqual([true, false]);

    // Sin el foco en la barra, ←/→ siguen siendo anterior/siguiente: pasa a la foto.
    const photoIndex = videoIndex === 0 ? 1 : 0;
    await page.locator('[data-viewer]').focus();
    await page.keyboard.press(videoIndex === 0 ? 'ArrowRight' : 'ArrowLeft');
    await expect(dialog).toHaveAccessibleName('Foto previa');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(gridCells(page).nth(photoIndex)).toBeFocused();
    await expect.poll(reasons).toEqual([]);
  });

  test('un error del medio con el vídeo sonando suelta el motivo playback y el bloqueador', async () => {
    await openVideo();
    await expect.poll(reasons).toContain('playback');
    await expect.poll(displayBlocked).toBe(true);
    // Un error a mitad de reproducción no cambia `paused` ni dispara `pause`: el <video> sigue
    // «sonando» para el DOM, pero el reproductor ya no cuenta como reproducción.
    await page.evaluate(() => {
      document.querySelector('[data-player-video]')?.dispatchEvent(new Event('error'));
    });
    await expect(page.locator('[data-player-error]')).toBeVisible();
    await expect.poll(reasons).toEqual([]);
    await expect.poll(displayBlocked).toBe(false);
    await closeViewer();
  });

  test('bloquear con Ctrl+L mientras suena suelta el motivo playback y el bloqueador', async () => {
    await openVideo();
    await expect(player(page)).toHaveAttribute('data-playing', 'true');
    await expect.poll(reasons).toContain('playback');
    await expect.poll(displayBlocked).toBe(true);
    page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
    await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible();
    await expect.poll(reasons).toEqual([]);
    await expect.poll(displayBlocked).toBe(false);
  });
});

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`captura del reproductor con los controles visibles en el tema ${displayName}`, async () => {
    test.setTimeout(240_000);
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
      const video = join(src, `${VIDEO_NAME}.mp4`);
      writeLongVideo(video, VIDEO_SECONDS);
      expect((await importAndSummarize(page, app, [video], 'files', 120_000)).imported).toBe(1);
      await expectItemCount(page, 1);
      await expect
        .poll(() =>
          page
            .getByRole('grid', { name: 'Galería' })
            .evaluate((g) =>
              Array.from(g.querySelectorAll('img')).every((i) => i.naturalWidth > 0),
            ),
        )
        .toBe(true);

      await gridCells(page).nth(0).dblclick();
      await waitReady(page);
      await expect(player(page)).toHaveAttribute('data-playing', 'true');
      // Con el vídeo en marcha, las ondas animadas del fondo dejan de dibujar.
      if (id === 'ps3') {
        await expect(page.locator('canvas[data-waves]')).toHaveAttribute('data-animating', 'false');
      }
      // Un fotograma con gracia (a ~12 s) y en pausa: los controles se quedan visibles.
      await page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
        if (v) v.currentTime = 12;
      });
      await page.keyboard.press('k');
      await expect(player(page)).toHaveAttribute('data-playing', 'false');
      await expect.poll(() => timeOf(page)).toBeGreaterThan(11.9);
      // Foco visible en un control del reproductor.
      await tabToControl(page);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(600);
      await expect(player(page)).toHaveAttribute('data-controls-visible', 'true');
      await page.screenshot({ path: join(SHOTS, `player-${label}.png`) });
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}

/** Tab hasta el botón de reproducir (anillo de foco visible en la captura). */
async function tabToControl(page: Page): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label')?.startsWith('Reproducir'),
    );
    if (hit) return;
  }
  throw new Error('Tab no llegó al botón de reproducir');
}
