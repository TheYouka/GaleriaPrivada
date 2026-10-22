// Lanza la app construida (out/) con el Electron de desarrollo y una raíz de datos temporal propia.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const ROOT = resolve(__dirname, '..', '..', '..');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  close: () => Promise<void>;
}

export async function launchApp(): Promise<LaunchedApp> {
  // Dentro del repo (ruta no ASCII), a propósito: cada E2E ejerce también ese riesgo (R1).
  const dataDir = join(ROOT, 'tests', '.tmp', 'e2e', randomUUID());
  mkdirSync(dataDir, { recursive: true });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE')
      env[k] = v;
  }
  env.GALERIA_E2E = '1';
  env.GALERIA_DATA_DIR = dataDir;

  const app = await electron.launch({ args: ['.'], cwd: ROOT, env });
  const page = await app.firstWindow();
  const close = async (): Promise<void> => {
    await app.close();
    for (const dir of [dataDir, `${dataDir}.electron`]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  return { app, page, dataDir, close };
}
