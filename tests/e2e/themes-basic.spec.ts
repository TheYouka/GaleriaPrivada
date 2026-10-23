// Temas de F1 (docs/PLAN.md 1.14; docs/DESIGN.md §15.4, §15.8 y §15.9): cambio en vivo de "Clásico"
// a "Ondas" desde Ajustes sin recargar, conservando la pantalla y el foco; la elección global se
// mantiene tras bloquear (la ventana nueva nace con el tema nuevo); la paleta del selector cambia el
// tema global; "solo mi perfil" no toca el del selector.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  choosePickerTheme,
  createProfile,
  launchApp,
  lockAndGetNewWindow,
  readProfilesJson,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';

const PASSWORD = 'clave-de-prueba-1';

let launched: LaunchedApp;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
  await createProfile(page, 'Ana', PASSWORD);
});

test.afterAll(async () => {
  await launched?.close();
});

function settingsJson(): { pickerThemeId: string; colorScheme: string } {
  return JSON.parse(readFileSync(join(launched.dataDir, 'settings.json'), 'utf8')) as {
    pickerThemeId: string;
    colorScheme: string;
  };
}

function prefsJson(): { themeId: string | null } {
  const id = readProfilesJson(launched.dataDir).profiles[0]?.id ?? '';
  const file = join(launched.dataDir, 'prefs', `${id}.json`);
  // Sin archivo, las preferencias son las predeterminadas (themeId null = heredar, §15.9).
  if (!existsSync(file)) return { themeId: null };
  return JSON.parse(readFileSync(file, 'utf8')) as { themeId: string | null };
}

const html = (p: Page) => p.locator('html');

test('Ajustes: Clásico → Ondas en vivo, sin recargar, en la misma pantalla y con el mismo foco', async () => {
  await unlockProfile(page, 'Ana', PASSWORD);
  await expect(html(page)).toHaveAttribute('data-theme', 'fotos');
  await page.evaluate(() => {
    (window as unknown as { __e2eNoReload: boolean }).__e2eNoReload = true;
  });

  await page.keyboard.press('Control+Comma');
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
  const classic = page.getByRole('radio', { name: 'Clásico' });
  const waves = page.getByRole('radio', { name: 'Ondas' });
  await expect(classic).toBeChecked();
  // "Toda la app" es lo predeterminado para un perfil que hereda el tema global.
  await expect(page.getByRole('radio', { name: 'Toda la app' })).toBeChecked();

  // Con el teclado: foco en la tarjeta marcada y → (la pulsación dura 100 ms, como una real: Radix
  // marca la opción al moverse el foco mientras la flecha está pulsada).
  await classic.focus();
  await page.keyboard.press('ArrowRight', { delay: 100 });
  await expect(html(page)).toHaveAttribute('data-theme', 'ps3');
  await expect(html(page)).toHaveAttribute('data-scheme', 'dark');
  await expect(waves).toBeChecked();
  await expect(waves).toBeFocused();
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
  await expect(page.locator('[data-background="waves"]')).toHaveCount(1);
  await expect(page.locator('[data-titlebar="xmb"]')).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload),
  ).toBe(true);
  await expect.poll(() => settingsJson().pickerThemeId).toBe('ps3');
  expect(prefsJson().themeId).toBeNull();

  // Y de vuelta, también en vivo.
  await page.keyboard.press('ArrowLeft', { delay: 100 });
  await expect(html(page)).toHaveAttribute('data-theme', 'fotos');
  await expect(classic).toBeFocused();
  await page.keyboard.press('ArrowRight', { delay: 100 });
  await expect(html(page)).toHaveAttribute('data-theme', 'ps3');
  await expect.poll(() => settingsJson().pickerThemeId).toBe('ps3');
});

test('la elección global se mantiene tras bloquear: la ventana nueva nace con "Ondas"', async () => {
  page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
  await expect(html(page)).toHaveAttribute('data-theme', 'ps3');
  const initial = await page.evaluate(
    () => (window as unknown as { galeria: { initialTheme: unknown } }).galeria.initialTheme,
  );
  expect(initial).toEqual({ themeId: 'ps3', scheme: 'dark' });
  await expect(page.locator('[data-background="waves"]')).toHaveCount(1);
});

test('la paleta del selector cambia el tema global en vivo', async () => {
  await page.evaluate(() => {
    (window as unknown as { __e2eNoReload: boolean }).__e2eNoReload = true;
  });
  await choosePickerTheme(page, 'Clásico');
  await expect(html(page)).toHaveAttribute('data-theme', 'fotos');
  // El selector `fluent` fuerza el fondo oscuro (§15.10).
  await expect(html(page)).toHaveAttribute('data-scheme', 'dark');
  await expect(page.getByRole('button', { name: 'Cambiar tema' })).toBeFocused();
  await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload),
  ).toBe(true);
  await expect.poll(() => settingsJson().pickerThemeId).toBe('fotos');
});

test('"Solo mi perfil" guarda el tema en prefs y el selector conserva el global', async () => {
  await unlockProfile(page, 'Ana', PASSWORD);
  await page.keyboard.press('Control+Comma');
  await page.getByRole('radio', { name: 'Solo mi perfil' }).click();
  await expect.poll(() => prefsJson().themeId).toBe('fotos');
  await page.getByRole('radio', { name: 'Ondas' }).click();
  await expect(html(page)).toHaveAttribute('data-theme', 'ps3');
  await expect.poll(() => prefsJson().themeId).toBe('ps3');
  expect(settingsJson().pickerThemeId).toBe('fotos');

  page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
  await expect(html(page)).toHaveAttribute('data-theme', 'fotos');
  // Al desbloquear se aplica el del perfil.
  await unlockProfile(page, 'Ana', PASSWORD);
  await expect(html(page)).toHaveAttribute('data-theme', 'ps3');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
});

test('XMB (stub de Ondas): ←/→ categorías, ↑/↓ subelementos, Enter abre y Esc vuelve a la barra', async () => {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  const category = (name: string) =>
    nav.getByRole('list', { name: 'Categorías' }).getByRole('button', { name, exact: true });
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(category('Galería')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(category('Playlists')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(category('Ajustes')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    nav.getByRole('list', { name: 'Ajustes' }).getByRole('button', { name: 'Ajustes' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(category('Ajustes')).toBeFocused();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(category('Galería')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(nav.getByRole('button', { name: 'Fotos', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(category('Galería')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Fotos' })).toBeFocused();
  // Retroceso desde el contenido también vuelve a la barra.
  await page.keyboard.press('Backspace');
  await expect(category('Galería')).toBeFocused();
});
