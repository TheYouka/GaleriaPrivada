// Shells, barras de título y fondos de los temas (docs/PLAN.md 6.2 y 6.3; docs/DESIGN.md §15.5–§15.7):
// en Mosaico, Ondas, Cristal y Cine, el mismo NavModel llega a todas las pantallas con el teclado,
// cada tema monta su barra de título y su fondo, el foco se ve, la barra de Cine pasa a sólida al
// desplazar, y con movimiento reducido desaparecen la escala del foco (Mosaico) y la del icono (Ondas).
// El recorrido completo de teclado de los 5 temas es el de la tarea 6.5.
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createProfile, launchApp, unlockProfile, type LaunchedApp } from './helpers/launch';
import {
  expectItemCount,
  importAndSummarize,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
} from './helpers/library';

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
}

async function transformOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).transform);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  page = launched.page;
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
  });
  await createProfile(page, PROFILE, PASSWORD);
  await unlockProfile(page, PROFILE, PASSWORD);
  await expect(heading('Galería')).toBeVisible();
  src = newSourceDir();
  const paths: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
    await writePhoto(path, i + 3, { mtime: new Date(2025, i % 6, 3 + (i % 20), 12) });
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

test('Mosaico: pestañas con ←/→, ↓ a los destinos, Intro abre; foco con escala y borde; sin escala con movimiento reducido', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await useTheme('Mosaico', 'xbox');
  await expect(page.locator('[data-titlebar="xbox"]')).toHaveCount(1);
  await expect(page.locator('[data-background="solid"]')).toHaveCount(1);
  const categories = nav().getByRole('list', { name: 'Categorías' });
  const tab = (name: string) => categories.getByRole('button', { name, exact: true });
  // El foco de teclado llega a la pestaña activa (Ajustes) y se mueve sin abrir nada.
  await tab('Ajustes').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tab('Vídeo dual')).toBeFocused();
  await expect(heading('Ajustes')).toBeVisible();
  const outline = await tab('Vídeo dual').evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(outline).toBe('3px');
  // Con la escala del foco (movimiento normal) y sin ella (reducido).
  await expect.poll(() => transformOf(tab('Vídeo dual'))).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(html()).toHaveAttribute('data-reduced-motion', 'true');
  await expect.poll(() => transformOf(tab('Vídeo dual'))).toBe('none');
  expect(await tab('Vídeo dual').evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('3px');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('Enter');
  await expect(heading('Vídeo dual')).toBeFocused({ timeout: 20_000 });
  // Galería → destinos con ↓.
  await tab('Vídeo dual').focus();
  await page.keyboard.press('Home');
  await expect(tab('Galería')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading('Galería')).toBeVisible();
  await tab('Galería').focus();
  await page.keyboard.press('ArrowDown');
  const sub = nav().getByRole('list', { name: 'Galería' });
  await expect(sub.getByRole('button', { name: 'Todo' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(sub.getByRole('button', { name: 'Fotos' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading('Fotos')).toBeVisible();
  await expect(sub.getByRole('button', { name: 'Fotos' })).toHaveAttribute('aria-current', 'page');
  await sub.getByRole('button', { name: 'Fotos' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect(tab('Galería')).toBeFocused();
  // Todas las pantallas del NavModel.
  for (const name of ['Playlists', 'Vídeo dual', 'Ajustes', 'Ayuda']) {
    await tab(name).click();
    await expect(heading(name)).toBeVisible();
  }
});

test('Ondas: ←/→/↓/Esc de la XMB; con movimiento reducido el icono no se escala y la categoría actual lleva barra', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await useTheme('Ondas', 'ps3');
  await expect(page.locator('[data-titlebar="xmb"]')).toHaveCount(1);
  await expect(page.locator('[data-background="waves"]')).toHaveCount(1);
  const categories = nav().getByRole('list', { name: 'Categorías' });
  const category = (name: string) => categories.getByRole('button', { name, exact: true });
  await page.keyboard.press('Escape');
  await expect(category('Ajustes')).toBeFocused();
  const icon = category('Ajustes').locator('.g-xmb-icon');
  await expect.poll(() => transformOf(icon)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => transformOf(icon)).toBe('none');
  // Sin deslizamiento: la fila ya está en su sitio, sin transición.
  await expect(category('Ajustes')).toHaveAttribute('data-selected', 'true');
  const bar = await category('Ajustes').evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    return { height: after.height, content: after.content };
  });
  expect(bar.height).toBe('3px');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('Home');
  await expect(category('Galería')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading('Galería')).toBeVisible();
});

test('Cristal (claro y oscuro): barra lateral translúcida con backdrop-filter, semáforo a la izquierda y fondo propio', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await useTheme('Cristal', 'macos');
  await expect(html()).toHaveAttribute('data-scheme', 'light');
  await expect(page.locator('[data-titlebar="traffic-lights"]')).toHaveCount(1);
  await expect(page.locator('[data-background="wallpaper"] [data-wallpaper="light"]')).toHaveCount(
    1,
  );
  // El semáforo: Cerrar, Minimizar y Maximizar en este orden, a la izquierda; el candado a la derecha.
  const lights = page.locator('[data-titlebar] .g-traffic-lights').getByRole('button');
  await expect(lights).toHaveCount(3);
  expect(await lights.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(
    ['Cerrar', 'Minimizar', 'Maximizar'],
  );
  const closeBox = await lights.first().boundingBox();
  const lock = page.getByRole('button', { name: 'Bloquear (Ctrl+L)' });
  const lockBox = await lock.boundingBox();
  expect(closeBox && closeBox.x < 100).toBe(true);
  expect(closeBox && lockBox && lockBox.x > 1100).toBe(true);
  // Solo la barra lateral y la de herramientas llevan backdrop-filter.
  const filtered = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const s = getComputedStyle(el);
        return (s.backdropFilter || 'none') !== 'none';
      })
      .map((el) => el.className.toString().split(' ')[0]),
  );
  expect(filtered.sort()).toEqual(['g-vibrancy-sidebar', 'g-vibrancy-toolbar']);
  // La barra lateral agrupa y navega con ↑/↓; Intro abre.
  const sidebar = nav();
  await sidebar.getByRole('button', { name: 'Ajustes', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(sidebar.getByRole('button', { name: 'Ayuda', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(heading('Ayuda')).toBeFocused();
  for (const name of ['Todo', 'Fotos', 'Vídeos', 'Playlists', 'Vídeo dual', 'Ajustes']) {
    await sidebar.getByRole('button', { name, exact: true }).click();
    await expect(heading(name === 'Todo' ? 'Galería' : name)).toBeVisible();
  }
  // La entrada actual lleva el color de texto sobre el acento, no el texto normal (AA, hallazgo B1).
  const expectCurrentOnAccent = async (): Promise<void> => {
    const { actual, expected } = await sidebar
      .locator('button[aria-current="page"]')
      .evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--g-text-on-accent)';
        document.body.append(probe);
        const expectedColor = getComputedStyle(probe).color;
        probe.remove();
        return { actual: getComputedStyle(el).color, expected: expectedColor };
      });
    expect(actual).toBe(expected);
  };
  await expectCurrentOnAccent();
  // Modo oscuro (sigue al sistema).
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html()).toHaveAttribute('data-scheme', 'dark');
  await expect(page.locator('[data-wallpaper="dark"]')).toHaveCount(1);
  await expectCurrentOnAccent();
  // Los iconos del semáforo aparecen con el ratón encima.
  const icon = lights.first().locator('.g-traffic-icon');
  await page.mouse.move(5, 5);
  await expect(icon).toHaveCSS('opacity', '0');
  await lights.first().hover();
  await expect(icon).toHaveCSS('opacity', '1');
  await page.mouse.move(600, 400);
});

test('Cine: barra superior transparente que pasa a sólida al desplazar, secciones a la izquierda y avatar a la derecha', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await useTheme('Cine', 'cine');
  await expect(html()).toHaveAttribute('data-scheme', 'dark');
  await expect(page.locator('[data-titlebar="cine"]')).toHaveCount(1);
  await expect(page.locator('[data-background="gradient"]')).toHaveCount(1);
  const bar = page.locator('[data-topbar]');
  const link = (name: string) => bar.getByRole('button', { name, exact: true });
  await link('Galería').click();
  await expect(heading('Galería')).toBeVisible();
  await expect(bar).toHaveAttribute('data-scrolled', 'false');
  await expect(bar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // Secciones a la izquierda y avatar a la derecha.
  const avatar = bar.getByRole('img', { name: `Perfil: ${PROFILE}` });
  const leftBox = await link('Galería').boundingBox();
  const rightBox = await avatar.boundingBox();
  expect(leftBox && leftBox.x < 200).toBe(true);
  expect(rightBox && rightBox.x > 1100).toBe(true);
  // Desplazar la rejilla vuelve sólida la barra; volver arriba, transparente.
  const grid = page.locator('[data-gallery-grid]');
  await expect(grid).toBeVisible();
  await grid.evaluate((el) => {
    el.scrollTop = 300;
  });
  await expect(bar).toHaveAttribute('data-scrolled', 'true');
  await expect(bar).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await grid.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(bar).toHaveAttribute('data-scrolled', 'false');
  // Teclado: ←/→ recorren las secciones sin abrir, Intro abre; todas las pantallas del NavModel.
  await link('Galería').focus();
  await page.keyboard.press('ArrowRight');
  await expect(link('Fotos')).toBeFocused();
  await expect(heading('Galería')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(heading('Fotos')).toBeVisible();
  await expect(link('Fotos')).toHaveAttribute('aria-current', 'page');
  for (const name of ['Vídeos', 'Playlists', 'Vídeo dual', 'Ajustes', 'Ayuda']) {
    await link(name).click();
    await expect(heading(name)).toBeVisible();
    await expect(bar).toHaveAttribute('data-scrolled', 'false');
  }
});
