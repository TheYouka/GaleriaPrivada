// CPU de los fondos animados (docs/PLAN.md 6.3; docs/DESIGN.md §15.7; anexo §10): se mide en un E2E,
// no con las DevTools, con `app.getAppMetrics()` (porcentaje de un núcleo desde la llamada anterior):
// Clásico en reposo (referencia estática), Ondas visible, Ondas con la ventana minimizada, con una
// presentación en marcha, con un vídeo reproduciéndose y con movimiento reducido. Junto a la CPU se
// cuentan los fotogramas que dibuja el canvas de las ondas (una llamada a `fill()` por cinta), que
// son la prueba directa de que el fondo no corre en pausa. Las cifras quedan en la salida del test y
// en tests/.tmp/background-cpu.json (PLAN.md, nota de 6.3).
//
// Objetivo del plan: ondas visibles ≤ ~5 % de un núcleo de media y casi 0 en pausa. Los límites de
// las aserciones son más holgados a propósito (el PC del usuario está en uso mientras se prueban):
// un valor puntual alto no es un fallo de la aplicación, pero las cifras se anotan.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ROOT, type LaunchedApp } from './helpers/launch';
import { gridCells, removeDir } from './helpers/library';
import {
  exitPresentation,
  launchWithMedia,
  openSetupFromSelection,
  startPresentation,
} from './helpers/presentation';

/** Duración de cada medición (ms). */
const SAMPLE_MS = 6_000;

interface Sample {
  /** Renderer + GPU: lo que cuesta pintar (porcentaje de un núcleo). */
  paint: number;
  /** Todos los procesos de la app. */
  all: number;
  /** Fotogramas dibujados por el canvas de las ondas durante la medición. */
  frames: number;
  seconds: number;
}

async function metrics(app: ElectronApplication): Promise<{ type: string; cpu: number }[]> {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })),
  );
}

const wavesFrames = (page: Page): Promise<number> =>
  page.evaluate(() => ((window as unknown as { __wavesFills?: number }).__wavesFills ?? 0) / 3);

/** Cuenta cada `fill()` del canvas de las ondas (3 por fotograma: una por cinta). */
async function installFrameCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __wavesFills: number };
    w.__wavesFills = 0;
    const original = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill = function (this: CanvasRenderingContext2D, ...args) {
      if (this.canvas.dataset.waves !== undefined) w.__wavesFills += 1;
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof original;
  });
}

async function measure(page: Page, app: ElectronApplication): Promise<Sample> {
  await metrics(app); // pone a cero el contador de "desde la última llamada"
  const frames0 = await wavesFrames(page);
  const started = Date.now();
  await page.waitForTimeout(SAMPLE_MS);
  const seconds = (Date.now() - started) / 1000;
  const list = await metrics(app);
  const frames = (await wavesFrames(page)) - frames0;
  const sum = (types?: string[]): number =>
    list.filter((m) => !types || types.includes(m.type)).reduce((acc, m) => acc + m.cpu, 0);
  return { paint: sum(['Tab', 'GPU']), all: sum(), frames, seconds };
}

const fmt = (s: Sample): string =>
  `renderer+GPU ${s.paint.toFixed(2)} %, todos ${s.all.toFixed(2)} %, ${(s.frames / s.seconds).toFixed(1)} fps`;

test.describe('CPU de los fondos animados', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;
  let app: ElectronApplication;
  let src: string;
  const results: Record<string, Sample> = {};

  const host = () => page.locator('[data-background]');
  const canvas = () => page.locator('canvas[data-waves]');

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const fixture = await launchWithMedia();
    launched = fixture.launched;
    page = fixture.page;
    app = fixture.app;
    src = fixture.src;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  test.afterAll(async () => {
    const dir = join(ROOT, 'tests', '.tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'background-cpu.json'), JSON.stringify(results, null, 2));
    for (const [name, s] of Object.entries(results)) console.log(`[cpu] ${name}: ${fmt(s)}`);
    await launched?.close();
    if (src) removeDir(src);
  });

  test('referencia: Clásico (fondo estático) en reposo', async () => {
    test.setTimeout(120_000);
    await expect(host()).toHaveAttribute('data-background', 'mica');
    results['clasico-reposo'] = await measure(page, app);
    console.log(`[cpu] Clásico en reposo: ${fmt(results['clasico-reposo'])}`);
  });

  test('Ondas visible: ≤ 30 fps, y el coste de pintar queda cerca del objetivo del plan (≈ 5 %)', async () => {
    test.setTimeout(120_000);
    await page.keyboard.press('Control+Comma');
    await page.getByRole('radio', { name: 'Ondas' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ps3');
    await expect(canvas()).toHaveAttribute('data-animating', 'true');
    await installFrameCounter(page);
    // Vuelve a la galería con el teclado (Inicio lleva a la primera categoría de la barra XMB).
    const categories = page
      .getByRole('navigation', { name: 'Navegación principal' })
      .getByRole('list', { name: 'Categorías' });
    await categories.getByRole('button', { name: 'Ajustes' }).focus();
    await page.keyboard.press('Home');
    await expect(categories.getByRole('button', { name: 'Galería' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
    await expect(host()).toHaveAttribute('data-paused', 'false');
    const sample = await measure(page, app);
    results['ondas-visible'] = sample;
    console.log(`[cpu] Ondas visible: ${fmt(sample)}`);
    const fps = sample.frames / sample.seconds;
    expect(fps).toBeGreaterThan(5);
    expect(fps).toBeLessThanOrEqual(31);
    // Objetivo ≈ 5 %; el límite es el doble para no depender de lo que haga el PC a la vez.
    const reference = results['clasico-reposo'];
    expect(sample.paint).toBeLessThanOrEqual(10);
    if (reference)
      console.log(`[cpu] coste de las ondas: ${(sample.paint - reference.paint).toFixed(2)} %`);
  });

  test('ventana minimizada: pausa, 0 fotogramas y CPU casi nula', async () => {
    test.setTimeout(120_000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await expect(host()).toHaveAttribute('data-paused', 'true');
    await expect(canvas()).toHaveAttribute('data-animating', 'false');
    await page.waitForTimeout(500);
    const sample = await measure(page, app);
    results['ondas-minimizada'] = sample;
    console.log(`[cpu] Ondas minimizada: ${fmt(sample)}`);
    expect(sample.frames).toBe(0);
    expect(sample.paint).toBeLessThanOrEqual(3);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await expect(host()).toHaveAttribute('data-paused', 'false');
    await expect(canvas()).toHaveAttribute('data-animating', 'true');
  });

  test('presentación en marcha: el fondo se pausa (0 fotogramas)', async () => {
    test.setTimeout(120_000);
    await openSetupFromSelection(page, [0, 2]);
    await startPresentation(page);
    await expect(host()).toHaveAttribute('data-paused', 'true');
    await expect(canvas()).toHaveAttribute('data-animating', 'false');
    await page.waitForTimeout(500);
    const sample = await measure(page, app);
    results['ondas-presentacion'] = sample;
    console.log(`[cpu] Presentación (el coste es de la propia presentación): ${fmt(sample)}`);
    expect(sample.frames).toBe(0);
    await exitPresentation(page);
    await expect(host()).toHaveAttribute('data-paused', 'false');
  });

  test('vídeo reproduciéndose: el fondo se pausa (0 fotogramas)', async () => {
    test.setTimeout(120_000);
    await page.mouse.move(5, 5);
    const labels = await gridCells(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') ?? ''),
    );
    const videoIndex = labels.findIndex((l) => l.includes(', vídeo'));
    expect(videoIndex).toBeGreaterThanOrEqual(0);
    await gridCells(page).nth(videoIndex).dblclick();
    await expect(page.locator('[data-player]')).toHaveAttribute('data-playing', 'true', {
      timeout: 30_000,
    });
    await expect(host()).toHaveAttribute('data-paused', 'true');
    await expect(canvas()).toHaveAttribute('data-animating', 'false');
    await page.waitForTimeout(500);
    const sample = await measure(page, app);
    results['ondas-video'] = sample;
    console.log(`[cpu] Vídeo (el coste es de la propia reproducción): ${fmt(sample)}`);
    expect(sample.frames).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-viewer]')).toHaveCount(0);
    await expect(host()).toHaveAttribute('data-paused', 'false');
  });

  test('movimiento reducido: un único fotograma estático, sin bucle', async () => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(canvas()).toHaveAttribute('data-animating', 'false');
    await page.waitForTimeout(500);
    const sample = await measure(page, app);
    results['ondas-movimiento-reducido'] = sample;
    console.log(`[cpu] Movimiento reducido: ${fmt(sample)}`);
    expect(sample.frames).toBe(0);
    expect(sample.paint).toBeLessThanOrEqual(3);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
});
