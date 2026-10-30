// Movimiento reducido en la interfaz de cada tema (docs/PLAN.md 6.5; docs/DESIGN.md §15.11; anexo §2):
// con `prefers-reduced-motion: reduce` emulado no hay deslizamiento de la XMB, ni escala del foco en
// Mosaico, Ondas y Cine (queda el anillo), ni escala del póster de Cine, ni transiciones de transformación
// en los mosaicos, y las ondas quedan estáticas. Cada comprobación lleva su control positivo con
// `no-preference` (si el control no ve movimiento, la prueba no vale). La PRESENTACIÓN no entra aquí:
// ignora el movimiento reducido a propósito (notas 190 y 191; presentation-motion.spec.ts). Ventana
// discreta (nota 135) y datos solo bajo tests/.tmp/.
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createProfile, launchApp, unlockProfile, type LaunchedApp } from './helpers/launch';
import {
  expectItemCount,
  gridCells,
  importAndSummarize,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
} from './helpers/library';

const THEMES = [
  { id: 'fotos', name: 'Clásico' },
  { id: 'xbox', name: 'Mosaico' },
  { id: 'ps3', name: 'Ondas' },
  { id: 'macos', name: 'Cristal' },
  { id: 'cine', name: 'Cine' },
] as const;

let launched: LaunchedApp;
let page: Page;
let src: string;
test.describe.configure({ mode: 'serial' });
const html = () => page.locator('html');
const nav = () => page.getByRole('navigation', { name: 'Navegación principal' });
const heading = (name: string) => page.getByRole('heading', { level: 1, name });

/** Cambia de tema desde Ajustes → Apariencia (la pantalla existe en todos los shells). */
async function useTheme(displayName: string, id: string): Promise<void> {
  await page.keyboard.press('Control+Comma');
  await expect(heading('Ajustes')).toBeVisible();
  await page.getByRole('radio', { name: displayName }).click();
  await expect(html()).toHaveAttribute('data-theme', id);
  await expect(heading('Ajustes')).toBeVisible();
  // El cambio de shell termina antes de medir.
  await page.waitForTimeout(800);
}

async function setMotion(reduced: boolean): Promise<void> {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await expect(html()).toHaveAttribute('data-reduced-motion', reduced ? 'true' : 'false');
}

const transformOf = (locator: Locator): Promise<string> =>
  locator.evaluate((el) => getComputedStyle(el).transform);

/**
 * Durante `ms`, el máximo de transiciones CSS de transformación en marcha y los valores distintos del
 * `transform` de `rowSelector` (la fila de categorías de la XMB, que anima Motion por JavaScript).
 */
function startSampling(
  ms: number,
  rowSelector: string | null,
): Promise<{ maxTransitions: number; rowValues: string[] }> {
  return page.evaluate(
    async ({ duration, row }) => {
      const start = performance.now();
      let maxTransitions = 0;
      const values = new Set<string>();
      const rowEl = row ? document.querySelector<HTMLElement>(row) : null;
      while (performance.now() - start < duration) {
        const n = document
          .getAnimations()
          .filter(
            (a) =>
              a instanceof CSSTransition &&
              a.playState === 'running' &&
              ['transform', 'scale', 'translate', 'all'].includes(a.transitionProperty),
          ).length;
        maxTransitions = Math.max(maxTransitions, n);
        if (rowEl) values.add(getComputedStyle(rowEl).transform);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { maxTransitions, rowValues: [...values] };
    },
    { duration: ms, row: rowSelector },
  );
}

async function gotoGallery(): Promise<void> {
  // Ctrl+F lleva a la galería en todos los shells (en Ondas la categoría puede quedar fuera del borde).
  await page.keyboard.press('Control+f');
  await expect(heading('Galería')).toBeVisible();
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  page = launched.page;
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
  });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await createProfile(page, PROFILE, PASSWORD);
  await unlockProfile(page, PROFILE, PASSWORD);
  await expect(heading('Galería')).toBeVisible();
  src = newSourceDir();
  const paths: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
    await writePhoto(path, i + 3, { mtime: new Date(2025, i % 4, 3 + i, 12) });
    paths.push(path);
  }
  const counts = await importAndSummarize(page, launched.app, paths, 'files', 120_000);
  expect(counts.imported).toBe(paths.length);
  await expectItemCount(page, paths.length);
});
test.afterAll(async () => {
  await launched?.close();
  if (src) removeDir(src);
});

for (const t of THEMES) {
  test(`${t.name}: con movimiento reducido no hay escalas, deslizamientos ni transiciones de transformación`, async () => {
    test.setTimeout(180_000);
    await setMotion(false);
    await useTheme(t.name, t.id);
    await gotoGallery();
    await expectItemCount(page, 10);
    const cells = gridCells(page);
    await expect(cells.first().locator('img')).toBeVisible();

    // Foco de teclado en los mosaicos: ← → desde la primera celda y muestreo de las transiciones.
    const walk = async (): Promise<{ maxTransitions: number }> => {
      await cells.nth(0).click();
      const sampling = startSampling(900, null);
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
      const result = await sampling;
      await page.keyboard.press('Escape');
      return result;
    };
    const scales = t.id === 'xbox' || t.id === 'cine';
    if (scales) {
      // Control positivo: con movimiento normal el foco escala el mosaico (hay transición).
      const normal = await walk();
      expect(normal.maxTransitions, 'control: debe verse una transición').toBeGreaterThan(0);
    }
    await setMotion(true);
    const reduced = await walk();
    expect(reduced.maxTransitions).toBe(0);
    await cells.nth(0).click();
    await page.keyboard.press('ArrowRight');
    const focused = page.locator('[role="gridcell"]:focus');
    await expect(focused).toHaveCount(1);
    expect(await transformOf(focused)).toBe('none');
    if (t.id !== 'fotos') {
      // Sin escala queda el anillo de foco, bien visible.
      expect(await focused.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('3px');
    }
    if (t.id === 'cine') {
      // Póster: ni el tamaño ni la etiqueta del nombre se animan.
      const label = await focused.evaluate((el) => {
        const s = getComputedStyle(el, '::after');
        return { transform: s.transform, duration: s.transitionDuration };
      });
      expect(label.transform).toBe('none');
      expect(label.duration).toBe('0s');
    }
    await page.keyboard.press('Escape');

    if (t.id === 'xbox') {
      // Pivote: la pestaña con el foco no escala (queda el contorno de 3 px).
      const tab = nav()
        .getByRole('list', { name: 'Categorías' })
        .getByRole('button', { name: 'Ajustes', exact: true });
      await tab.focus();
      await page.keyboard.press('ArrowLeft');
      const left = page.locator('.g-pivot-tab:focus');
      await expect(left).toHaveCount(1);
      expect(await transformOf(left)).toBe('none');
      expect(await left.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('3px');
    }

    if (t.id === 'cine') {
      // Barra superior: pasa a sólida sin fundido.
      expect(
        await page.locator('.g-topbar').evaluate((el) => getComputedStyle(el).transitionDuration),
      ).toBe('0s');
    }

    if (t.id === 'ps3') {
      const categories = nav().getByRole('list', { name: 'Categorías' });
      const category = (name: string) => categories.getByRole('button', { name, exact: true });
      const slide = async (): Promise<string[]> => {
        await page.keyboard.press('Control+Comma');
        await expect(heading('Ajustes')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(category('Ajustes')).toBeFocused();
        const sampling = startSampling(900, 'ul[aria-label="Categorías"]');
        await page.keyboard.press('Home');
        await expect(category('Galería')).toBeFocused();
        return (await sampling).rowValues;
      };
      // Control positivo: la fila se desliza (valores intermedios de translateX).
      await setMotion(false);
      expect((await slide()).length, 'control: la fila debe deslizarse').toBeGreaterThan(2);
      // Con movimiento reducido: solo la posición inicial y la final.
      await setMotion(true);
      expect((await slide()).length).toBeLessThanOrEqual(2);
      // El icono de la categoría actual no se escala y la barra de 3 px indica dónde se está.
      expect(await transformOf(category('Galería').locator('.g-xmb-icon'))).toBe('none');
      expect(
        await category('Galería').evaluate((el) => getComputedStyle(el, '::after').height),
      ).toBe('3px');

      // Ondas: un único fotograma estático, sin bucle.
      const canvas = page.locator('canvas[data-waves]');
      const frame = (): Promise<string> =>
        canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL('image/png'));
      await expect(canvas).toHaveAttribute('data-animating', 'false');
      const first = await frame();
      await page.waitForTimeout(900);
      expect(await frame()).toBe(first);
      // Control positivo: sin la preferencia, las ondas se mueven.
      await setMotion(false);
      await expect(canvas).toHaveAttribute('data-animating', 'true');
      const moving = await frame();
      await page.waitForTimeout(900);
      expect(await frame()).not.toBe(moving);
    }

    await setMotion(false);
  });
}
