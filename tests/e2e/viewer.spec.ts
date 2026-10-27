// Visor (docs/PLAN.md 3.4 y 3.7; docs/DESIGN.md §16.1 y §16.2): abrir desde el mosaico con la
// animación FLIP y llegar a su estado final, ←/→, Home/End, zoom con la rueda y arrastre, Esc (sale
// del zoom y después cierra), el foco vuelve al mosaico, un recorrido solo con teclado, Supr con
// confirmación y las capturas en los dos temas (tests/.tmp/screenshots/fase-3/).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT, unlockProfile } from './helpers/launch';
import {
  expectItemCount,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
} from './helpers/library';
import type { LaunchedApp } from './helpers/launch';

const SHOTS = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-3');

/** Cinco fotos de proporciones distintas; la fecha de captura (mtime) fija el orden de la galería. */
const PHOTOS = [
  { file: 'Foto A.jpg', width: 640, height: 400 },
  { file: 'Foto B.jpg', width: 400, height: 640 },
  { file: 'Foto C.jpg', width: 500, height: 500 },
  { file: 'Foto D.jpg', width: 800, height: 450 },
  { file: 'Foto E.jpg', width: 450, height: 600 },
] as const;

async function writePhotos(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const [i, photo] of PHOTOS.entries()) {
    const path = join(dir, photo.file);
    await writePhoto(path, i + 3, {
      width: photo.width,
      height: photo.height,
      mtime: new Date(2025, 5, 1 + i, 12),
    });
    paths.push(path);
  }
  return paths;
}

const viewerDialog = (page: Page): Locator => page.locator('[data-viewer]');
const surface = (page: Page): Locator => page.locator('[data-zoom-surface]');

async function waitOpen(page: Page): Promise<void> {
  await expect(viewerDialog(page)).toHaveAttribute('data-viewer-state', 'open', {
    timeout: 10_000,
  });
  // Una sola capa (el fundido cruzado de la navegación ya terminó).
  await expect(surface(page)).toHaveCount(1);
}

async function scaleOf(page: Page): Promise<number> {
  return Number(await surface(page).getAttribute('data-scale'));
}

async function panOf(page: Page): Promise<{ x: number; y: number }> {
  return {
    x: Number(await surface(page).getAttribute('data-pan-x')),
    y: Number(await surface(page).getAttribute('data-pan-y')),
  };
}

async function stageCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-viewer-stage]').boundingBox();
  if (!box) throw new Error('sin escenario');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('visor', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;
  let src: string;
  let names: string[];

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    launched = await launchUnlocked({}, { width: 1280, height: 800 });
    page = launched.page;
    src = newSourceDir();
    const counts = await importAndSummarize(page, launched.app, await writePhotos(src));
    expect(counts.imported).toBe(PHOTOS.length);
    await expectItemCount(page, PHOTOS.length);
    await expect
      .poll(() =>
        page
          .getByRole('grid', { name: 'Galería' })
          .evaluate((g) => Array.from(g.querySelectorAll('img')).every((i) => i.naturalWidth > 0)),
      )
      .toBe(true);
    names = (await gridCells(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') ?? ''),
    )) as string[];
    expect(names).toHaveLength(PHOTOS.length);
  });

  test.afterAll(async () => {
    await launched?.close();
    if (src) removeDir(src);
  });

  test('un clic abre el visor con la animación FLIP y llega a su estado final; Esc cierra y el foco vuelve al mosaico', async () => {
    const cell = gridCells(page).nth(1);
    const name = names[1] ?? '';
    // Mientras anima: el elemento sale del mosaico (transform y clip-path distintos de los finales).
    const animating = page.waitForFunction(
      () => {
        const dialog = document.querySelector('[data-viewer]');
        const box = document.querySelector('[data-viewer-flip]');
        if (dialog?.getAttribute('data-viewer-state') !== 'opening' || !box) return false;
        const style = getComputedStyle(box);
        return style.transform !== 'none' && style.clipPath.startsWith('inset(');
      },
      undefined,
      { polling: 'raf', timeout: 5_000 },
    );
    await cell.click();
    await animating;
    const dialog = viewerDialog(page);
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleName(name);
    await waitOpen(page);

    // Estado final: la caja sin transformar ni recortar, el original en lugar de la miniatura y el foco
    // dentro del diálogo.
    const box = page.locator('[data-viewer-flip]');
    await expect(box).toHaveCSS('transform', 'none');
    await expect(box).toHaveCSS('clip-path', /^(none|inset\(0px\))$/);
    await expect(page.locator('[data-edited-image="viewer"] img')).toBeVisible();
    await expect(page.locator('[data-viewer-thumb]')).toHaveCount(0);
    await expect(dialog).toBeFocused();
    // La foto ocupa el escenario con la proporción de la foto (contain, centrada).
    const stage = await page.locator('[data-viewer-stage]').boundingBox();
    const photo = await box.boundingBox();
    expect(stage && photo).toBeTruthy();
    if (stage && photo) {
      const dims = PHOTOS.find((p) => p.file.startsWith(name));
      expect(photo.width / photo.height).toBeCloseTo((dims?.width ?? 1) / (dims?.height ?? 1), 1);
      expect(photo.x + photo.width / 2).toBeCloseTo(stage.x + stage.width / 2, 0);
      expect(photo.y + photo.height / 2).toBeCloseTo(stage.y + stage.height / 2, 0);
      expect(photo.height).toBeLessThanOrEqual(stage.height + 1);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(cell).toBeFocused();
    await expect(page.getByRole('grid', { name: 'Galería' })).toBeVisible();
  });

  test('←/→, Home y End navegan por la lista de la galería', async () => {
    await gridCells(page).nth(0).click();
    await waitOpen(page);
    const dialog = viewerDialog(page);
    await expect(dialog).toHaveAccessibleName(names[0] ?? '');
    await page.keyboard.press('ArrowLeft'); // ya es el primero
    await expect(dialog).toHaveAccessibleName(names[0] ?? '');
    await page.keyboard.press('ArrowRight');
    await expect(dialog).toHaveAccessibleName(names[1] ?? '');
    await expect(surface(page)).toHaveCount(1); // termina el fundido cruzado
    await page.keyboard.press('ArrowRight');
    await expect(dialog).toHaveAccessibleName(names[2] ?? '');
    await page.keyboard.press('ArrowLeft');
    await expect(dialog).toHaveAccessibleName(names[1] ?? '');
    await page.keyboard.press('End');
    await expect(dialog).toHaveAccessibleName(names[PHOTOS.length - 1] ?? '');
    await page.keyboard.press('ArrowRight'); // ya es el último
    await expect(dialog).toHaveAccessibleName(names[PHOTOS.length - 1] ?? '');
    await page.keyboard.press('Home');
    await expect(dialog).toHaveAccessibleName(names[0] ?? '');
    // También con los botones laterales.
    await dialog.getByRole('button', { name: 'Siguiente' }).click();
    await expect(dialog).toHaveAccessibleName(names[1] ?? '');
    await dialog.getByRole('button', { name: 'Anterior' }).click();
    await expect(dialog).toHaveAccessibleName(names[0] ?? '');
    await expect(surface(page)).toHaveCount(1);

    // Cerrar desde otra foto devuelve el foco al mosaico de esa foto (la rejilla sigue al visor).
    await page.keyboard.press('End');
    await expect(dialog).toHaveAccessibleName(names.at(-1) ?? '');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(gridCells(page).nth(PHOTOS.length - 1)).toBeFocused();
  });

  test('zoom con la rueda (1×–8×, centrado en el cursor), arrastre, doble clic y Esc sale del zoom antes de cerrar', async () => {
    // Una foto apaisada: el zoom centrado en el cursor solo se nota si la foto desborda la vista.
    await gridCells(page).nth(1).click();
    await waitOpen(page);
    const center = await stageCenter(page);
    expect(await scaleOf(page)).toBe(1);
    // A 1× no se desplaza.
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 60, center.y - 30, { steps: 4 });
    await page.mouse.up();
    expect(await panOf(page)).toEqual({ x: 0, y: 0 });

    // Rueda: ampliar con el cursor a la derecha del centro; el punto bajo el cursor no se mueve.
    const cursor = { x: center.x + 120, y: center.y + 40 };
    await page.mouse.move(cursor.x, cursor.y);
    const box = page.locator('[data-viewer-flip]');
    const before = await box.boundingBox();
    expect(before).toBeTruthy();
    // Punto de la foto bajo el cursor, como fracción de la foto.
    const fx = before ? (cursor.x - before.x) / before.width : 0;
    const fy = before ? (cursor.y - before.y) / before.height : 0;
    await page.mouse.wheel(0, -500);
    await expect.poll(() => scaleOf(page)).toBeGreaterThan(1.3);
    const s1 = await scaleOf(page);
    expect(s1).toBeLessThanOrEqual(8);
    const after = await box.boundingBox();
    if (after) {
      expect(after.x + fx * after.width).toBeCloseTo(cursor.x, 0);
      expect(after.y + fy * after.height).toBeCloseTo(cursor.y, 0);
    }
    await expect(page.locator('[data-viewer-zoom]')).toContainText('%');

    // Arrastre: desplaza lo que se arrastra (con el límite de los bordes).
    const pan0 = await panOf(page);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 50, center.y - 20, { steps: 5 });
    await page.mouse.up();
    const pan1 = await panOf(page);
    expect(pan1.x).toBeLessThan(pan0.x);
    expect(pan1.y).toBeLessThanOrEqual(pan0.y);
    expect(pan0.x - pan1.x).toBeLessThanOrEqual(50.5);

    // El máximo es 8×.
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, -800);
    await expect.poll(() => scaleOf(page)).toBe(8);
    // Y nunca baja de 1×.
    for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, 800);
    await expect.poll(() => scaleOf(page)).toBe(1);
    expect(await panOf(page)).toEqual({ x: 0, y: 0 });

    // Doble clic: 1 ↔ 2.
    await page.mouse.dblclick(center.x, center.y);
    await expect.poll(() => scaleOf(page)).toBe(2);
    await page.mouse.dblclick(center.x, center.y);
    await expect.poll(() => scaleOf(page)).toBe(1);

    // Esc sale del zoom y, después, cierra.
    await page.mouse.wheel(0, -600);
    await expect.poll(() => scaleOf(page)).toBeGreaterThan(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => scaleOf(page)).toBe(1);
    await expect(viewerDialog(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveCount(0);
    await expect(gridCells(page).nth(1)).toBeFocused();
  });

  test('recorrido solo con teclado: Intro abre, flechas, +/−/0, I, Tab dentro del diálogo y Esc', async () => {
    const first = gridCells(page).nth(2);
    await first.focus();
    await page.keyboard.press('Enter');
    await waitOpen(page);
    const dialog = viewerDialog(page);
    await expect(dialog).toBeFocused();
    await expect(dialog).toHaveAccessibleName(names[2] ?? '');

    await page.keyboard.press('ArrowRight');
    await expect(dialog).toHaveAccessibleName(names[3] ?? '');
    await expect(surface(page)).toHaveCount(1);

    // Zoom con el teclado: con s > 1 las flechas desplazan en vez de navegar.
    await page.keyboard.press('+');
    await expect.poll(() => scaleOf(page)).toBeCloseTo(1.25, 2);
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await expect.poll(() => scaleOf(page)).toBeCloseTo(1.25 ** 3, 2);
    const pan0 = await panOf(page);
    await page.keyboard.press('ArrowLeft');
    await expect(dialog).toHaveAccessibleName(names[3] ?? ''); // no navegó
    await page.keyboard.press('ArrowDown'); // la foto es vertical: se desplaza hacia abajo
    await expect.poll(async () => (await panOf(page)).y).toBeLessThan(pan0.y);
    await page.keyboard.press('-');
    await expect.poll(() => scaleOf(page)).toBeCloseTo(1.25 ** 2, 2);
    await page.keyboard.press('0');
    await expect.poll(() => scaleOf(page)).toBe(1);
    await page.keyboard.press('ArrowLeft'); // sin zoom vuelve a navegar
    await expect(dialog).toHaveAccessibleName(names[2] ?? '');
    await expect(surface(page)).toHaveCount(1);

    // Información (I).
    await page.keyboard.press('i');
    const info = dialog.getByRole('complementary', { name: 'Información' });
    await expect(info).toBeVisible();
    await expect(info).toContainText(names[2] ?? '');
    await expect(info).toContainText('Dimensiones');
    await page.keyboard.press('i');
    await expect(info).toBeHidden();

    // Tab no sale del diálogo (trampa de foco) y cada parada tiene nombre.
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return {
          inside: !!active?.closest('[data-viewer]'),
          name: active?.getAttribute('aria-label') ?? active?.textContent ?? '',
        };
      });
      expect(inside.inside).toBe(true);
      expect(inside.name.length).toBeGreaterThan(0);
    }

    // Esc cierra y el foco vuelve al mosaico de la foto en la que se quedó.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(gridCells(page).nth(2)).toBeFocused();
  });

  test('F pide la pantalla completa a la ventana (simulada, sin sacarla del lugar discreto)', async () => {
    await app_stubFullscreen();
    await gridCells(page).nth(0).click();
    await waitOpen(page);
    await page.keyboard.press('f');
    await expect.poll(() => fullscreenCalls()).toEqual([true]);
    await page.keyboard.press('Escape');
    await expect(viewerDialog(page)).toHaveCount(0);
  });

  async function app_stubFullscreen(): Promise<void> {
    await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      const calls: boolean[] = [];
      (globalThis as unknown as { __fullscreenCalls: boolean[] }).__fullscreenCalls = calls;
      win.setFullScreen = (on: boolean) => {
        calls.push(on);
      };
    });
  }
  async function fullscreenCalls(): Promise<boolean[]> {
    return launched.app.evaluate(
      () => (globalThis as unknown as { __fullscreenCalls: boolean[] }).__fullscreenCalls,
    );
  }

  test('Supr elimina con confirmación y el visor pasa al siguiente', async () => {
    await gridCells(page).nth(1).click();
    await waitOpen(page);
    const dialog = viewerDialog(page);
    await expect(dialog).toHaveAccessibleName(names[1] ?? '');
    await page.keyboard.press('Delete');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    // Cancelar no borra nada y el foco vuelve al visor.
    // A veces el Esc llega antes de que el listener de Radix esté listo: se reintenta, pero solo si
    // la confirmación sigue ahí y con margen para su salida; un segundo Esc con la confirmación ya
    // cerrada cerraría el visor.
    await expect(async () => {
      if (await confirm.isVisible()) await page.keyboard.press('Escape');
      await expect(confirm).toBeHidden({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await expect(dialog).toHaveAccessibleName(names[1] ?? '');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Delete');
    await confirm.getByRole('button', { name: 'Eliminar' }).click();
    await expect(confirm).toBeHidden();
    // El siguiente de la lista ocupa su sitio.
    await expect(dialog).toHaveAccessibleName(names[2] ?? '');
    await expect(surface(page)).toHaveCount(1);
    await expectItemCount(page, PHOTOS.length - 1);
    // El aviso «Se eliminó 1 elemento.» es la capa superior de Radix: el primer Esc lo descarta y el
    // segundo cierra el visor.
    const toast = page.getByLabel('Notificaciones (F8)').getByText('Se eliminó 1 elemento.');
    await expect(toast).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toast).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas del visor y del zoom en el tema ${displayName}`, async () => {
    test.setTimeout(180_000);
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
      expect((await importAndSummarize(page, app, await writePhotos(src))).imported).toBe(5);
      await expectItemCount(page, 5);
      await expect
        .poll(() =>
          page
            .getByRole('grid', { name: 'Galería' })
            .evaluate((g) =>
              Array.from(g.querySelectorAll('img')).every((i) => i.naturalWidth > 0),
            ),
        )
        .toBe(true);

      await gridCells(page).nth(1).click();
      await waitOpen(page);
      await expect(page.locator('[data-edited-image="viewer"] img')).toBeVisible();
      // El foco visible: una pulsación de Tab lo lleva a un control del cromo del visor.
      await page.keyboard.press('Tab');
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `viewer-${label}.png`) });

      // Zoom con la rueda sobre el cursor y el indicador de ampliación.
      const center = await stageCenter(page);
      await page.mouse.move(center.x + 80, center.y - 20);
      await page.mouse.wheel(0, -900);
      await expect.poll(() => scaleOf(page)).toBeGreaterThan(2);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `viewer-zoom-${label}.png`) });
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
