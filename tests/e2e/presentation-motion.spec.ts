// Movimiento real de la presentación (docs/PLAN.md notas 190 y 191; docs/DESIGN.md §17.3). Los
// E2E de la Fase 4 solo miraban `transition.type` y el estado, nunca lo que el navegador pinta: por
// eso nadie vio que, con los valores por defecto, las diapositivas se quedaban quietas. Aquí se
// muestrea el estilo computado (opacidad y transform) de cada capa durante un cambio de diapositiva
// y el transform del contenido (Ken Burns) con ~500 ms de diferencia, con
// `emulateMedia({ reducedMotion })` en 'reduce' y en 'no-preference': la elección de transición y de
// animaciones es del usuario y se respeta aunque el sistema pida reducir el movimiento.
// Ventana discreta (nota 135), pantalla completa simulada, fotos sintéticas bajo tests/.tmp/.
import { expect, test, type Page } from '@playwright/test';
import { removeDir } from './helpers/library';
import { selectionBar } from './helpers/playlists';
import {
  exitPresentation,
  launchWithMedia,
  openSetupFromSelection,
  saveDefaults,
  setupDialog,
  startPresentation,
  waitState,
  type PresentationFixture,
} from './helpers/presentation';

test.describe.configure({ mode: 'serial' });

interface LayerSample {
  index: number;
  role: string;
  opacity: number;
  transform: string;
  content: string;
}
interface Frame {
  t: number;
  layers: LayerSample[];
}

const BASE = {
  transition: 'fade',
  randomPool: ['fade', 'slide', 'zoom', 'kenburns'],
  transitionMs: 1500,
  slideMs: 2000,
  loop: true,
  animations: true,
  startFullscreen: false,
  audioMode: 'video',
  musicEnabled: false,
  musicVolume: 0.7,
  videoVolume: 1,
  musicFadeMs: 300,
};

/** Muestrea cada ~30 ms el estilo computado de todas las capas durante `ms`. */
function sampleLayers(page: Page, ms: number): Promise<Frame[]> {
  return page.evaluate(async (duration) => {
    const frames: Frame[] = [];
    const start = performance.now();
    while (performance.now() - start < duration) {
      const layers = [...document.querySelectorAll<HTMLElement>('[data-slide-layer]')].map((l) => ({
        index: Number(l.dataset.slideLayer),
        role: l.dataset.slideRole ?? '',
        opacity: Number(getComputedStyle(l).opacity),
        transform: getComputedStyle(l).transform,
        content: l.firstElementChild ? getComputedStyle(l.firstElementChild).transform : 'none',
      }));
      frames.push({ t: performance.now() - start, layers });
      await new Promise((r) => setTimeout(r, 30));
    }
    return frames;
  }, ms);
}

/** Transform del contenido de la capa de la diapositiva que se está mostrando. */
function currentContentTransform(page: Page): Promise<string> {
  return page.evaluate(() => {
    const layer = document.querySelector('[data-slide-layer][data-slide-role="current"]');
    return layer?.firstElementChild ? getComputedStyle(layer.firstElementChild).transform : 'none';
  });
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Valores distintos de la capa `entering` que cumplen `pick`. */
function enteringValues<T>(frames: Frame[], pick: (l: LayerSample) => T | null): T[] {
  const out = new Set<T>();
  for (const f of frames) {
    for (const l of f.layers) {
      if (l.role !== 'entering') continue;
      const v = pick(l);
      if (v !== null) out.add(v);
    }
  }
  return [...out];
}

const intermediateOpacity = (l: LayerSample): number | null =>
  l.opacity > 0.05 && l.opacity < 0.95 ? round(l.opacity) : null;

let fx: PresentationFixture;
let page: Page;
const pageErrors: string[] = [];

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
  await exitPresentation(page);
  await page.keyboard.press('Escape');
  const cancel = selectionBar(page).getByRole('button', { name: 'Cancelar selección' });
  if (await cancel.isVisible()) await cancel.click();
});

/** Guarda los ajustes, inicia con Foto C, B y A y espera a que la primera esté ya en pantalla. */
async function startWith(patch: Record<string, unknown>): Promise<void> {
  await saveDefaults(page, { ...BASE, ...patch });
  await openSetupFromSelection(page, [0, 2, 3]);
  await startPresentation(page);
  await waitState(page, (s) => s.phase === 'showing' && s.slideIndex === 0, 'primera foto', 45_000);
}

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test.describe(`prefers-reduced-motion: ${reducedMotion}`, () => {
    test.beforeEach(async () => {
      // Antes de abrir el diálogo: la presentación lo leería al empezar.
      await page.emulateMedia({ reducedMotion });
    });

    test('valor real del sistema (informativo)', async () => {
      await page.emulateMedia({ reducedMotion: null });
      const real = await page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
      test.info().annotations.push({ type: 'prefers-reduced-motion real', description: `${real}` });
      console.log(`[e2e] prefers-reduced-motion real de este PC: ${real}`);
      await page.emulateMedia({ reducedMotion });
    });

    test('fundido con los valores por defecto: opacidad intermedia y Ken Burns', async () => {
      test.setTimeout(120_000);
      await startWith({ transition: 'fade', animations: true });
      // Ken Burns: el contenido de la foto se mueve entre dos muestras separadas ~500 ms.
      const a = await currentContentTransform(page);
      await page.waitForTimeout(500);
      const b = await currentContentTransform(page);
      expect(a, 'la foto tiene Ken Burns').not.toBe('none');
      expect(b).not.toBe(a);
      // Fundido: la capa entrante pasa por ≥ 3 opacidades intermedias distintas.
      const frames = await sampleLayers(page, 4200);
      const values = enteringValues(frames, intermediateOpacity);
      expect(values.length, `opacidades intermedias: ${values.join(', ')}`).toBeGreaterThanOrEqual(
        3,
      );
    });

    test('deslizar: la capa entrante se traslada', async () => {
      test.setTimeout(120_000);
      await startWith({ transition: 'slide', animations: true });
      const frames = await sampleLayers(page, 4200);
      const values = enteringValues(frames, (l) => l.transform);
      expect(values.length, `transforms: ${values.join(' | ')}`).toBeGreaterThanOrEqual(3);
    });

    test('zoom: opacidad y escala de la capa entrante', async () => {
      test.setTimeout(120_000);
      await startWith({ transition: 'zoom', animations: true });
      const frames = await sampleLayers(page, 4200);
      const opacities = enteringValues(frames, intermediateOpacity);
      const transforms = enteringValues(frames, (l) => l.transform);
      expect(opacities.length).toBeGreaterThanOrEqual(3);
      expect(transforms.length, `transforms: ${transforms.join(' | ')}`).toBeGreaterThanOrEqual(3);
    });

    test('sin transición con animaciones: corte, pero la foto se mueve', async () => {
      test.setTimeout(120_000);
      await startWith({ transition: 'none', animations: true });
      const a = await currentContentTransform(page);
      await page.waitForTimeout(500);
      const b = await currentContentTransform(page);
      expect(a, 'la foto tiene Ken Burns').not.toBe('none');
      expect(b).not.toBe(a);
      const frames = await sampleLayers(page, 3500);
      const opacities = new Set(frames.flatMap((f) => f.layers.map((l) => round(l.opacity))));
      expect([...opacities].filter((o) => o !== 0 && o !== 1)).toEqual([]);
      const state = await waitState(page, (s) => s.slideIndex !== 0, 'cambió de diapositiva');
      expect(state.transition).toEqual({ type: 'none', durationMs: 0 });
    });

    test('fundido con animaciones apagadas: se funde y la foto no se mueve', async () => {
      test.setTimeout(120_000);
      await startWith({ transition: 'fade', animations: false });
      const frames = await sampleLayers(page, 4200);
      expect(enteringValues(frames, intermediateOpacity).length).toBeGreaterThanOrEqual(3);
      const contents = new Set(frames.flatMap((f) => f.layers.map((l) => l.content)));
      expect([...contents]).toEqual(['none']);
    });

    test('sin transición y sin animaciones: todo estático', async () => {
      test.setTimeout(120_000);
      await startWith({ transition: 'none', animations: false });
      const frames = await sampleLayers(page, 4500);
      const state = await waitState(page, (s) => (s.slideIndex ?? 0) >= 1, 'cambió de diapositiva');
      expect(state.transition).toEqual({ type: 'none', durationMs: 0 });
      const opacities = new Set(frames.flatMap((f) => f.layers.map((l) => round(l.opacity))));
      expect([...opacities].filter((o) => o !== 0 && o !== 1)).toEqual([]);
      const contents = new Set(frames.flatMap((f) => f.layers.map((l) => l.content)));
      expect([...contents]).toEqual(['none']);
      const layers = new Set(frames.flatMap((f) => f.layers.map((l) => l.transform)));
      expect([...layers].filter((t) => t !== 'none')).toEqual([]);
    });

    test('el diálogo de inicio: aviso solo con movimiento reducido y nada desactivado', async () => {
      test.setTimeout(120_000);
      await saveDefaults(page, { ...BASE });
      await openSetupFromSelection(page, [0, 2, 3]);
      const dialog = setupDialog(page);
      const hint = dialog.locator('[data-reduced-motion-hint]');
      const transitions = dialog.getByRole('switch', { name: 'Transiciones' });
      const animations = dialog.getByRole('switch', { name: 'Animaciones' });
      if (reducedMotion === 'reduce') {
        await expect(hint).toBeVisible();
      } else {
        await expect(hint).toHaveCount(0);
      }
      await expect(transitions).toBeEnabled();
      await expect(animations).toBeEnabled();
      await expect(transitions).toBeChecked();
      await expect(animations).toBeChecked();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}
