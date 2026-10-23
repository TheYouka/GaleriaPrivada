// Argon2id de producción dentro de Electron (docs/DESIGN.md §6.1; PLAN, convención de tests lentos).
// Solo con GALERIA_SLOW_TESTS=1. Sin GALERIA_TEST_FAST_KDF, como en `npm run dev`: crear calibra
// Argon2 en el proceso main y guarda esos parámetros, y desbloquear (con la contraseña incorrecta y
// con la correcta) y cambiar la contraseña los usan. El resto de E2E usa los parámetros rápidos.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, lockAndGetNewWindow, openCreateProfile, unlockProfile } from './helpers/launch';

const NAME = 'Lenta';
const PASSWORD = 'clave-de-produccion-1';
const NEW_PASSWORD = 'otra-clave-de-produccion-2';

test.skip(process.env.GALERIA_SLOW_TESTS !== '1', 'solo con GALERIA_SLOW_TESTS=1');

interface StoredKdf {
  alg: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

function storedKdf(dataDir: string): StoredKdf {
  const json = JSON.parse(readFileSync(join(dataDir, 'profiles.json'), 'utf8')) as {
    profiles: { name: string; kdf: StoredKdf }[];
  };
  const profile = json.profiles.find((p) => p.name === NAME);
  if (!profile) throw new Error('no existe el perfil');
  return profile.kdf;
}

test('crear, desbloquear, bloquear y cambiar la contraseña con Argon2 calibrado', async () => {
  test.setTimeout(240_000);
  // '0' anula el '1' por defecto de appEnv: kdf.ts solo acepta exactamente '1'.
  const launched = await launchApp({ env: { GALERIA_TEST_FAST_KDF: '0' } });
  try {
    let page = launched.page;

    // Crear: "Preparando tu bóveda…" mientras se calibra y se deriva la KEK.
    await openCreateProfile(page);
    await page.getByLabel('Nombre', { exact: true }).fill(NAME);
    await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Repetir contraseña', { exact: true }).fill(PASSWORD);
    await page
      .getByRole('checkbox', {
        name: 'Entiendo que si olvido la contraseña perderé el acceso para siempre',
      })
      .check();
    const started = Date.now();
    await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Preparando tu bóveda…' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible({
      timeout: 60_000,
    });
    console.log(`[e2e] crear con Argon2 calibrado: ${Date.now() - started} ms`);

    // Parámetros de producción de §6.1 (nunca los rápidos de test, 8 MiB / t=1 / p=1).
    const kdf = storedKdf(launched.dataDir);
    console.log(
      `[e2e] KDF guardada: m=${kdf.memoryKiB} KiB, t=${kdf.iterations}, p=${kdf.parallelism}`,
    );
    expect(kdf.alg).toBe('argon2id');
    expect(kdf.memoryKiB).toBeGreaterThanOrEqual(65536);
    expect(kdf.parallelism).toBe(4);
    expect(kdf.iterations).toBeGreaterThanOrEqual(2);
    expect(kdf.iterations).toBeLessThanOrEqual(8);
    const logText = readFileSync(join(launched.dataDir, 'logs', 'main.log'), 'utf8');
    expect(logText).toContain('"event":"kdf.calibrated"');
    expect(logText).not.toContain('kdf.fast-params');

    // Desbloquear: la incorrecta da "Contraseña incorrecta"; la correcta abre la bóveda.
    await page.getByRole('button', { name: NAME, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: NAME });
    const field = dialog.getByLabel('Contraseña', { exact: true });
    await field.fill('incorrecta-1');
    await field.press('Enter');
    await expect(dialog.getByText('Contraseña incorrecta')).toBeVisible({ timeout: 30_000 });
    await field.fill(PASSWORD);
    await field.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
      timeout: 30_000,
    });

    // Bloquear y volver a entrar.
    page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
    await unlockProfile(page, NAME, PASSWORD);
    page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));

    // Cambiar la contraseña: nueva sal y parámetros calibrados otra vez; la antigua deja de valer.
    const before = storedKdf(launched.dataDir);
    await page.getByRole('button', { name: 'Administrar perfiles' }).click();
    await page.getByRole('button', { name: `Cambiar contraseña de ${NAME}`, exact: true }).click();
    const change = page.getByRole('dialog', { name: 'Cambiar contraseña' });
    await change.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
    await change.getByLabel('Nueva contraseña', { exact: true }).fill(NEW_PASSWORD);
    await change.getByLabel('Repetir la nueva contraseña', { exact: true }).fill(NEW_PASSWORD);
    await change.getByRole('button', { name: 'Cambiar contraseña' }).click();
    await expect(change).toBeHidden({ timeout: 60_000 });
    const after = storedKdf(launched.dataDir);
    expect(after.salt).not.toBe(before.salt);
    expect(after.memoryKiB).toBeGreaterThanOrEqual(65536);

    await page.getByRole('button', { name: 'Listo' }).click();
    await page.getByRole('button', { name: NAME, exact: true }).click();
    const unlock = page.getByRole('dialog', { name: NAME });
    await unlock.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await unlock.getByLabel('Contraseña', { exact: true }).press('Enter');
    await expect(unlock.getByText('Contraseña incorrecta')).toBeVisible({ timeout: 30_000 });
    await unlock.getByLabel('Contraseña', { exact: true }).fill(NEW_PASSWORD);
    await unlock.getByLabel('Contraseña', { exact: true }).press('Enter');
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await launched.close();
  }
});
