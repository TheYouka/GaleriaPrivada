// Perfiles (docs/PLAN.md 1.14; docs/DESIGN.md §14.2–§14.4): crear con el aviso de no recuperación,
// desbloquear con la contraseña incorrecta y la correcta, editar (exige contraseña), cambiar la
// contraseña, borrar (exige SIEMPRE la contraseña y el nombre) y el selector solo con teclado.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  createProfile,
  launchApp,
  lockAndGetNewWindow,
  readProfilesJson,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';

const PASSWORD = 'clave-de-ana-1';
const NEW_PASSWORD = 'otra-clave-de-ana-2';

let launched: LaunchedApp;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

/** Ningún enlace ni botón para recuperar, restablecer u "olvidé la contraseña" (§14.3, anexo §1). */
async function expectNoRecovery(p: Page): Promise<void> {
  await expect(p.getByText(/olvidaste|olvidé|restablecer/i)).toHaveCount(0);
  await expect(p.getByRole('link', { name: /contraseña/i })).toHaveCount(0);
  await expect(p.getByRole('button', { name: /recuperar|olvid|restablecer/i })).toHaveCount(0);
}

/** Huella de la bóveda y de profiles.json (sin logs, que sí cambian). */
function snapshot(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(dataDir, full);
      if (rel === 'logs') continue;
      if (entry.isDirectory()) walk(full);
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dataDir);
  return out;
}

function profileId(name: string): string {
  const p = readProfilesJson(launched.dataDir).profiles.find((x) => x.name === name);
  if (!p) throw new Error(`no existe el perfil ${name}`);
  return p.id;
}

test('crear perfil: aviso de no recuperación, casilla obligatoria y contraseñas iguales', async () => {
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  await expectNoRecovery(page);
  await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Crear perfil' })).toBeVisible();

  const note = page.getByRole('note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('No hay forma de recuperar la contraseña.');
  await expect(note).toContainText('Galería tampoco tiene función de exportar.');
  await expectNoRecovery(page);

  const create = page.getByRole('button', { name: 'Crear perfil', exact: true });
  const checkbox = page.getByRole('checkbox', {
    name: 'Entiendo que si olvido la contraseña perderé el acceso para siempre',
  });
  await expect(create).toBeDisabled();

  await page.getByLabel('Nombre', { exact: true }).fill('Ana');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repetir contraseña', { exact: true }).fill('distinta-123');
  await expect(page.getByText('Las contraseñas no coinciden')).toBeVisible();
  await checkbox.check();
  await expect(create).toBeDisabled();

  await page.getByLabel('Repetir contraseña', { exact: true }).fill(PASSWORD);
  await expect(page.getByText('Las contraseñas no coinciden')).toHaveCount(0);
  await expect(create).toBeEnabled();
  await checkbox.uncheck();
  await expect(create).toBeDisabled();
  await checkbox.check();

  // Menos de 8 caracteres: deshabilitado y con el mensaje al salir del campo.
  await page.getByLabel('Contraseña', { exact: true }).fill('1234567');
  await page.getByLabel('Repetir contraseña', { exact: true }).fill('1234567');
  await expect(create).toBeDisabled();
  await expect(page.getByText('Mínimo 8 caracteres')).toBeVisible();

  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repetir contraseña', { exact: true }).fill(PASSWORD);
  await expect(create).toBeEnabled();
  await create.click();

  await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Ana', exact: true })).toBeFocused();
  const id = profileId('Ana');
  expect(existsSync(join(launched.dataDir, 'vaults', id, 'library.db'))).toBe(true);
  expect(existsSync(join(launched.dataDir, 'vaults', `${id}.creating`))).toBe(false);
});

test('desbloquear: "Contraseña incorrecta" con el texto seleccionado y después la correcta', async () => {
  await page.getByRole('button', { name: 'Ana', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ana' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('Contraseña', { exact: true });
  await expect(field).toBeFocused();
  await expectNoRecovery(page);

  await field.fill('incorrecta-1');
  await field.press('Enter');
  await expect(dialog.getByText('Contraseña incorrecta')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toBeFocused();
  const selection = await field.evaluate((el) => {
    const input = el as HTMLInputElement;
    return [input.selectionStart, input.selectionEnd, input.value.length];
  });
  expect(selection).toEqual([0, 'incorrecta-1'.length, 'incorrecta-1'.length]);
  await expectNoRecovery(page);

  await field.fill(PASSWORD);
  await field.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeFocused();
  await expect(
    page.getByText('Tu bóveda está lista. La importación llega en la siguiente fase.'),
  ).toBeVisible();

  page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
  await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible();
});

test('editar el nombre exige la contraseña del perfil', async () => {
  await page.getByRole('button', { name: 'Administrar perfiles' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Administrar perfiles' })).toBeVisible();
  await page.getByRole('button', { name: 'Editar Ana', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Editar «Ana»' })).toBeVisible();

  await page.getByLabel('Nombre', { exact: true }).fill('Ana María');
  const save = page.getByRole('button', { name: 'Guardar cambios' });
  await expect(save).toBeDisabled();

  await page.getByLabel('Contraseña del perfil', { exact: true }).fill('incorrecta-1');
  await save.click();
  await expect(page.locator('form').getByText('Contraseña incorrecta')).toBeVisible();
  expect(readProfilesJson(launched.dataDir).profiles.map((p) => p.name)).toEqual(['Ana']);

  await page.getByLabel('Contraseña del perfil', { exact: true }).fill(PASSWORD);
  await save.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Administrar perfiles' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Editar Ana María', exact: true })).toBeFocused();
  expect(readProfilesJson(launched.dataDir).profiles.map((p) => p.name)).toEqual(['Ana María']);
});

test('cambiar la contraseña: la antigua deja de funcionar y la nueva funciona', async () => {
  await page.getByRole('button', { name: 'Cambiar contraseña de Ana María', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cambiar contraseña' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('no se vuelven a cifrar');

  await dialog.getByLabel('Contraseña actual', { exact: true }).fill('incorrecta-1');
  await dialog.getByLabel('Nueva contraseña', { exact: true }).fill(NEW_PASSWORD);
  await dialog.getByLabel('Repetir la nueva contraseña', { exact: true }).fill(NEW_PASSWORD);
  await dialog.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(dialog.getByText('Contraseña incorrecta')).toBeVisible();

  await dialog.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Contraseña cambiada.').first()).toBeVisible();

  await page.getByRole('button', { name: 'Listo' }).click();
  await page.getByRole('button', { name: 'Ana María', exact: true }).click();
  const unlock = page.getByRole('dialog', { name: 'Ana María' });
  await unlock.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await unlock.getByLabel('Contraseña', { exact: true }).press('Enter');
  await expect(unlock.getByText('Contraseña incorrecta')).toBeVisible();
  await unlock.getByLabel('Contraseña', { exact: true }).fill(NEW_PASSWORD);
  await unlock.getByLabel('Contraseña', { exact: true }).press('Enter');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
    timeout: 20_000,
  });
  page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
});

test('borrar exige la contraseña y el nombre; con la incorrecta no cambia nada', async () => {
  await createProfile(page, 'Bruno', 'clave-de-bruno-1');
  const id = profileId('Ana María');
  const vaultDir = join(launched.dataDir, 'vaults', id);

  await page.getByRole('button', { name: 'Administrar perfiles' }).click();
  await page.getByRole('button', { name: 'Eliminar Ana María', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Eliminar «Ana María»' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Se borrarán para siempre todas las fotos, vídeos, playlists');
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  const confirm = dialog.getByRole('button', { name: 'Eliminar perfil' });
  await expect(confirm).toBeDisabled();

  // Sin contraseña no se puede: solo con el nombre sigue deshabilitado.
  await dialog.getByLabel('Escribe el nombre del perfil para confirmar').fill('Ana María');
  await expect(confirm).toBeDisabled();

  const before = snapshot(launched.dataDir);
  await dialog.getByLabel('Contraseña del perfil', { exact: true }).fill('incorrecta-1');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog.getByText('Contraseña incorrecta')).toBeVisible();
  expect(snapshot(launched.dataDir)).toEqual(before);
  expect(statSync(vaultDir).isDirectory()).toBe(true);

  // Contraseña correcta y nombre distinto: tampoco.
  await dialog.getByLabel('Contraseña del perfil', { exact: true }).fill(NEW_PASSWORD);
  await dialog.getByLabel('Escribe el nombre del perfil para confirmar').fill('Otra');
  await confirm.click();
  await expect(dialog.getByText('El nombre no coincide con el del perfil.')).toBeVisible();
  expect(snapshot(launched.dataDir)).toEqual(before);

  await dialog.getByLabel('Escribe el nombre del perfil para confirmar').fill('ana maría');
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Se eliminó el perfil «Ana María».').first()).toBeVisible();
  expect(existsSync(vaultDir)).toBe(false);
  expect(existsSync(join(launched.dataDir, 'prefs', `${id}.json`))).toBe(false);
  expect(readProfilesJson(launched.dataDir).profiles.map((p) => p.name)).toEqual(['Bruno']);
  await expect(page.getByRole('button', { name: 'Eliminar Ana María', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Listo' })).toBeFocused();
  await page.getByRole('button', { name: 'Listo' }).click();
});

/**
 * Cierra los avisos abiertos. Cada aviso es una capa de Radix (DismissableLayer): mientras hay uno,
 * un diálogo recién abierto engancha su Esc un render después de enfocar el campo, y un Esc enviado
 * en ese hueco (milisegundos, solo posible en un test) cierra el aviso y no el diálogo
 * (docs/PLAN.md, nota 79).
 */
async function closeToasts(p: Page): Promise<void> {
  const close = p
    .getByRole('region', { name: 'Notificaciones (F8)' })
    .getByRole('button', { name: 'Cerrar', exact: true });
  while ((await close.count()) > 0) await close.first().click();
  await expect(close).toHaveCount(0);
}

test('selector solo con teclado: flechas, Home/End, Enter, Esc y Tab', async () => {
  await closeToasts(page); // el del borrado anterior
  await createProfile(page, 'Carla', 'clave-de-carla-1');
  const bruno = page.getByRole('button', { name: 'Bruno', exact: true });
  const carla = page.getByRole('button', { name: 'Carla', exact: true });
  const add = page.getByRole('button', { name: 'Añadir perfil', exact: true });

  await page.getByRole('heading', { level: 1, name: '¿Quién eres?' }).focus();
  await page.keyboard.press('Tab');
  await expect(carla).toBeFocused(); // roving tabindex: el último enfocado
  await page.keyboard.press('Home');
  await expect(bruno).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(bruno).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(carla).toBeFocused();
  await page.keyboard.press('End');
  await expect(add).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(carla).toBeFocused();
  await page.keyboard.press('Home');
  // Solo un elemento de la lista está en el orden de Tab.
  await expect(page.getByRole('list', { name: 'Perfiles' }).locator('[tabindex="0"]')).toHaveCount(
    1,
  );

  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Bruno' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Contraseña', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(bruno).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Administrar perfiles' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(bruno).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(bruno).toBeFocused();

  // Con teclado se llega también al desbloqueo completo.
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Contraseña', { exact: true })).toBeFocused();
  await page.keyboard.type('clave-de-bruno-1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
    timeout: 20_000,
  });
  await unlockedKeyboardChecks(page);
});

/** Con la bóveda abierta: "Saltar al contenido" es lo primero y Ctrl+, abre Ajustes. */
async function unlockedKeyboardChecks(p: Page): Promise<void> {
  await p.keyboard.press('Control+Comma');
  await expect(p.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeFocused();
  // El enlace es el primer elemento enfocable del documento y va justo antes de la navegación.
  const first = await p.evaluate(
    () =>
      document.querySelector<HTMLElement>('a[href], button, input, [tabindex="0"]')?.textContent,
  );
  expect(first).toBe('Saltar al contenido');
  await p.getByRole('button', { name: /Contraer navegación|Expandir navegación/ }).focus();
  await p.keyboard.press('Shift+Tab');
  await expect(p.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await expect(p.getByRole('link', { name: 'Saltar al contenido' })).toBeVisible();
  await p.keyboard.press('Enter');
  await expect(p.locator('main#contenido')).toBeFocused();
}

test('unlockProfile del helper también funciona (sanidad de los E2E)', async () => {
  page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
  await unlockProfile(page, 'Carla', 'clave-de-carla-1');
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
});
