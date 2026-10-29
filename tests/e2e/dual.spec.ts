// Pantalla de vídeo dual (docs/PLAN.md 5.2, 5.4 y 5.5; docs/DESIGN.md §18.1): «Vídeo dual» de la
// barra de selección solo con exactamente dos vídeos; el estado vacío «Elegir vídeo…» y su selector;
// el audio por defecto (suena el izquierdo, el derecho está silenciado); el modo sincronizado (un solo
// control mueve los dos y la deriva se queda por debajo de 0,1 s tras 5 s; el esclavo se queda en su
// último fotograma al pasar de su final); el modo independiente (cada lado por separado, con su
// volumen, velocidad y bucle); los atajos de teclado (Ctrl+←/→ cambia de lado); y el contador de
// reproducción activa compartido (auto-bloqueo, pantalla encendida, fondos animados) que se suelta al
// pausar, ante un error, al salir de la pantalla y al bloquear.
//
// Vídeos de prueba cortos y de baja resolución (testsrc2 + sine, ffmpeg empaquetado) bajo tests/.tmp/.
// Ventana discreta (nota 135): fuera de pantalla y sin robar el foco.
import { expect, test, type Page } from '@playwright/test';
import { lockAndGetNewWindow, type LaunchedApp } from './helpers/launch';
import {
  autoLockReasons,
  controls,
  displaySleepBlocked,
  dualScreen,
  importDualFixtures,
  LEFT_NAME,
  LEFT_SECONDS,
  openDualFromNav,
  PHOTO_NAME,
  pickVideo,
  RIGHT_NAME,
  RIGHT_SECONDS,
  snapVideos,
  waitVideosReady,
} from './helpers/dual';
import { launchUnlocked, newSourceDir, removeDir } from './helpers/library';
import { openGallery, selectionBar } from './helpers/playlists';

const SLOW = { timeout: 60_000 } as const;

test.describe('vídeo dual', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;
  let src: string;

  const cell = (name: string) => page.getByRole('gridcell', { name: new RegExp(`^${name}`) });
  const headerName = (side: 'left' | 'right') =>
    page.locator(`[data-dual-header="${side}"]`).locator('span').nth(1);
  const sw = () => page.getByRole('switch', { name: 'Controles sincronizados' });

  async function drift(): Promise<number> {
    const s = await snapVideos(page);
    return Math.abs((s.left?.t ?? 0) - (s.right?.t ?? 0));
  }

  /** Quita lo que haya en los dos lados y elige estos dos vídeos. */
  async function setSides(leftName: string, rightName: string): Promise<void> {
    if (!(await dualScreen(page).isVisible())) await openDualFromNav(page);
    for (const side of ['left', 'right'] as const) {
      const remove = page.getByRole('button', {
        name: `Quitar el vídeo ${side === 'left' ? 'izquierdo' : 'derecho'}`,
      });
      if (await remove.isVisible()) await remove.click();
    }
    await pickVideo(page, 'left', leftName);
    await pickVideo(page, 'right', rightName);
    await waitVideosReady(page);
  }

  async function ensureSync(on: boolean): Promise<void> {
    if ((await sw().isChecked()) !== on) await sw().click();
    await expect(dualScreen(page)).toHaveAttribute('data-dual-mode', on ? 'sync' : 'independent');
  }

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    launched = await launchUnlocked({}, { width: 1280, height: 800 });
    page = launched.page;
    src = newSourceDir();
    await importDualFixtures(page, launched.app, src, { photo: true });
    await expect(cell(LEFT_NAME)).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole('grid', { name: 'Galería' })
          .evaluate((g) => Array.from(g.querySelectorAll('img')).every((i) => i.naturalWidth > 0)),
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    await launched?.close();
    if (src) removeDir(src);
  });

  test('«Vídeo dual» de la barra de selección: solo con exactamente dos vídeos', async () => {
    test.setTimeout(120_000);
    const dual = selectionBar(page).getByRole('button', { name: 'Vídeo dual' });

    await cell(LEFT_NAME).click(); // un clic selecciona (nota 195)
    await expect(selectionBar(page)).toContainText('1 seleccionado');
    await expect(dual).toHaveAttribute('aria-disabled', 'true');
    await dual.focus();
    await expect(
      page.getByRole('tooltip', { name: 'Selecciona exactamente dos vídeos.' }),
    ).toBeVisible();
    await dual.press('Enter'); // deshabilitado: no navega
    await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();

    // Un vídeo y una foto: tampoco.
    await cell(PHOTO_NAME).click();
    await expect(selectionBar(page)).toContainText('2 seleccionados');
    await expect(dual).toHaveAttribute('aria-disabled', 'true');
    // Tres elementos: tampoco.
    await cell(RIGHT_NAME).click();
    await expect(selectionBar(page)).toContainText('3 seleccionados');
    await expect(dual).toHaveAttribute('aria-disabled', 'true');

    // Dos vídeos: habilitado, y abre la pantalla con el primero (en el orden de la galería) a la izquierda.
    await cell(PHOTO_NAME).click();
    await expect(selectionBar(page)).toContainText('2 seleccionados');
    await expect(dual).not.toHaveAttribute('aria-disabled', 'true');
    const order = await page
      .getByRole('gridcell')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    const videos = order.filter((l) => l.includes(', vídeo')).map((l) => l.split(',')[0]);
    expect(videos).toHaveLength(2);
    await dual.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Vídeo dual' })).toBeVisible();
    await expect(headerName('left')).toHaveText(videos[0] ?? '');
    await expect(headerName('right')).toHaveText(videos[1] ?? '');
    await waitVideosReady(page);
    await expect(
      page.getByRole('button', { name: 'Crear vídeo fusionado', exact: true }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('desde la navegación: dos huecos «Elegir vídeo…», el selector y la búsqueda', async () => {
    test.setTimeout(120_000);
    await openGallery(page);
    await page.keyboard.press('Escape'); // limpia la selección
    await openDualFromNav(page);
    // Se conservan los dos de antes; se quitan para ver el estado vacío.
    await page.getByRole('button', { name: 'Quitar el vídeo izquierdo' }).click();
    await page.getByRole('button', { name: 'Quitar el vídeo derecho' }).click();
    for (const side of ['left', 'right'] as const) {
      const pane = page.locator(`[data-dual-side="${side}"]`);
      await expect(pane).toContainText(
        `Todavía no hay vídeo en el lado ${side === 'left' ? 'izquierdo' : 'derecho'}`,
      );
      await expect(pane.getByRole('button', { name: 'Elegir vídeo…' })).toBeVisible();
    }
    const merge = page.getByRole('button', { name: 'Crear vídeo fusionado', exact: true });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await merge.focus();
    await expect(page.getByRole('tooltip', { name: 'Elige un vídeo en cada lado.' })).toBeVisible();

    // El selector solo lista vídeos (no la foto) y filtra por nombre sin fijarse en acentos.
    await page
      .locator('[data-dual-side="left"]')
      .getByRole('button', { name: 'Elegir vídeo…' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Elegir vídeo' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Para el lado izquierdo.');
    await expect(dialog.locator('[data-picker-item]')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: new RegExp(`^${PHOTO_NAME}`) })).toHaveCount(0);
    await dialog.getByLabel('Buscar por nombre').fill('CORTO');
    await expect(dialog.locator('[data-picker-item]')).toHaveCount(1);
    await dialog.getByLabel('Buscar por nombre').fill('no existe');
    await expect(dialog).toContainText('Ningún vídeo coincide con la búsqueda.');
    await dialog.getByLabel('Buscar por nombre').fill('');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await pickVideo(page, 'left', LEFT_NAME);
    await expect(headerName('left')).toHaveText(LEFT_NAME);
    // El del otro lado aparece deshabilitado en el selector.
    await page
      .locator('[data-dual-side="right"]')
      .getByRole('button', { name: 'Elegir vídeo…' })
      .click();
    await expect(dialog.getByRole('button', { name: new RegExp(`^${LEFT_NAME}`) })).toBeDisabled();
    await expect(dialog).toContainText('Ya está en el otro lado');
    await dialog.getByRole('button', { name: new RegExp(`^${RIGHT_NAME}`) }).click();
    await waitVideosReady(page);
    await expect(merge).not.toHaveAttribute('aria-disabled', 'true');
    await expect(sw()).toBeChecked();
  });

  test('audio por defecto: suena el izquierdo y el derecho está silenciado', async () => {
    await setSides(LEFT_NAME, RIGHT_NAME);
    const s = await snapVideos(page);
    expect(s.left?.muted).toBe(false);
    expect(s.right?.muted).toBe(true);
    expect(s.left?.volume).toBe(1);
    expect(Math.abs((s.left?.duration ?? 0) - LEFT_SECONDS)).toBeLessThan(0.6);
    expect(Math.abs((s.right?.duration ?? 0) - RIGHT_SECONDS)).toBeLessThan(0.6);
    // Los controles lo reflejan, y se pueden cambiar por lado.
    const bar = controls(page, 'sync');
    await expect(bar.getByRole('button', { name: 'Silenciar izquierdo (M)' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Activar el sonido derecho (M)' })).toBeVisible();
    await bar.getByRole('button', { name: 'Activar el sonido derecho (M)' }).click();
    await bar.getByRole('button', { name: 'Silenciar izquierdo (M)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(false);
    await expect.poll(async () => (await snapVideos(page)).left?.muted).toBe(true);
    // Vuelve al valor por defecto.
    await bar.getByRole('button', { name: 'Activar el sonido izquierdo (M)' }).click();
    await bar.getByRole('button', { name: 'Silenciar derecho (M)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.muted).toBe(false);
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(true);
  });

  test('volver a elegir el mismo vídeo en un lado conserva silencio, volumen y velocidad y el controlador sigue al día', async () => {
    test.setTimeout(180_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(true);
    const bar = controls(page, 'sync');
    const repick = async (side: 'left' | 'right', name: string): Promise<void> => {
      await page
        .getByRole('button', {
          name: `Cambiar el vídeo ${side === 'left' ? 'izquierdo' : 'derecho'}`,
        })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Elegir vídeo' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await expect(dialog).toBeHidden();
      await waitVideosReady(page);
    };

    // Sincronizado: velocidad 2× y volumen del derecho a 0,5 (sin sonido todavía).
    await bar.getByRole('button', { name: /^Velocidad: / }).click();
    await page.getByRole('menuitemradio', { name: '2×', exact: true }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.rate).toBe(2);
    await bar.getByRole('slider', { name: 'Volumen derecho' }).focus();
    await page.keyboard.press('ArrowUp'); // desde el silencio (0 %) sube a 5 %
    await expect.poll(async () => (await snapVideos(page)).right?.volume).toBeCloseTo(0.05, 2);
    const rightVolume = (await snapVideos(page)).right?.volume ?? 1;
    // Cambiar el volumen de un lado silenciado lo reactiva: se vuelve a silenciar para fijar el punto de partida.
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(false);
    await bar.getByRole('button', { name: 'Silenciar derecho (M)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(true);

    // El mismo vídeo en el lado derecho: el <video> nuevo recibe silencio, volumen y velocidad.
    await repick('right', RIGHT_NAME);
    const after = await snapVideos(page);
    expect(after.right?.muted).toBe(true);
    expect(after.right?.volume).toBeCloseTo(rightVolume, 2);
    expect(after.right?.rate).toBeGreaterThanOrEqual(1.9);
    expect(after.right?.rate).toBeLessThanOrEqual(2.1);
    expect(after.left?.muted).toBe(false);
    // El controlador es nuevo: la barra común está en pausa y reproducir mueve los dos.
    await expect(bar).toHaveAttribute('data-playing', 'false');
    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect
      .poll(async () => {
        const s = await snapVideos(page);
        return s.left?.paused === false && s.right?.paused === false;
      }, SLOW)
      .toBe(true);
    await expect(bar).toHaveAttribute('data-playing', 'true');
    expect((await snapVideos(page)).right?.muted).toBe(true);
    await bar.getByRole('button', { name: 'Pausar (K)' }).click();
    await bar.getByRole('slider', { name: 'Volumen derecho' }).focus();
    await page.keyboard.press('End'); // vuelve al 100 % para las pruebas siguientes
    await expect.poll(async () => (await snapVideos(page)).right?.volume).toBe(1);
    await bar.getByRole('button', { name: 'Silenciar derecho (M)' }).click(); // subir el volumen lo reactivó
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(true);

    // Lo mismo en el izquierdo, y con controles independientes (velocidad y silencio por lado).
    await ensureSync(false);
    const left = controls(page, 'left');
    await left.getByRole('button', { name: /^Velocidad izquierdo: / }).click();
    await page.getByRole('menuitemradio', { name: '1,5×', exact: true }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.rate).toBe(1.5);
    await left.getByRole('button', { name: 'Silenciar izquierdo (M)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.muted).toBe(true);
    await repick('left', LEFT_NAME);
    const again = await snapVideos(page);
    expect(again.left?.muted).toBe(true);
    expect(again.left?.rate).toBe(1.5);
    expect(again.right?.muted).toBe(true);
    // Deja los valores por defecto para las pruebas siguientes.
    await left.getByRole('button', { name: /^Velocidad izquierdo: / }).click();
    await page.getByRole('menuitemradio', { name: '1×', exact: true }).click();
    await left.getByRole('button', { name: 'Activar el sonido izquierdo (M)' }).click();
    await ensureSync(true);
    await controls(page, 'sync')
      .getByRole('button', { name: /^Velocidad: / })
      .click();
    await page.getByRole('menuitemradio', { name: '1×', exact: true }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.rate).toBe(1);
  });

  test('sincronizado: un solo control mueve los dos y la deriva se queda por debajo de 0,1 s tras 5 s', async () => {
    test.setTimeout(180_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(true);
    const bar = controls(page, 'sync');
    await expect(controls(page, 'left')).toHaveCount(0); // una sola barra
    await expect(controls(page, 'right')).toHaveCount(0);
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);

    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect
      .poll(async () => {
        const s = await snapVideos(page);
        return s.left !== null && s.right !== null && !s.left.paused && !s.right.paused;
      }, SLOW)
      .toBe(true);
    await expect(bar).toHaveAttribute('data-playing', 'true');
    // Reproducción activa: el motivo de auto-bloqueo, la pantalla encendida y el fondo en pausa.
    await expect.poll(() => autoLockReasons(launched.app)).toContain('playback');
    await expect.poll(() => displaySleepBlocked(launched.app)).toBe(true);
    await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'true');

    await page.waitForTimeout(5_000);
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      samples.push(await drift());
      await page.waitForTimeout(400);
    }
    console.log(`[e2e] deriva tras 5 s (s): ${samples.map((d) => d.toFixed(3)).join(' ')}`);
    expect(Math.max(...samples)).toBeLessThan(0.1);
    const playing = await snapVideos(page);
    expect(playing.left?.t).toBeGreaterThan(5);
    expect(playing.left?.paused).toBe(false);
    expect(playing.right?.paused).toBe(false);

    // Pausar con la misma barra para los dos.
    await bar.getByRole('button', { name: 'Pausar (K)' }).click();
    await expect
      .poll(async () => {
        const s = await snapVideos(page);
        return s.left?.paused === true && s.right?.paused === true;
      })
      .toBe(true);
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);
    await expect.poll(() => displaySleepBlocked(launched.app)).toBe(false);
    await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'false');
    expect(await drift()).toBeLessThan(0.1);
  });

  test('sincronizado: buscar mueve los dos; pasado el final del corto se queda en su último fotograma; ±10 s; velocidad', async () => {
    test.setTimeout(180_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(true);
    const bar = controls(page, 'sync');
    const progress = bar.getByRole('slider', { name: 'Progreso' });
    await expect(bar.locator('[data-dual-duration]')).toHaveText('0:20'); // la línea de tiempo es la del más largo

    // Inicio con el teclado en la barra; +10 s con el botón; +5 s con →.
    await progress.focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeLessThan(0.3);
    await bar.getByRole('button', { name: 'Avanzar 10 s (L)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeCloseTo(10, 0);
    expect((await snapVideos(page)).right?.t).toBeCloseTo(10, 0);
    await progress.focus();
    await page.keyboard.press('ArrowRight'); // +5 s en la barra
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeCloseTo(15, 0);
    // El esclavo (12 s) se queda pausado en su último fotograma.
    await expect
      .poll(async () => {
        const s = await snapVideos(page);
        return s.right !== null && s.right.t > 11.5 && s.right.t <= s.right.duration + 0.05;
      })
      .toBe(true);
    expect((await snapVideos(page)).right?.paused).toBe(true);

    // Retroceder 10 s: los dos vuelven a 5 s.
    await bar.getByRole('button', { name: 'Retroceder 10 s (J)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeCloseTo(5, 0);
    await expect.poll(async () => (await snapVideos(page)).right?.t).toBeCloseTo(5, 0);

    // Reproduciendo desde 15 s: el izquierdo sigue y el derecho no se mueve (último fotograma).
    await bar.getByRole('button', { name: 'Avanzar 10 s (L)' }).click();
    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.paused, SLOW).toBe(false);
    await page.waitForTimeout(1_500);
    const mid = await snapVideos(page);
    expect(mid.left?.t).toBeGreaterThan(15.5);
    expect(mid.right?.paused).toBe(true);
    expect(mid.right?.t).toBeGreaterThan(11.5);
    // Volver a un punto donde el corto tiene vídeo lo reanuda con el maestro.
    await bar.getByRole('button', { name: 'Retroceder 10 s (J)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.paused).toBe(false);
    await expect.poll(() => drift()).toBeLessThan(0.1);

    // Velocidad 2×: los dos (el esclavo puede ir ±5 % mientras se corrige).
    await bar.getByRole('button', { name: /^Velocidad: / }).click();
    await page.getByRole('menuitemradio', { name: '2×', exact: true }).click();
    await expect(bar).toHaveAttribute('data-speed', '2');
    const fast = await snapVideos(page);
    expect(fast.left?.rate).toBe(2);
    expect(fast.right?.rate).toBeGreaterThanOrEqual(1.9);
    expect(fast.right?.rate).toBeLessThanOrEqual(2.1);
    await page.waitForTimeout(2_000);
    expect(await drift()).toBeLessThan(0.15);
    // Vuelve a 1× y la velocidad del esclavo regresa a la normal.
    await bar.getByRole('button', { name: /^Velocidad: / }).click();
    await page.getByRole('menuitemradio', { name: '1×', exact: true }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.rate).toBe(1);
    await expect
      .poll(async () => (await snapVideos(page)).right?.rate, { timeout: 10_000 })
      .toBe(1);
    await bar.getByRole('button', { name: 'Pausar (K)' }).click();
    await expect(bar).toHaveAttribute('data-playing', 'false');
  });

  test('sincronizado: al terminar sin bucle se detiene; reproducir al final empieza de nuevo; con bucle los dos vuelven a 0', async () => {
    test.setTimeout(180_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(true);
    const bar = controls(page, 'sync');
    const progress = bar.getByRole('slider', { name: 'Progreso' });
    const playing = () => dualScreen(page).getAttribute('data-dual-playing');
    const atFifteen = async (): Promise<void> => {
      await progress.focus();
      await page.keyboard.press('End');
      await expect.poll(async () => (await snapVideos(page)).left?.t).toBeGreaterThan(19);
      await page.keyboard.press('ArrowLeft'); // -5 s → 15 s
      await expect.poll(async () => (await snapVideos(page)).left?.t).toBeCloseTo(15, 0);
    };

    // Sin bucle: desde 15 s reproduce hasta el final y se detiene (los dos pausados).
    await atFifteen();
    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect.poll(playing, SLOW).toBe('true');
    await expect.poll(playing, { timeout: 30_000 }).toBe('false');
    const ended = await snapVideos(page);
    expect(ended.left?.t).toBeGreaterThan(19.5);
    expect(ended.left?.paused).toBe(true);
    expect(ended.right?.paused).toBe(true);
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);

    // Reproducir al final empieza otra vez desde el principio.
    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect.poll(playing, SLOW).toBe('true');
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeLessThan(5);
    await bar.getByRole('button', { name: 'Pausar (K)' }).click();

    // Con bucle (R): al terminar el maestro, los dos vuelven a 0 y siguen sonando.
    await page.keyboard.press('r');
    await expect(bar.getByRole('button', { name: 'Repetir en bucle (R)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await atFifteen();
    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect
      .poll(async () => (await snapVideos(page)).left?.t, { timeout: 30_000 })
      .toBeLessThan(10);
    expect(await playing()).toBe('true');
    await expect.poll(async () => (await snapVideos(page)).right?.paused, SLOW).toBe(false);
    await expect.poll(() => drift(), { timeout: 10_000 }).toBeLessThan(0.15);
    await bar.getByRole('button', { name: 'Pausar (K)' }).click();
    await bar.getByRole('button', { name: 'Repetir en bucle (R)' }).click();
    await expect(bar.getByRole('button', { name: 'Repetir en bucle (R)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
  test('independiente: cada lado funciona por separado (reproducción, búsqueda, volumen, velocidad y bucle)', async () => {
    test.setTimeout(180_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(false);
    const left = controls(page, 'left');
    const right = controls(page, 'right');
    await expect(controls(page, 'sync')).toHaveCount(0);
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);

    // Solo el izquierdo.
    await left.getByRole('button', { name: 'Reproducir izquierdo (K)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.paused, SLOW).toBe(false);
    await expect.poll(() => autoLockReasons(launched.app)).toContain('playback');
    await page.waitForTimeout(1_500);
    let s = await snapVideos(page);
    expect(s.right?.paused).toBe(true);
    expect(s.right?.t).toBeLessThan(0.3);
    expect(s.left?.t).toBeGreaterThan(1);

    // El derecho también, pero con posiciones distintas: +10 s solo al izquierdo.
    await right.getByRole('button', { name: 'Reproducir derecho (K)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.paused, SLOW).toBe(false);
    await left.getByRole('button', { name: 'Avanzar 10 s izquierdo (L)' }).click();
    await page.waitForTimeout(1_000);
    s = await snapVideos(page);
    expect(s.left?.t).toBeGreaterThan(10.5);
    expect(s.right?.t).toBeLessThan(5);
    expect(Math.abs((s.left?.t ?? 0) - (s.right?.t ?? 0))).toBeGreaterThan(5); // sin corrección de deriva

    // Pausar el izquierdo no para al derecho.
    await left.getByRole('button', { name: 'Pausar izquierdo (K)' }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.paused).toBe(true);
    const r0 = (await snapVideos(page)).right?.t ?? 0;
    await page.waitForTimeout(1_000);
    s = await snapVideos(page);
    expect(s.right?.paused).toBe(false);
    expect(s.right?.t).toBeGreaterThan(r0 + 0.5);
    await expect.poll(() => autoLockReasons(launched.app)).toContain('playback');
    await right.getByRole('button', { name: 'Pausar derecho (K)' }).click();
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);

    // Retroceder solo el derecho; la barra de progreso de cada lado es suya.
    const lt = (await snapVideos(page)).left?.t ?? 0;
    await right.getByRole('button', { name: 'Avanzar 10 s derecho (L)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.t).toBeGreaterThan(8);
    expect((await snapVideos(page)).left?.t).toBeCloseTo(lt, 1);
    await expect(right.getByRole('slider', { name: 'Progreso derecho' })).toBeVisible();
    await expect(left.getByRole('slider', { name: 'Progreso izquierdo' })).toBeVisible();

    // Volumen por lado: el izquierdo a 0, el derecho no cambia.
    await left.getByRole('slider', { name: 'Volumen izquierdo' }).focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await snapVideos(page)).left?.volume).toBe(0);
    expect((await snapVideos(page)).right?.volume).toBe(1);
    await page.keyboard.press('End');
    await expect.poll(async () => (await snapVideos(page)).left?.volume).toBe(1);
    // Silencio por lado: el derecho empieza silenciado.
    await right.getByRole('button', { name: 'Activar el sonido derecho (M)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(false);
    expect((await snapVideos(page)).left?.muted).toBe(false);
    await right.getByRole('button', { name: 'Silenciar derecho (M)' }).click();
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(true);

    // Velocidad por lado: 2× solo en el izquierdo.
    await left.getByRole('button', { name: /^Velocidad izquierdo: / }).click();
    await page.getByRole('menuitemradio', { name: '2×', exact: true }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.rate).toBe(2);
    expect((await snapVideos(page)).right?.rate).toBe(1);
    await left.getByRole('button', { name: /^Velocidad izquierdo: / }).click();
    await page.getByRole('menuitemradio', { name: '1×', exact: true }).click();
    await expect.poll(async () => (await snapVideos(page)).left?.rate).toBe(1);

    // Bucle por lado (nativo).
    await left.getByRole('button', { name: 'Repetir en bucle izquierdo (R)' }).click();
    const loops = await page.evaluate(() => ({
      left: document.querySelector<HTMLVideoElement>('video[data-dual-video="left"]')?.loop,
      right: document.querySelector<HTMLVideoElement>('video[data-dual-video="right"]')?.loop,
    }));
    expect(loops).toEqual({ left: true, right: false });
    await left.getByRole('button', { name: 'Repetir en bucle izquierdo (R)' }).click();
  });

  test('teclado: Ctrl+←/→ cambia de lado; en independiente los atajos actúan sobre el lado con el foco', async () => {
    test.setTimeout(180_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(false);
    const paused = async (side: 'left' | 'right') => (await snapVideos(page))[side]?.paused;
    const focusedSide = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-dual-side') ?? null);

    await dualScreen(page).getByRole('heading', { level: 1 }).focus();
    await page.keyboard.press('Control+ArrowLeft');
    expect(await focusedSide()).toBe('left');
    await page.keyboard.press('Control+ArrowRight');
    expect(await focusedSide()).toBe('right');
    await page.keyboard.press('Control+ArrowLeft');
    expect(await focusedSide()).toBe('left');
    // El foco se ve (anillo de foco visible, no una salida a "none").
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);

    // K en el izquierdo: solo suena el izquierdo.
    await page.keyboard.press('k');
    await expect.poll(() => paused('left'), SLOW).toBe(false);
    expect(await paused('right')).toBe(true);
    // J/L y Mayús+flechas: ±10 s del lado con el foco.
    const t0 = (await snapVideos(page)).left?.t ?? 0;
    await page.keyboard.press('l');
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeGreaterThan(t0 + 9);
    expect((await snapVideos(page)).right?.t).toBeLessThan(1);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeLessThan(t0 + 5);
    await page.keyboard.press('k');
    await expect.poll(() => paused('left')).toBe(true);

    // En el derecho: K reproduce, M activa su sonido, ↑/↓ cambian su volumen, Mayús+. sube la velocidad.
    await page.keyboard.press('Control+ArrowRight');
    expect(await focusedSide()).toBe('right');
    await page.keyboard.press('k');
    await expect.poll(() => paused('right'), SLOW).toBe(false);
    expect(await paused('left')).toBe(true);
    await page.keyboard.press('m');
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(false);
    expect((await snapVideos(page)).left?.muted).toBe(false);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await snapVideos(page)).right?.volume).toBeCloseTo(0.95, 2);
    expect((await snapVideos(page)).left?.volume).toBe(1);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await snapVideos(page)).right?.volume).toBe(1);
    await page.keyboard.press('Shift+Period');
    await expect(controls(page, 'right')).toHaveAttribute('data-speed', '1.25');
    expect((await snapVideos(page)).left?.rate).toBe(1);
    await page.keyboard.press('Shift+Comma');
    await expect(controls(page, 'right')).toHaveAttribute('data-speed', '1');
    await page.keyboard.press('m');
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(true);
    await page.keyboard.press('k');
    await expect.poll(() => paused('right')).toBe(true);

    // Sincronizado: K y ±10 s actúan sobre los dos; M/↑/↓ sobre el lado con el foco (el izquierdo si no hay).
    await ensureSync(true);
    await page.keyboard.press('Control+ArrowLeft');
    expect(await focusedSide()).toBe('left');
    await page.keyboard.press('k');
    await expect.poll(async () => (await snapVideos(page)).right?.paused, SLOW).toBe(false);
    expect((await snapVideos(page)).left?.paused).toBe(false);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await snapVideos(page)).left?.t).toBeGreaterThan(9);
    await expect.poll(() => drift(), { timeout: 10_000 }).toBeLessThan(0.15);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await snapVideos(page)).left?.volume).toBeCloseTo(0.95, 2);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Control+ArrowRight');
    await page.keyboard.press('m'); // el derecho
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(false);
    await page.keyboard.press('m');
    await expect.poll(async () => (await snapVideos(page)).right?.muted).toBe(true);
    await page.keyboard.press('Space'); // Espacio también alterna (el foco está en el lado, no en un botón)
    await expect.poll(async () => (await snapVideos(page)).left?.paused).toBe(true);
    expect((await snapVideos(page)).right?.paused).toBe(true);
  });

  test('el contador de reproducción activa se suelta con un error, al salir de la pantalla y al bloquear', async () => {
    test.setTimeout(240_000);
    await setSides(LEFT_NAME, RIGHT_NAME);
    await ensureSync(true);
    const bar = controls(page, 'sync');

    // Salir de la pantalla mientras suena.
    await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect.poll(() => autoLockReasons(launched.app), SLOW).toContain('playback');
    await openGallery(page);
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);
    await expect.poll(() => displaySleepBlocked(launched.app)).toBe(false);
    await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'false');

    // Un error del medio a mitad de reproducción también lo suelta (aunque el <video> no se pause).
    await openDualFromNav(page);
    await expect(dualScreen(page)).toHaveAttribute('data-dual-mode', 'sync');
    await waitVideosReady(page);
    await controls(page, 'sync').getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect.poll(() => autoLockReasons(launched.app), SLOW).toContain('playback');
    await page.evaluate(() =>
      document.querySelector('video[data-dual-video="left"]')?.dispatchEvent(new Event('error')),
    );
    await expect(page.locator('[data-dual-error]')).toBeVisible();
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);

    // Con el sonido en marcha, bloquear (Ctrl+L) sustituye la ventana y no deja nada activo.
    await setSides(LEFT_NAME, RIGHT_NAME);
    await controls(page, 'sync').getByRole('button', { name: 'Reproducir (K)' }).click();
    await expect.poll(() => autoLockReasons(launched.app), SLOW).toContain('playback');
    const next = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+l'));
    expect(next).toBeTruthy();
    await expect.poll(() => autoLockReasons(launched.app)).toEqual([]);
    await expect.poll(() => displaySleepBlocked(launched.app)).toBe(false);
  });
});
