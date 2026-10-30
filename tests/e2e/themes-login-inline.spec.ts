// Selector `login` de Cristal (docs/PLAN.md 6.4, D9; docs/DESIGN.md §14.3 y §15.10): la contraseña se
// pide EN LÍNEA bajo el avatar elegido (no en un diálogo modal), en claro y oscuro. Mismo formulario
// que el diálogo (errores, «Mostrar», «Entrar», «Cancelar»), foco automático en el campo, las flechas
// y Inicio/Fin editan el texto sin mover el foco de la lista, Esc cierra y devuelve el foco al avatar.
// Ventana discreta (nota 135); datos solo bajo tests/.tmp/.
import { expect, test, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, type LaunchedApp } from './helpers/launch';

const PASSWORD = 'clave-de-prueba-1';
const PROFILE = 'Ana';

let launched: LaunchedApp;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  page = launched.page;
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
  });
  await createProfile(page, PROFILE, PASSWORD);
  await choosePickerTheme(page, 'Cristal');
});

test.afterAll(async () => {
  await launched?.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Cristal ${scheme === 'light' ? 'claro' : 'oscuro'}: la contraseña va en línea bajo el avatar`, async () => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'macos');
    await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
    await expect(page.locator('[data-picker]')).toHaveAttribute('data-picker', 'login');

    const ana = page.getByRole('button', { name: PROFILE, exact: true });
    await ana.click();
    const group = page.getByRole('group', { name: `Contraseña de ${PROFILE}` });
    await expect(group).toBeVisible();
    // Sin diálogo modal; el formulario está dentro de la misma entrada de la lista, bajo el avatar.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('listitem').filter({ has: ana }).filter({ has: group }),
    ).toHaveCount(1);
    const avatarBox = await ana.boundingBox();
    const groupBox = await group.boundingBox();
    expect(groupBox?.y ?? 0).toBeGreaterThanOrEqual(
      (avatarBox?.y ?? 0) + (avatarBox?.height ?? 0) - 1,
    );
    await expect(group.getByRole('button', { name: 'Mostrar contraseña' })).toBeVisible();
    await expect(group.getByRole('button', { name: 'Cancelar' })).toBeVisible();
    await expect(group.getByRole('button', { name: 'Entrar' })).toBeVisible();

    // Foco automático; las teclas de la lista no le roban el foco al campo.
    const field = group.getByLabel('Contraseña', { exact: true });
    await expect(field).toBeFocused();
    await field.fill('incorrecta-1');
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key);
      await expect(field).toBeFocused();
    }

    // Contraseña incorrecta: el error se anuncia en el formulario y el foco sigue en el campo.
    await field.press('Enter');
    await expect(group.getByText('Contraseña incorrecta')).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toBeFocused();

    if (scheme === 'light') {
      // Esc cierra el formulario y devuelve el foco al avatar.
      await page.keyboard.press('Escape');
      await expect(group).toHaveCount(0);
      await expect(ana).toBeFocused();
      return;
    }

    // Oscuro: «Entrar» con la contraseña correcta abre la bóveda.
    await field.fill(PASSWORD);
    await group.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
      timeout: 20_000,
    });
  });
}
