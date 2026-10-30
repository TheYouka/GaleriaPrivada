// Estilos estructurales y selector de perfiles por tema (docs/PLAN.md 6.4, D9; docs/DESIGN.md §15.10):
// en los 5 temas el selector tiene la misma estructura, el mismo orden del DOM y el mismo teclado con
// otra presentación (`fluent`, `tiles`, `xmb-row`, `login`, `showcase`); el Selector de temas de Ajustes
// ofrece los 5 con su maqueta; los mosaicos de la galería (`rounded`, `flat`, `xmb`, `vibrancy`,
// `poster`) y las tarjetas de Playlists cambian solo en CSS; las reglas de clic del anexo §9 (un clic
// alterna, el doble clic abre y restaura la selección) son iguales; el foco con teclado escala en
// Mosaico y Cine y no con movimiento reducido; y la barra de selección es de UNA fila en todos (nota
// 193). Datos solo bajo tests/.tmp/ y ventana discreta (nota 135).
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  choosePickerTheme,
  createProfile,
  launchApp,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';
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
import {
  addSelectionToNewPlaylist,
  openPlaylistDetail,
  openPlaylistsScreen,
  selectionBar,
} from './helpers/playlists';

const THEMES = [
  { id: 'fotos', name: 'Clásico', picker: 'fluent', avatarRadius: '8px', tileRadius: '8px' },
  { id: 'xbox', name: 'Mosaico', picker: 'tiles', avatarRadius: '0px', tileRadius: '0px' },
  { id: 'ps3', name: 'Ondas', picker: 'xmb-row', avatarRadius: '16px', tileRadius: '12px' },
  { id: 'macos', name: 'Cristal', picker: 'login', avatarRadius: '9999px', tileRadius: '10px' },
  { id: 'cine', name: 'Cine', picker: 'showcase', avatarRadius: '28px', tileRadius: '14px' },
] as const;

let launched: LaunchedApp;
let page: Page;
let src: string;

test.describe.configure({ mode: 'serial' });

const html = () => page.locator('html');
const heading = (name: string) => page.getByRole('heading', { level: 1, name });

/** Cambia de tema desde Ajustes → Apariencia (la pantalla existe en todos los shells). */
async function useTheme(displayName: string, id: string): Promise<void> {
  await page.keyboard.press('Control+Comma');
  await expect(heading('Ajustes')).toBeVisible();
  await page.getByRole('radio', { name: displayName }).click();
  await expect(html()).toHaveAttribute('data-theme', id);
  await expect(heading('Ajustes')).toBeVisible();
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
});

test.afterAll(async () => {
  await launched?.close();
  if (src) removeDir(src);
});

test('selector de perfiles: misma estructura y teclado en los 5 temas, otra presentación', async () => {
  test.setTimeout(240_000);
  for (const t of THEMES) {
    await choosePickerTheme(page, t.name);
    await expect(html()).toHaveAttribute('data-theme', t.id);
    await expect(page.locator('[data-picker]')).toHaveAttribute('data-picker', t.picker);
    const list = page.getByRole('list', { name: 'Perfiles' });
    // Mismo DOM: el perfil primero, «Añadir perfil» después.
    await expect(list.getByRole('listitem')).toHaveCount(2);
    const ana = list.getByRole('button', { name: /^Ana/ });
    const add = list.getByRole('button', { name: /^Añadir perfil/ });
    const names = await list.getByRole('button').evaluateAll((els) =>
      els.map((el) =>
        (el.textContent ?? '')
          .replace(/Pulsa Intro/, '')
          .replace(/Disco no conectado/, '')
          .trim(),
      ),
    );
    expect(names).toEqual(['Ana', 'Añadir perfil']);
    // Presentación propia: radio del avatar, tamaño y «Pulsa Intro» solo en Ondas.
    const avatar = ana.locator('img');
    await expect(avatar).toBeVisible();
    expect(await avatar.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(
      t.avatarRadius,
    );
    // offsetWidth: sin las transformaciones de respiración y escala.
    expect(await avatar.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(
      t.picker === 'showcase' ? 200 : 160,
    );
    if (t.picker === 'tiles') {
      // «Añadir perfil» es un mosaico de 2×1: la mitad de alto que el del perfil.
      const frame = add.locator('span').first();
      expect(await frame.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(80);
      expect(await frame.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(160);
      // El nombre va dentro del mosaico, sobre una etiqueta sólida.
      const label = await ana
        .locator('span', { hasText: /^Ana$/ })
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(label).toMatch(/^rgb\(/);
    }
    await expect(ana.getByText('Pulsa Intro')).toHaveCount(t.picker === 'xmb-row' ? 1 : 0);
    // Mismo teclado: →, Inicio, Intro abre el desbloqueo y Esc devuelve el foco al avatar.
    await ana.focus();
    await page.keyboard.press('ArrowRight');
    await expect(add).toBeFocused();
    await page.keyboard.press('Home');
    await expect(ana).toBeFocused();
    await page.keyboard.press('Enter');
    // Cristal (`login`): la contraseña va en línea bajo el avatar, no en un diálogo modal.
    const dialog =
      t.picker === 'login'
        ? page.getByRole('group', { name: `Contraseña de ${PROFILE}` })
        : page.getByRole('dialog', { name: PROFILE });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(ana).toBeFocused();
  }
});

test('Ajustes → Apariencia ofrece los 5 temas con la maqueta de su shell', async () => {
  await choosePickerTheme(page, 'Clásico');
  await unlockProfile(page, PROFILE, PASSWORD);
  await expect(heading('Galería')).toBeVisible();
  await page.keyboard.press('Control+Comma');
  await expect(heading('Ajustes')).toBeVisible();
  await expect(page.locator('[id^="theme-option-"]')).toHaveCount(5);
  for (const t of THEMES) await expect(page.getByRole('radio', { name: t.name })).toBeVisible();
  const shells = await page
    .locator('[data-preview-shell]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-theme') + ':' + el.getAttribute('data-preview-shell')),
    );
  expect(shells.sort()).toEqual(
    ['cine:topbar', 'fotos:sidebar', 'macos:vibrancy', 'ps3:xmb', 'xbox:pivot'].sort(),
  );
  // Cada maqueta pinta contenido propio (no una caja vacía).
  const sizes = await page
    .locator('[data-preview-shell]')
    .evaluateAll((els) => els.map((el) => el.querySelectorAll('span').length));
  for (const n of sizes) expect(n).toBeGreaterThan(6);
});

test('datos de prueba: 14 fotos y 4 playlists', async () => {
  test.setTimeout(240_000);
  src = newSourceDir();
  const paths: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
    await writePhoto(path, i + 5, { mtime: new Date(2025, i % 4, 3 + i, 12) });
    paths.push(path);
  }
  await gotoGallery();
  const counts = await importAndSummarize(page, launched.app, paths, 'files', 120_000);
  expect(counts.imported).toBe(paths.length);
  await expectItemCount(page, paths.length);
  for (let i = 0; i < 4; i += 1) {
    await gridCells(page).nth(i).click();
    await addSelectionToNewPlaylist(page, `Lista ${i + 1}`);
    await selectionBar(page).getByRole('button', { name: 'Cancelar selección' }).click();
    await expect(selectionBar(page)).toHaveCount(0);
  }
});

for (const t of THEMES) {
  test(`${t.name}: mosaicos, clics, foco y barra de selección de una fila`, async () => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await useTheme(t.name, t.id);
    await gotoGallery();
    await expectItemCount(page, 14);
    const cells = gridCells(page);
    const cell = cells.nth(1);
    await expect(cell.locator('img')).toBeVisible();
    // El cambio de tema y de shell termina antes de medir.
    await page.waitForTimeout(800);
    await expect
      .poll(() => cell.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))
      .toBe(t.tileRadius);

    // Un clic alterna sin mover la tarjeta; otro clic la suelta.
    const before = await cell.boundingBox();
    await cell.click();
    await expect(cell).toHaveAttribute('aria-selected', 'true');
    expect(await cell.boundingBox()).toEqual(before);
    await expect(selectionBar(page)).toBeVisible();

    // La barra ocupa UNA fila y todos sus botones están en ella (nota 193).
    const bar = await selectionBar(page).boundingBox();
    expect(bar?.height ?? 999).toBeLessThan(60);
    const ys = await selectionBar(page)
      .getByRole('button')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(4);
    // Todos los botones siguen disponibles por su nombre (con texto o solo icono).
    for (const name of [
      'Presentación',
      'Añadir a playlist',
      'Renombrar',
      'Vídeo dual',
      'Eliminar',
    ]) {
      await expect(selectionBar(page).getByRole('button', { name })).toBeVisible();
    }
    await cell.click();
    await expect(cell).toHaveAttribute('aria-selected', 'false');
    await expect(selectionBar(page)).toHaveCount(0);

    // Cine: el nombre aparece en una etiqueta sólida con el ratón encima.
    if (t.id === 'cine') {
      await cell.hover();
      const label = await cell.evaluate((el) => {
        const s = getComputedStyle(el, '::after');
        return { content: s.content, bg: s.backgroundColor, opacity: s.opacity };
      });
      expect(label.content).toContain('Foto');
      expect(label.bg).toMatch(/^rgb\(/);
      await expect
        .poll(() => cell.evaluate((el) => getComputedStyle(el, '::after').opacity))
        .toBe('1');
    }

    // Doble clic abre el visor y deja la selección como estaba.
    await cell.dblclick();
    await expect(page.locator('[data-viewer]')).toHaveAttribute('data-viewer-state', 'open', {
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-viewer]')).toHaveCount(0);
    await expect(cell).toHaveAttribute('aria-selected', 'false');
    await expect(selectionBar(page)).toHaveCount(0);

    // Foco con teclado: escala en Mosaico y Cine, anillo en todos; sin escala con movimiento reducido.
    await cells.nth(0).click();
    await page.keyboard.press('ArrowRight');
    const focused = page.locator('[role="gridcell"]:focus');
    await expect(focused).toHaveCount(1);
    const scales = t.id === 'xbox' || t.id === 'cine';
    if (scales) {
      await expect
        .poll(() => focused.evaluate((el) => getComputedStyle(el).transform))
        .not.toBe('none');
    } else {
      expect(await focused.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    }
    if (t.id !== 'fotos') {
      expect(await focused.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('3px');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(html()).toHaveAttribute('data-reduced-motion', 'true');
    await expect.poll(() => focused.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    if (t.id !== 'fotos') {
      expect(await focused.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('3px');
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.keyboard.press('Escape');
    await expect(selectionBar(page)).toHaveCount(0);

    // Playlists: la misma estructura con el estilo del tema.
    await openPlaylistsScreen(page);
    const cards = page.locator('.g-pl-card');
    await expect(cards).toHaveCount(4);
    const boxes = [];
    for (let i = 0; i < 4; i += 1) boxes.push(await cards.nth(i).boundingBox());
    const [b0, b1, , b3] = boxes;
    if (!b0 || !b1 || !b3) throw new Error('sin cajas de tarjetas');
    if (t.id === 'xbox') {
      // Mosaicos de 2×2, 1×1, 1×1 y 2×1.
      expect(b0.width).toBeGreaterThan(b1.width * 1.8);
      expect(b0.height).toBeGreaterThan(b1.height * 1.8);
      expect(b3.width).toBeGreaterThan(b1.width * 1.8);
      expect(b3.height).toBeLessThan(b1.height * 1.2);
    }
    if (t.id === 'ps3') {
      // Lista: una columna.
      expect(Math.round(b0.x)).toBe(Math.round(b1.x));
      expect(b1.y).toBeGreaterThan(b0.y);
      expect(
        await cards
          .nth(0)
          .locator('.g-pl-btn')
          .evaluate((el) => getComputedStyle(el).flexDirection),
      ).toBe('row');
    }
    if (t.id === 'cine') {
      // Póster: más alto que ancho.
      expect(b0.height).toBeGreaterThan(b0.width * 1.3);
    }
    if (t.id === 'xbox' || t.id === 'cine') {
      // El nombre va sobre una etiqueta de fondo sólido.
      const bg = await cards
        .nth(0)
        .locator('.g-pl-info')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toMatch(/^rgb\(/);
    }
    if (t.id === 'macos') {
      expect(
        await cards
          .nth(0)
          .locator('.g-pl-btn')
          .evaluate((el) => getComputedStyle(el).boxShadow),
      ).not.toBe('none');
    }
    // El teclado sigue igual: la tarjeta es un botón con nombre y cuenta de elementos.
    await expect(page.getByRole('button', { name: /^Lista 1, 1 elemento$/ })).toBeVisible();
  });
}

// Detalle de una playlist con un nombre largo (hallazgo B2 de la revisión de 6.5): el encabezado ocupa
// su línea y el nombre no se recorta en ningún tema. Va al final: añade una quinta playlist.
test('el nombre largo de una playlist no se recorta en su detalle en los 5 temas', async () => {
  test.setTimeout(240_000);
  const longName = 'Vacaciones de verano en la playa';
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await useTheme('Clásico', 'fotos');
  await gotoGallery();
  await gridCells(page).nth(0).click();
  await addSelectionToNewPlaylist(page, longName);
  await selectionBar(page).getByRole('button', { name: 'Cancelar selección' }).click();
  await expect(selectionBar(page)).toHaveCount(0);
  for (const t of THEMES) {
    await useTheme(t.name, t.id);
    await page.waitForTimeout(800);
    await openPlaylistDetail(page, longName);
    const h1 = heading(longName);
    await expect(h1).toBeVisible();
    const sizes = await h1.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(sizes.scroll, `${t.name}: el encabezado está recortado`).toBeLessThanOrEqual(
      sizes.client,
    );
  }
});
