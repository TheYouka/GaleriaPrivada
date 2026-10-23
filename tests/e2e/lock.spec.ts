// Bloqueo (docs/PLAN.md 1.14; docs/DESIGN.md §13.2–§13.3): Ctrl+L sustituye la ventana por otra con
// un proceso de renderer nuevo (R20), suspensión y bloqueo del SO con las claves a cero en ≤ 200 ms,
// inactividad con un tiempo corto de test, y con la bóveda bloqueada los canales "U" dan LOCKED
// mientras vault://avatar (en claro) sigue respondiendo.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { GaleriaApi } from '../../src/shared/ipc-contract';
import {
  createProfile,
  launchApp,
  lockAndGetNewWindow,
  openCreateProfile,
  rendererPid,
  ROOT,
  unlockProfile,
  type LaunchedApp,
} from './helpers/launch';

const PASSWORD = 'clave-de-prueba-1';

type GaleriaWindow = Window & { galeria: GaleriaApi };

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as { code?: string }).code === 'ESRCH';
  }
}

async function lastZeroizeMs(launched: LaunchedApp): Promise<number | undefined> {
  return launched.app.evaluate(
    () => (globalThis as { __galeriaLastZeroizeMs?: number }).__galeriaLastZeroizeMs,
  );
}

test.describe('bloqueo manual, suspensión y bloqueo del SO', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let page: Page;

  test.beforeAll(async () => {
    launched = await launchApp();
    page = launched.page;
    await createProfile(page, 'Ana', PASSWORD);
  });

  test.afterAll(async () => {
    await launched?.close();
  });

  test('Ctrl+L: vuelve al selector en una ventana nueva con otro proceso de renderer (R20)', async () => {
    await unlockProfile(page, 'Ana', PASSWORD);
    const oldPid = await rendererPid(launched.app);
    expect(oldPid).toBeGreaterThan(0);
    page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
    await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible();
    const newPid = await rendererPid(launched.app);
    expect(newPid).toBeGreaterThan(0);
    expect(newPid).not.toBe(oldPid);
    await expect.poll(() => processGone(oldPid), { timeout: 5000 }).toBe(true);
    expect(await lastZeroizeMs(launched)).toBeGreaterThanOrEqual(0);
  });

  test('el candado de la barra de título también bloquea', async () => {
    await unlockProfile(page, 'Ana', PASSWORD);
    page = await lockAndGetNewWindow(launched.app, () =>
      page.getByRole('button', { name: 'Bloquear (Ctrl+L)' }).click(),
    );
    await expect(page.getByRole('button', { name: 'Ana', exact: true })).toBeVisible();
  });

  test('suspensión (powerMonitor suspend): claves a cero en ≤ 200 ms y ventana nueva', async () => {
    await unlockProfile(page, 'Ana', PASSWORD);
    const oldPid = await rendererPid(launched.app);
    page = await lockAndGetNewWindow(launched.app, () =>
      launched.app.evaluate(({ powerMonitor }) => {
        powerMonitor.emit('suspend');
      }),
    );
    const ms = await lastZeroizeMs(launched);
    console.log(`[e2e] __galeriaLastZeroizeMs (suspend) = ${ms}`);
    expect(ms).toBeDefined();
    expect(ms as number).toBeLessThanOrEqual(200);
    expect(await rendererPid(launched.app)).not.toBe(oldPid);
  });

  test('bloqueo del SO (powerMonitor lock-screen): bloquea al momento', async () => {
    await unlockProfile(page, 'Ana', PASSWORD);
    page = await lockAndGetNewWindow(launched.app, () =>
      launched.app.evaluate(({ powerMonitor }) => {
        powerMonitor.emit('lock-screen');
      }),
    );
    const ms = await lastZeroizeMs(launched);
    console.log(`[e2e] __galeriaLastZeroizeMs (lock-screen) = ${ms}`);
    expect(ms as number).toBeLessThanOrEqual(200);
  });

  test('bloqueada: los canales "U" dan LOCKED y vault://avatar sigue respondiendo', async () => {
    // Perfil con foto de avatar (diálogo nativo simulado, §23.2).
    const dir = join(ROOT, 'tests', '.tmp', 'e2e-fixtures');
    mkdirSync(dir, { recursive: true });
    const photo = join(dir, `avatar-${Date.now()}.png`);
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3366cc' } })
      .png()
      .toFile(photo);
    await launched.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, photo);

    await openCreateProfile(page);
    await page.getByLabel('Nombre', { exact: true }).fill('Foto');
    await page.getByRole('button', { name: 'Usar una foto…' }).click();
    await expect(page.getByRole('radio', { name: 'Foto elegida' })).toBeChecked();
    await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Repetir contraseña', { exact: true }).fill(PASSWORD);
    await page
      .getByRole('checkbox', {
        name: 'Entiendo que si olvido la contraseña perderé el acceso para siempre',
      })
      .check();
    await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Foto', exact: true })).toBeFocused({
      timeout: 20_000,
    });

    // Desbloquear y bloquear: en la ventana nueva (bloqueada) se comprueba todo.
    await unlockProfile(page, 'Foto', PASSWORD);
    page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));

    const results = await page.evaluate(async () => {
      const g = (window as unknown as GaleriaWindow).galeria;
      return {
        prefsGet: await g.invoke('prefs:get'),
        prefsSet: await g.invoke('prefs:set', { autoLockMinutes: 0 }),
        activity: await g.invoke('session:activity'),
        playback: await g.invoke('session:setPlayback', { active: true }),
        state: await g.invoke('session:getState'),
      };
    });
    expect(results.prefsGet).toEqual({ ok: false, error: { code: 'LOCKED' } });
    expect(results.prefsSet).toEqual({ ok: false, error: { code: 'LOCKED' } });
    expect(results.activity).toEqual({ ok: false, error: { code: 'LOCKED' } });
    expect(results.playback).toEqual({ ok: false, error: { code: 'LOCKED' } });
    expect(results.state).toEqual({ ok: true, data: { state: 'locked' } });

    const avatar = page.getByRole('button', { name: 'Foto', exact: true }).locator('img');
    await expect(avatar).toHaveAttribute('src', /^vault:\/\/avatar\/[0-9a-f]{32}\?rev=1$/);
    await expect
      .poll(() => avatar.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBe(256);
    rmSync(photo, { force: true });
  });
});

test('inactividad: se bloquea solo con un tiempo de test corto (GALERIA_TEST_AUTOLOCK_MS)', async () => {
  const launched = await launchApp({ env: { GALERIA_TEST_AUTOLOCK_MS: '1500' } });
  try {
    await createProfile(launched.page, 'Ana', PASSWORD);
    const nextWindow = launched.app.waitForEvent('window', { timeout: 20_000 });
    await unlockProfile(launched.page, 'Ana', PASSWORD);
    const unlockedAt = Date.now();
    const page = await nextWindow;
    const elapsed = Date.now() - unlockedAt;
    console.log(`[e2e] bloqueo por inactividad tras ${elapsed} ms`);
    await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible();
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    const state = await page.evaluate(() =>
      (window as unknown as GaleriaWindow).galeria.invoke('session:getState'),
    );
    expect(state).toEqual({ ok: true, data: { state: 'locked' } });
  } finally {
    await launched.close();
  }
});
