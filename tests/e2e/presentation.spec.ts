// Presentación (docs/PLAN.md 4.6 y 4.7; docs/DESIGN.md §17, §22, §23.2): inicio desde una selección y
// desde una playlist, bucle, transición y duración, los cuatro modos de audio con las ganancias reales
// de Web Audio (gancho `__galeriaPresentation`, solo sin empaquetar), teclado y controles que se
// ocultan, ventana y pantalla completa (simulada, nota 157), fin sin bucle y sin transiciones, y la
// pausa del temporizador de inactividad con su liberación (fin, error, recarga y bloqueo). Ventana
// discreta (nota 135) y sin sonido (el audio se procesa pero no sale), medios sintéticos.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { lockAndGetNewWindow, unlockProfile } from './helpers/launch';
import { removeDir, PASSWORD, PROFILE } from './helpers/library';
import {
  addSelectionToNewPlaylist,
  clickSelect,
  invokeIpc,
  openGallery,
  openPlaylistDetail,
  selectionBar,
} from './helpers/playlists';
import {
  autoLockReasons,
  controlsBar,
  displayBlocked,
  exitPresentation,
  fullscreenCalls,
  GALLERY_ORDER,
  launchWithMedia,
  openSetupFromSelection,
  presentation,
  presState,
  saveDefaults,
  setupDialog,
  startPresentation,
  waitState,
  type PresentationFixture,
  type PresentationState,
} from './helpers/presentation';

test.describe.configure({ mode: 'serial' });

let fx: PresentationFixture;
let page: Page;
const pageErrors: string[] = [];

/** Valores base de las pruebas: rápidos, en ventana y sin música; cada prueba cambia lo suyo. */
const BASE = {
  transition: 'fade',
  randomPool: ['fade', 'slide', 'zoom', 'kenburns'],
  transitionMs: 200,
  slideMs: 1000,
  loop: true,
  animations: true,
  startFullscreen: false,
  audioMode: 'video',
  musicEnabled: false,
  musicVolume: 0.7,
  videoVolume: 1,
  musicFadeMs: 300,
};

test.beforeAll(async () => {
  test.setTimeout(300_000);
  fx = await launchWithMedia();
  page = fx.page;
  page.on('pageerror', (e) => pageErrors.push(e.message));
});

test.afterAll(async () => {
  await fx?.launched.close();
  if (fx?.src) removeDir(fx.src);
});

test.afterEach(async () => {
  expect(pageErrors).toEqual([]);
  if (page.isClosed()) return; // la prueba de bloqueo sustituye la ventana
  // Cada prueba deja la galería como estaba.
  await exitPresentation(page);
  await page.keyboard.press('Escape');
  const cancel = selectionBar(page).getByRole('button', { name: 'Cancelar selección' });
  if (await cancel.isVisible()) await cancel.click();
});

const reasons = (): Promise<string[]> => autoLockReasons(fx.app);

/** Hace visible la barra (el ratón la mantiene a la vista). */
async function showControls(): Promise<void> {
  await page.mouse.move(500 + Math.floor(Math.random() * 100), 700);
  await expect(controlsBar(page)).toHaveAttribute('data-visible', 'true');
}

async function setSwitch(sw: Locator, want: boolean): Promise<void> {
  if ((await sw.isChecked()) !== want) await sw.click();
  if (want) await expect(sw).toBeChecked();
  else await expect(sw).not.toBeChecked();
}

/** Abre el menú de audio de la barra. */
async function openAudioMenu(): Promise<Locator> {
  await showControls();
  await controlsBar(page).getByRole('button', { name: 'Audio', exact: true }).click();
  const menu = page.locator('[data-presentation-audio-menu]');
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-presentation-audio-menu]')).toBeHidden();
  await expect(presentation(page)).toBeVisible();
}

/** «Silenciar vídeos», «Música de fondo» y «Mantener la música durante los vídeos» (D16). */
async function setAudio(silence: boolean, musicOn: boolean, keep: boolean): Promise<void> {
  const menu = await openAudioMenu();
  await setSwitch(menu.getByRole('switch', { name: 'Silenciar vídeos' }), silence);
  await setSwitch(menu.getByRole('switch', { name: 'Música de fondo' }), musicOn);
  if (musicOn) {
    await setSwitch(
      menu.getByRole('switch', { name: 'Mantener la música durante los vídeos' }),
      keep,
    );
  }
  await closeMenu();
}

const near = (a: number | null, b: number | null, eps = 0.04): boolean =>
  a !== null && b !== null && Math.abs(a - b) <= eps;

/** Espera a que las ganancias estén en lo que dice el plan de la diapositiva actual. */
async function waitGainsSettled(slot: number | null): Promise<PresentationState> {
  return waitState(
    page,
    (s) =>
      near(s.musicGain, s.musicTarget) &&
      s.videoGains.every((g, i) => near(g, i === slot ? s.videoTarget : 0)),
    'las ganancias llegan a lo previsto',
    15_000,
  );
}

test('desde una selección: arranca en pantalla completa, avanza en el orden de la galería y vuelve a la primera (bucle)', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, { ...BASE, startFullscreen: true });
  const cells = await page
    .getByRole('grid', { name: 'Galería' })
    .getByRole('gridcell')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  expect(cells.map((c) => c.replace(/, vídeo.*$/, ''))).toEqual([...GALLERY_ORDER]);

  await openSetupFromSelection(page, [0, 1, 2, 3]);
  const dialog = setupDialog(page);
  // Los valores efectivos son los guardados.
  await expect(dialog.getByRole('combobox', { name: 'Tipo de transición' })).toHaveText('Fundido');
  await expect(dialog.getByRole('switch', { name: 'Transiciones' })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Animaciones' })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Repetir en bucle' })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Empezar en pantalla completa' })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Silenciar vídeos' })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Música de fondo' })).not.toBeChecked();
  await startPresentation(page);

  // Pantalla completa por defecto (doble de la nota 157).
  await expect.poll(() => fullscreenCalls(fx.app)).toEqual([true]);
  await expect(presentation(page)).toHaveAttribute('data-presentation-fullscreen', 'true');
  await expect(presentation(page)).toHaveAccessibleName('Presentación');

  // Recorre 0 → 1 → 2 → 3 → 0: la última da la vuelta a la primera.
  const seen: number[] = [];
  await expect
    .poll(
      async () => {
        const s = await presState(page);
        if (s?.slideIndex != null && s.phase === 'showing' && seen.at(-1) !== s.slideIndex) {
          seen.push(s.slideIndex);
        }
        return seen.length >= 5 ? seen : null;
      },
      { timeout: 60_000, intervals: [50] },
    )
    .toEqual([0, 1, 2, 3, 0]);
  await expect(presentation(page)).toHaveAttribute('data-slide-index', /^[0-3]$/);
  await expect(presentation(page)).toHaveAttribute('data-phase', /^(entering|showing)$/);
  // Al salir se restaura la ventana.
  await exitPresentation(page);
  await expect.poll(() => fullscreenCalls(fx.app)).toEqual([true, false]);
});

test('desde una playlist: usa su música y sus ajustes propios, y también vuelve a la primera', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, BASE);
  await openGallery(page);
  await clickSelect(page, [0, 2, 3]); // Foto C, Foto B, Foto A
  await addSelectionToNewPlaylist(page, 'Vacaciones');
  const lists = await invokeIpc<{ id: string; name: string }[]>(page, 'playlists:list');
  const playlist = lists.find((p) => p.name === 'Vacaciones');
  expect(playlist).toBeTruthy();
  const own = await invokeIpc<{ settings: Record<string, unknown> }>(
    page,
    'presentation:getConfig',
    { playlistId: playlist?.id },
  );
  await invokeIpc(page, 'playlists:setPresentation', {
    id: playlist?.id,
    settings: {
      ...own.settings,
      ...BASE,
      slideMs: 1500,
      musicEnabled: true,
      trackIds: [fx.track2.id],
    },
  });
  await page.keyboard.press('Escape');
  await openPlaylistDetail(page, 'Vacaciones');
  await page.getByRole('button', { name: 'Reproducir presentación' }).click();
  const dialog = setupDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('3 elementos de «Vacaciones»');
  await expect(dialog.getByRole('checkbox', { name: /Tono dos/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Tono uno/ })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Música de fondo' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Guardar para esta playlist' })).toBeVisible();
  await startPresentation(page);

  const first = await waitState(page, (s) => s.phase === 'showing', 'primera foto');
  expect(first.trackId).toBe(fx.track2.id);
  expect(first.slideMs).toBe(1500);
  expect(first.total).toBe(3);
  const seen: number[] = [];
  await expect
    .poll(
      async () => {
        const s = await presState(page);
        if (s?.slideIndex != null && s.phase === 'showing' && seen.at(-1) !== s.slideIndex) {
          seen.push(s.slideIndex);
        }
        return seen.length >= 4 ? seen : null;
      },
      { timeout: 60_000, intervals: [50] },
    )
    .toEqual([0, 1, 2, 0]);
  // Windowed: la playlist guardó `startFullscreen: false`.
  await expect(presentation(page)).toHaveAttribute('data-presentation-fullscreen', 'false');
  await exitPresentation(page);
  // Los medios siguen en la galería y la playlist también.
  await openGallery(page);
  await expect(page.getByText('4 elementos', { exact: true })).toBeVisible();
});

test('cambiar la transición y la duración en el diálogo y en vivo; sin transiciones es un corte', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, { ...BASE, slideMs: 5000, transitionMs: 700 });
  await openGallery(page);
  await openSetupFromSelection(page, [0, 2, 3]);
  const dialog = setupDialog(page);

  await dialog.getByRole('combobox', { name: 'Tipo de transición' }).click();
  await page.getByRole('option', { name: 'Deslizar' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Tipo de transición' })).toHaveText('Deslizar');
  const photo = dialog.getByRole('slider', { name: 'Duración de cada foto' });
  await photo.focus();
  await page.keyboard.press('Home'); // 1 s
  await page.keyboard.press('ArrowRight'); // 1,5 s
  await page.keyboard.press('ArrowRight'); // 2 s
  await expect(photo).toHaveAttribute('aria-valuetext', '2 s');
  const fade = dialog.getByRole('slider', { name: 'Duración de la transición' });
  await fade.focus();
  await page.keyboard.press('Home'); // 0,1 s
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight'); // 0,4 s
  await expect(fade).toHaveAttribute('aria-valuetext', '0,4 s');
  await startPresentation(page);

  const s0 = await waitState(page, (s) => s.phase === 'showing' && s.slideIndex === 0, 'foto 0');
  expect(s0.transitionSetting).toBe('slide');
  expect(s0.slideMs).toBe(2000);
  expect(s0.transition).toEqual({ type: 'slide', durationMs: 400 });
  const t0 = Date.now();
  await waitState(page, (s) => s.slideIndex === 1 && s.phase === 'showing', 'foto 1');
  const elapsed = Date.now() - t0;
  // slideMs (2 s) + transición (0,4 s), con holgura por el sondeo.
  expect(elapsed).toBeGreaterThan(1500);
  expect(elapsed).toBeLessThan(4500);

  // En vivo: panel de ajustes → Zoom; vale desde la diapositiva siguiente.
  await showControls();
  await controlsBar(page).getByRole('button', { name: 'Ajustes de la presentación' }).click();
  const panel = page.getByRole('region', { name: 'Ajustes de la presentación' });
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox', { name: 'Tipo de transición' }).click();
  await page.getByRole('option', { name: 'Zoom', exact: true }).click();
  await waitState(page, (s) => s.slideIndex === 2 && s.transition?.type === 'zoom', 'zoom en la 2');
  // Sin transiciones: corte instantáneo.
  await setSwitch(panel.getByRole('switch', { name: 'Transiciones' }), false);
  await waitState(
    page,
    (s) => s.transition?.type === 'none' && s.transition.durationMs === 0,
    'corte instantáneo',
  );
  // «Animaciones» apagadas con Ken Burns: se queda en el fundido.
  await setSwitch(panel.getByRole('switch', { name: 'Transiciones' }), true);
  await panel.getByRole('combobox', { name: 'Tipo de transición' }).click();
  await page.getByRole('option', { name: /Paneo lento/ }).click();
  await setSwitch(panel.getByRole('switch', { name: 'Animaciones' }), false);
  await waitState(
    page,
    (s) => s.transition?.type === 'fade' && s.animations === false,
    'sin Ken Burns',
  );
  // Esc cierra el panel antes de salir de la presentación.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(presentation(page)).toBeVisible();
});

test('los cuatro modos de audio con las ganancias de Web Audio; la música baja en el vídeo y se reanuda', async () => {
  test.setTimeout(240_000);
  await saveDefaults(page, { ...BASE, slideMs: 60_000, musicEnabled: true, musicFadeMs: 600 }, [
    fx.track.id,
  ]);
  await openGallery(page);
  await openSetupFromSelection(page, [0, 1, 2, 3]);
  await startPresentation(page);
  const first = await waitState(
    page,
    (s) => s.phase === 'showing' && s.slideIndex === 0 && (s.musicGain ?? 0) > 0.6,
    'foto 0 con la música',
    20_000,
  );
  expect(first.audio).toBe('webaudio');
  expect(first.audioContext).toBe('running');
  expect(first.audioMode).toBe('video');
  expect(first.trackId).toBe(fx.track.id);
  expect(first.musicPaused).toBe(false);

  const modes: [string, boolean, boolean, boolean, 'sound' | 'silent', 'sound' | 'silent'][] = [
    // modo, silenciar vídeos, música de fondo, mantener la música; música y vídeo durante el vídeo
    ['video', false, true, false, 'silent', 'sound'], // por defecto: solo el audio del vídeo
    ['music', true, true, true, 'sound', 'silent'], // solo la música
    ['both', false, true, true, 'sound', 'sound'], // los dos
    ['mute', true, true, false, 'silent', 'silent'], // silencio en los vídeos (música en las fotos)
  ];
  for (const [mode, silence, musicOn, keep, music, video] of modes) {
    await setAudio(silence, musicOn, keep);
    const photo = await waitState(page, (s) => s.audioMode === mode, `modo ${mode}`);
    expect(photo.musicEnabled).toBe(true);
    // En la foto la música suena a musicVolume en todos los modos.
    const onPhoto = await waitGainsSettled(null);
    expect(onPhoto.slideKind).toBe('photo');
    expect(onPhoto.musicGain).toBeGreaterThan(0.6);
    const before = onPhoto.musicTime;

    await page.keyboard.press('ArrowRight');
    const entering = await waitState(
      page,
      (s) => s.slideIndex === 1 && s.slideKind === 'video',
      'el vídeo entra',
    );
    const slot = entering.layers.find((l) => l.index === 1)?.slot ?? null;
    expect(slot).not.toBeNull();
    await waitState(
      page,
      (s) => s.slideIndex === 1 && s.phase === 'showing',
      'el vídeo se muestra',
    );
    const inVideo = await waitGainsSettled(slot);
    expect(inVideo.plan).toEqual({ music, videoAudio: video });
    expect(inVideo.musicGain).toBeCloseTo(music === 'sound' ? 0.7 : 0, 1);
    expect(inVideo.videoGains[slot as number]).toBeCloseTo(video === 'sound' ? 1 : 0, 1);
    expect(inVideo.videoPlaying[slot as number]).toBe(true);
    if (music === 'silent') {
      await waitState(page, (s) => s.musicPaused, 'la música se pausa al acabar el fundido');
    } else {
      expect(inVideo.musicPaused).toBe(false);
    }

    // Al salir del vídeo, la música vuelve donde se quedó.
    await page.keyboard.press('ArrowLeft');
    await waitState(page, (s) => s.slideIndex === 0 && s.phase === 'showing', 'vuelve a la foto');
    const back = await waitGainsSettled(null);
    expect(back.musicGain).toBeGreaterThan(0.6);
    expect(back.musicPaused).toBe(false);
    expect(back.musicTime).toBeGreaterThanOrEqual(before);
    expect(back.musicTime).toBeLessThan(39); // sigue en la pista, no empezó otra
    console.log(`[e2e] modo ${mode}: música ${music}, vídeo ${video} verificados`);
  }

  // Silencio total: «Silenciar vídeos» + sin música de fondo. Nada suena, ni en las fotos.
  await setAudio(true, false, false);
  await waitState(page, (s) => s.audioMode === 'mute' && !s.musicEnabled, 'silencio total');
  const quiet = await waitGainsSettled(null);
  expect(quiet.musicGain).toBeCloseTo(0, 1);
  await waitState(page, (s) => s.musicPaused, 'la música se pausa');
  await page.keyboard.press('ArrowRight');
  await waitState(page, (s) => s.slideIndex === 1 && s.phase === 'showing', 'el vídeo');
  const inQuiet = await waitGainsSettled(
    (await presState(page))?.layers.find((l) => l.index === 1)?.slot ?? null,
  );
  expect(inQuiet.musicGain).toBeCloseTo(0, 1);
  expect(inQuiet.videoGains.every((g) => g !== null && g < 0.05)).toBe(true);
});

test('cambiar el volumen de la música en mitad de un fundido no produce ningún error', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, { ...BASE, slideMs: 60_000, musicEnabled: true, musicFadeMs: 5000 }, [
    fx.track.id,
  ]);
  await openGallery(page);
  await openSetupFromSelection(page, [0, 1, 2, 3]);
  await startPresentation(page);
  await waitState(page, (s) => s.slideIndex === 0 && (s.musicGain ?? 0) > 0.6, 'música', 20_000);
  // Fundido largo (5 s, el máximo): la ventana «a mitad» dura segundos y no depende de la CPU. Al vídeo
  // la música baja; se cambia el volumen en mitad.
  await page.keyboard.press('ArrowRight');
  await waitState(
    page,
    (s) => s.slideIndex === 1 && (s.musicGain ?? 1) < 0.3 && (s.musicGain ?? 0) > 0.05,
    'a mitad del fundido de bajada',
    20_000,
  );
  let menu = await openAudioMenu();
  const volume = menu.getByRole('slider', { name: 'Volumen de la música' });
  await volume.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowLeft');
  await closeMenu();
  // De vuelta a la foto: sube durante 5 s; otra vez en mitad. Con la CPU saturada el vídeo (12 s)
  // puede acabar mientras se maneja el menú y la presentación ya va por la foto siguiente: se
  // retrocede hasta la 0 (solo del test; el recorrido de audio es el mismo).
  for (let guard = 0; guard < 4; guard += 1) {
    const current = await waitState(page, (s) => (s.slideIndex ?? -1) >= 0, 'una diapositiva');
    const before = current.slideIndex;
    await page.keyboard.press('ArrowLeft');
    await waitState(page, (s) => s.slideIndex !== before, 'la diapositiva anterior');
    if (before === 1) break; // caso normal: de la 1 (vídeo) a la 0
  }
  await waitState(
    page,
    (s) => s.slideIndex === 0 && (s.musicGain ?? 0) > 0.05 && (s.musicGain ?? 1) < 0.45,
    'a mitad del fundido de subida',
    20_000,
  );
  menu = await openAudioMenu();
  await menu.getByRole('slider', { name: 'Volumen de la música' }).focus();
  for (let i = 0; i < 2; i += 1) await page.keyboard.press('ArrowRight');
  await closeMenu();
  // Acaba en el volumen nuevo (0,7 − 0,20 + 0,10 = 0,60).
  const done = await waitState(
    page,
    (s) => s.slideIndex === 0 && near(s.musicGain, 0.6, 0.03),
    'el volumen nuevo',
    25_000,
  );
  expect(done.musicVolume).toBeCloseTo(0.6, 2);
  expect(pageErrors).toEqual([]);
});

test('teclado y controles: Espacio, flechas, M, los botones, ocultarse a los 3 s y Esc en dos pasos', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, { ...BASE, slideMs: 60_000, musicEnabled: true }, [fx.track.id]);
  await openGallery(page);
  await openSetupFromSelection(page, [0, 1, 2, 3]);
  await startPresentation(page);
  await waitState(page, (s) => s.slideIndex === 0 && s.phase === 'showing', 'foto 0');
  const dialog = presentation(page);
  await expect(dialog).toBeFocused();
  await expect(controlsBar(page).locator('[data-presentation-position]')).toHaveText('1 / 4');

  // Espacio pausa y reanuda; la música también.
  await page.keyboard.press('Space');
  await waitState(page, (s) => s.paused && s.musicPaused, 'pausada');
  await expect(controlsBar(page).getByRole('button', { name: /^Reanudar/ })).toBeVisible();
  await page.keyboard.press('Space');
  await waitState(page, (s) => !s.paused && !s.musicPaused, 'reanudada');
  // → y ← navegan; la posición y el anuncio cambian.
  await page.keyboard.press('ArrowRight');
  await waitState(page, (s) => s.slideIndex === 1 && s.phase === 'showing', 'vídeo');
  await expect(controlsBar(page).locator('[data-presentation-position]')).toHaveText('2 / 4');
  await expect(page.getByRole('status').filter({ hasText: 'Diapositiva 2 de 4' })).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await waitState(page, (s) => s.slideIndex === 0 && s.phase === 'showing', 'foto 0 otra vez');
  // M apaga y enciende la música.
  await page.keyboard.press('m');
  await waitState(page, (s) => !s.musicEnabled, 'sin música');
  await page.keyboard.press('m');
  await waitState(page, (s) => s.musicEnabled, 'con música');
  // Los botones de la barra.
  await showControls();
  await controlsBar(page)
    .getByRole('button', { name: /^Siguiente/ })
    .click();
  await waitState(page, (s) => s.slideIndex === 1 && s.phase === 'showing', 'siguiente (botón)');
  await controlsBar(page)
    .getByRole('button', { name: /^Anterior/ })
    .click();
  await waitState(page, (s) => s.slideIndex === 0 && s.phase === 'showing', 'anterior (botón)');

  // La barra se oculta a los 3 s sin movimiento y vuelve con una tecla o el ratón.
  await page.mouse.move(5, 300);
  await expect(controlsBar(page)).toHaveAttribute('data-visible', 'false', { timeout: 10_000 });
  await expect(controlsBar(page)).toHaveCSS('opacity', '0');
  await page.keyboard.press('ArrowRight');
  await expect(controlsBar(page)).toHaveAttribute('data-visible', 'true');
  await page.keyboard.press('ArrowLeft');

  // Esc cierra el panel de ajustes y, con otro Esc, se sale.
  await showControls();
  await controlsBar(page).getByRole('button', { name: 'Ajustes de la presentación' }).click();
  const panel = page.getByRole('region', { name: 'Ajustes de la presentación' });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // El foco vuelve al control que la inició.
  await expect(selectionBar(page).getByRole('button', { name: 'Presentación' })).toBeFocused();
});

test('ventana y pantalla completa: la barra de título sigue en modo ventana; F alterna; se restaura al salir', async () => {
  test.setTimeout(90_000);
  await saveDefaults(page, { ...BASE, slideMs: 60_000, startFullscreen: false });
  await openGallery(page);
  const calls0 = (await fullscreenCalls(fx.app)).length;
  await openSetupFromSelection(page, [0, 2]);
  await expect(
    setupDialog(page).getByRole('switch', { name: 'Empezar en pantalla completa' }),
  ).not.toBeChecked();
  await startPresentation(page);
  await waitState(page, (s) => s.phase === 'showing', 'foto');
  // Ventana: sin llamadas a la pantalla completa, bajo la barra de título (2 rem = 32 px) visible.
  expect((await fullscreenCalls(fx.app)).length).toBe(calls0);
  await expect(presentation(page)).toHaveAttribute('data-presentation-fullscreen', 'false');
  const windowed = await page.evaluate(() => {
    const box = document.querySelector('[data-presentation]')?.getBoundingClientRect();
    const hit = document.elementFromPoint(300, 10);
    return { top: box?.top ?? -1, titlebar: !!hit?.closest('header'), width: box?.width ?? 0 };
  });
  expect(windowed.top).toBe(32);
  expect(windowed.titlebar).toBe(true);
  expect(windowed.width).toBeGreaterThanOrEqual(1200);

  // F entra en pantalla completa (cubre la barra de título) y vuelve a salir.
  await page.keyboard.press('f');
  await expect.poll(async () => (await fullscreenCalls(fx.app)).slice(calls0)).toEqual([true]);
  await expect(presentation(page)).toHaveAttribute('data-presentation-fullscreen', 'true');
  expect(
    await page.evaluate(
      () => document.querySelector('[data-presentation]')?.getBoundingClientRect().top,
    ),
  ).toBe(0);
  await showControls();
  await expect(
    controlsBar(page).getByRole('button', { name: /^Salir de pantalla completa/ }),
  ).toBeVisible();
  await page.keyboard.press('f');
  await expect
    .poll(async () => (await fullscreenCalls(fx.app)).slice(calls0))
    .toEqual([true, false]);
  await expect(presentation(page)).toHaveAttribute('data-presentation-fullscreen', 'false');
  // Si se sale en pantalla completa, se restaura el estado anterior (ventana).
  await page.keyboard.press('f');
  await expect(presentation(page)).toHaveAttribute('data-presentation-fullscreen', 'true');
  await exitPresentation(page);
  await expect
    .poll(async () => (await fullscreenCalls(fx.app)).slice(calls0))
    .toEqual([true, false, true, false]);
});

test('sin bucle: «Fin de la presentación» con Volver a empezar (Intro) y Salir (Esc); sin transiciones es un corte', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, { ...BASE, loop: false, transition: 'none' });
  await openGallery(page);
  await openSetupFromSelection(page, [0, 1, 3]);
  const dialog = setupDialog(page);
  await expect(dialog.getByRole('switch', { name: 'Transiciones' })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Repetir en bucle' })).not.toBeChecked();
  await startPresentation(page);

  const first = await waitState(page, (s) => s.phase === 'showing', 'primera');
  expect(first.transition).toEqual({ type: 'none', durationMs: 0 });
  const end = presentation(page).locator('[data-presentation-end]');
  await expect(end).toBeVisible({ timeout: 40_000 });
  await expect(end.getByRole('heading', { name: 'Fin de la presentación' })).toBeVisible();
  const last = await presState(page);
  expect(last?.finished).toBe(true);
  expect(last?.slideIndex).toBe(2);
  expect(last?.transition).toEqual({ type: 'none', durationMs: 0 });
  await expect.poll(reasons).toEqual([]); // acabó: se suelta el temporizador
  // Intro (con el foco en «Volver a empezar») vuelve a empezar por la primera.
  await expect(end.getByRole('button', { name: 'Volver a empezar' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(end).toHaveCount(0);
  await waitState(page, (s) => s.slideIndex === 0 && !s.finished, 'empieza otra vez');
  await expect.poll(reasons).toContain('playback');
  await expect(end).toHaveCount(0);
});

test('el temporizador de inactividad y la pantalla encendida: pausados mientras se reproduce y liberados al pausar, salir y fallar', async () => {
  test.setTimeout(120_000);
  await saveDefaults(page, { ...BASE, slideMs: 60_000 });
  await openGallery(page);
  await expect.poll(reasons).toEqual([]);
  await openSetupFromSelection(page, [0, 2]);
  await startPresentation(page);
  await waitState(page, (s) => s.phase === 'showing', 'foto');
  // Mientras se reproduce: motivo 'playback', pantalla encendida y fondo animado en pausa.
  await expect.poll(reasons).toEqual(['playback']);
  await expect.poll(() => displayBlocked(fx.app)).toBe(true);
  await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'true');
  // Pausar lo suelta; reanudar lo vuelve a pedir.
  await page.keyboard.press('Space');
  await expect.poll(reasons).toEqual([]);
  await expect.poll(() => displayBlocked(fx.app)).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(reasons).toEqual(['playback']);
  // Salir lo suelta todo.
  await exitPresentation(page);
  await expect.poll(reasons).toEqual([]);
  await expect.poll(() => displayBlocked(fx.app)).toBe(false);
  await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'false');

  // Por un error: el único elemento (un vídeo sonando) falla → sale solo y lo suelta todo.
  await openGallery(page);
  await openSetupFromSelection(page, [1]);
  await startPresentation(page);
  await waitState(page, (s) => s.phase === 'showing' && s.slideKind === 'video', 'vídeo');
  await expect.poll(reasons).toEqual(['playback']);
  await page.evaluate(() => {
    document
      .querySelector<HTMLVideoElement>('[data-slide-layer] video')
      ?.dispatchEvent(new Event('error'));
  });
  await expect(presentation(page)).toHaveCount(0);
  await expect(
    page.getByText('No se pudo reproducir ningún elemento', { exact: true }),
  ).toBeVisible();
  await expect.poll(reasons).toEqual([]);
  await expect.poll(() => displayBlocked(fx.app)).toBe(false);
  await expect(page.locator('[data-background]')).toHaveAttribute('data-paused', 'false');
});

/**
 * Pruebas que sustituyen la ventana o recargan el renderer: cada una con su propia app, para no
 * dejar sin página a las demás.
 */
async function withOwnApp(body: (own: PresentationFixture) => Promise<void>): Promise<void> {
  const own = await launchWithMedia();
  try {
    await body(own);
  } finally {
    await own.launched.close();
    removeDir(own.src);
  }
}

async function startOnPhotos(own: PresentationFixture, trackIds: string[] = []): Promise<void> {
  await saveDefaults(
    own.page,
    { ...BASE, slideMs: 60_000, musicEnabled: trackIds.length > 0 },
    trackIds,
  );
  await openSetupFromSelection(own.page, [0, 2]);
  await startPresentation(own.page);
  await waitState(
    own.page,
    (s) => s.phase === 'showing' && (trackIds.length === 0 || (s.musicGain ?? 0) > 0.3),
    'foto',
    20_000,
  );
  await expect.poll(() => autoLockReasons(own.app)).toEqual(['playback']);
  await expect.poll(() => displayBlocked(own.app)).toBe(true);
}

test('al recargar el renderer durante una presentación se libera todo', async () => {
  test.setTimeout(240_000);
  await withOwnApp(async (own) => {
    await startOnPhotos(own);
    await own.page.reload().catch(() => undefined);
    await expect.poll(() => autoLockReasons(own.app), { timeout: 15_000 }).toEqual([]);
    await expect.poll(() => displayBlocked(own.app)).toBe(false);
    // La app sigue viva y con una ventana usable.
    await expect
      .poll(() => own.app.windows().filter((w) => !w.isClosed()).length)
      .toBeGreaterThan(0);
  });
});

test('al bloquear la sesión durante una presentación se libera todo', async () => {
  test.setTimeout(240_000);
  await withOwnApp(async (own) => {
    await startOnPhotos(own, [own.track.id]);
    const locked = await lockAndGetNewWindow(own.app, () => own.page.keyboard.press('Control+L'));
    await expect.poll(() => autoLockReasons(own.app)).toEqual([]);
    await expect.poll(() => displayBlocked(own.app)).toBe(false);
    // La ventana nueva no tiene presentación y se puede volver a entrar.
    await expect(locked.locator('[data-presentation]')).toHaveCount(0);
    await unlockProfile(locked, PROFILE, PASSWORD);
    await expect(locked.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
    expect(await presState(locked)).toBeNull();
  });
});
