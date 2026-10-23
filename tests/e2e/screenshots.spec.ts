// Verificación visual de la Fase 1: capturas del selector, del desbloqueo y de "Crear perfil" en los
// dos temas de F1, cada una con el foco de teclado en un control (alcanzado con Tab o las flechas)
// para que se vea el anillo. Se guardan en tests/.tmp/screenshots/fase-1/ para revisarlas a mano;
// no se comparan con referencias (eso es la Fase 6, themes.spec.ts).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  choosePickerTheme,
  createProfile,
  launchApp,
  ROOT,
  type LaunchedApp,
} from './helpers/launch';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-1');
const PASSWORD = 'clave-de-prueba-1';

let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  launched = await launchApp();
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
  });
  const { page } = launched;
  await createProfile(page, 'Ana', PASSWORD);
  await createProfile(page, 'Bruno', PASSWORD);
});

test.afterAll(async () => {
  await launched?.close();
});

async function snap(page: Page, name: string): Promise<void> {
  // Las animaciones de entrada (40 ms por avatar) y el fundido del tema ya han terminado.
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, name) });
}

async function setPickerTheme(page: Page, displayName: string, id: string): Promise<void> {
  await choosePickerTheme(page, displayName);
  await expect(page.locator('html')).toHaveAttribute('data-theme', id);
}

for (const [label, displayName, id] of [
  ['clasico', 'Clásico', 'fotos'],
  ['ondas', 'Ondas', 'ps3'],
] as const) {
  test(`capturas del tema ${displayName}`, async () => {
    const { page } = launched;
    await setPickerTheme(page, displayName, id);

    // Selector: Tab desde el <h1> entra en la lista (roving tabindex: el último avatar enfocado),
    // Home va al primero y → al segundo.
    await page.getByRole('heading', { level: 1, name: '¿Quién eres?' }).focus();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('list', { name: 'Perfiles' }).getByRole('button').first(),
    ).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.getByRole('button', { name: 'Ana', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Bruno', exact: true })).toBeFocused();
    await snap(page, `picker-${label}.png`);

    // Desbloqueo: Enter abre el diálogo (foco en la contraseña) y Tab lleva a "Mostrar".
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Bruno' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Contraseña', { exact: true })).toBeFocused();
    await page.keyboard.type('clave');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Mostrar contraseña' })).toBeFocused();
    await snap(page, `unlock-${label}.png`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Bruno', exact: true })).toBeFocused();

    // Crear perfil: desde "Añadir perfil" (End), nombre escrito y foco en un avatar con las flechas.
    await page.keyboard.press('End');
    await expect(page.getByRole('button', { name: 'Añadir perfil', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Crear perfil' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Nombre', { exact: true })).toBeFocused();
    await page.keyboard.type('Carmen');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Aurora' })).toBeFocused();
    // Pulsación de 100 ms, como una real: Radix marca la opción mientras la flecha está pulsada.
    await page.keyboard.press('ArrowRight', { delay: 100 });
    await expect(page.getByRole('radio', { name: 'Bosque' })).toBeFocused();
    await expect(page.getByRole('radio', { name: 'Bosque' })).toBeChecked();
    await expect(page.getByText('No hay forma de recuperar la contraseña.')).toBeVisible();
    await snap(page, `create-profile-${label}.png`);
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible();
  });
}
