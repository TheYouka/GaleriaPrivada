// Lanza la app construida (out/) con el Electron de desarrollo y una raíz de datos temporal propia,
// y ofrece los pasos comunes de los E2E de perfiles (docs/DESIGN.md §23.2).
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

export const ROOT = resolve(__dirname, '..', '..', '..');

export interface LaunchOptions {
  /** Variables extra (sustituyen a las de por defecto). */
  env?: Record<string, string>;
  /** Raíz de datos ya creada (para dos instancias sobre la misma). */
  dataDir?: string;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  /** Cierra la app y borra sus datos. */
  close: () => Promise<void>;
  /** Cierra la app sin borrar nada (para inspeccionar el disco). */
  quit: () => Promise<void>;
  /** Borra la raíz de datos y el userData de Electron. */
  cleanup: () => void;
}

export function newDataDir(): string {
  // Dentro del repo (ruta no ASCII), a propósito: cada E2E ejerce también ese riesgo (R1).
  const dataDir = join(ROOT, 'tests', '.tmp', 'e2e', randomUUID());
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/** Entorno de la app: el del proceso sin las variables de electron-vite, más las de E2E. */
export function appEnv(
  dataDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE')
      env[k] = v;
  }
  env.GALERIA_E2E = '1';
  env.GALERIA_DATA_DIR = dataDir;
  // Argon2 de 8 MiB / t=1 (solo sin empaquetar, §23.2).
  env.GALERIA_TEST_FAST_KDF = '1';
  return { ...env, ...extra };
}

/** Ruta del ejecutable de Electron de node_modules (para lanzar instancias sin Playwright). */
export function electronExecutable(): string {
  const rel = readFileSync(join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  return join(ROOT, 'node_modules', 'electron', 'dist', rel);
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const dataDir = options.dataDir ?? newDataDir();
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env: appEnv(dataDir, options.env) });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const cleanup = (): void => {
    for (const dir of [dataDir, `${dataDir}.electron`]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  const quit = async (): Promise<void> => {
    await app.close();
  };
  const close = async (): Promise<void> => {
    await quit();
    cleanup();
  };
  return { app, page, dataDir, close, quit, cleanup };
}

/** PID del proceso de renderer de la ventana actual (la que recibe el IPC, §13.3). */
export async function rendererPid(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    // La ventana actual es la más reciente (bloquear crea otra y destruye la antigua).
    const win = BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .sort((a, b) => b.id - a.id)[0];
    return win ? win.webContents.getOSProcessId() : -1;
  });
}

/**
 * Bloquea con `trigger` y devuelve la ventana nueva (§13.3: bloquear sustituye la ventana por otra
 * con un proceso de renderer nuevo), ya con el selector cargado.
 */
export async function lockAndGetNewWindow(
  app: ElectronApplication,
  trigger: () => Promise<unknown>,
): Promise<Page> {
  const next = app.waitForEvent('window', { timeout: 15_000 });
  await trigger();
  const page = await next;
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { level: 1, name: /¿Quién eres\?|Galería/ })).toBeVisible({
    timeout: 15_000,
  });
  return page;
}

/** Abre el formulario de crear desde la bienvenida o desde el selector. */
export async function openCreateProfile(page: Page): Promise<void> {
  const welcome = page.getByRole('button', { name: 'Crear perfil', exact: true });
  const add = page.getByRole('button', { name: 'Añadir perfil', exact: true });
  await expect(welcome.or(add).first()).toBeVisible();
  if (await welcome.isVisible()) await welcome.click();
  else await add.first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Crear perfil' })).toBeVisible();
}

/**
 * fill() y comprueba que el campo tiene el valor. En una ejecución completa, "Crear perfil" se quedó
 * deshabilitado tras los tres fill() de createProfile, sin repetirse en 45 ejecuciones del mismo test
 * (25 con la CPU al 100 %): si un valor no llega, se vuelve a escribir y queda en la salida
 * (docs/PLAN.md, nota 83).
 */
async function fillChecked(field: Locator, value: string): Promise<void> {
  let attempts = 0;
  await expect(async () => {
    attempts += 1;
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  if (attempts > 1) console.log(`[e2e] fill: ${attempts} intentos`);
}

/** Crea un perfil por la interfaz y espera a volver al selector con el foco en su avatar. */
export async function createProfile(page: Page, name: string, password: string): Promise<void> {
  await openCreateProfile(page);
  await fillChecked(page.getByLabel('Nombre', { exact: true }), name);
  await fillChecked(page.getByLabel('Contraseña', { exact: true }), password);
  await fillChecked(page.getByLabel('Repetir contraseña', { exact: true }), password);
  await page
    .getByRole('checkbox', {
      name: 'Entiendo que si olvido la contraseña perderé el acceso para siempre',
    })
    .check();
  const submit = page.getByRole('button', { name: 'Crear perfil', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('heading', { level: 1, name: '¿Quién eres?' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
}

/** Abre el desbloqueo del perfil y entra con la contraseña. */
export async function unlockProfile(page: Page, name: string, password: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Contraseña', { exact: true }).fill(password);
  await dialog.getByLabel('Contraseña', { exact: true }).press('Enter');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Elige el tema global en la paleta del selector (§14.2). Radix cierra un menú abierto cuando la
 * ventana pierde el foco del sistema (`blur`), y en un escritorio real otra ventana puede quitárselo
 * en cualquier momento: si el menú se cierra antes del clic, se vuelve a abrir (docs/PLAN.md,
 * nota 81). Con más de un intento lo deja en la salida del test.
 */
export async function choosePickerTheme(page: Page, displayName: string): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Cambiar tema' });
  const item = page.getByRole('menuitemradio', { name: displayName });
  let attempts = 0;
  await expect(async () => {
    attempts += 1;
    if (!(await item.isVisible())) await trigger.click();
    await item.click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  if (attempts > 1) {
    const focused = await page.evaluate(() => document.hasFocus());
    console.log(`[e2e] paleta: ${attempts} intentos (document.hasFocus() = ${focused})`);
  }
}

/** profiles.json en claro (nombres e ids; nunca claves). */
export function readProfilesJson(dataDir: string): { profiles: { id: string; name: string }[] } {
  return JSON.parse(readFileSync(join(dataDir, 'profiles.json'), 'utf8')) as {
    profiles: { id: string; name: string }[];
  };
}
