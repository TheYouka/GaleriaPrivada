// Rutas base (docs/DESIGN.md §8.1). Las carpetas son ASCII ("Galeria") aunque productName sea
// "Galería", para no añadir otro carácter no ASCII a rutas que ya lo tienen.
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  /** Raíz de datos GaleriaData (perfiles, ajustes, bóvedas). */
  dataRoot: string;
  /** userData de Chromium. */
  userData: string;
  /** true si viene de GALERIA_DATA_DIR. */
  overridden: boolean;
}

let current: AppPaths | null = null;

function absoluteEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : undefined;
}

export function resolveAppPaths(): AppPaths {
  // Override para Vitest y Playwright: userData es una carpeta hermana con sufijo, así dos raíces
  // de prueba de la misma carpeta padre no comparten userData ni el lock de instancia única.
  // Si no es absoluta se ignora (F1: log.warn).
  const override = absoluteEnv('GALERIA_DATA_DIR');
  if (override) {
    const dataRoot = resolve(override);
    return { dataRoot, userData: `${dataRoot}.electron`, overridden: true };
  }
  const home = app.getPath('home');
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return {
      dataRoot: join(local, 'Galeria', 'GaleriaData'),
      userData: join(local, 'Galeria', 'electron'),
      overridden: false,
    };
  }
  const configHome = absoluteEnv('XDG_CONFIG_HOME') ?? join(home, '.config');
  const dataHome = absoluteEnv('XDG_DATA_HOME') ?? join(home, '.local', 'share');
  return {
    dataRoot: join(dataHome, 'Galeria', 'GaleriaData'),
    userData: join(configHome, 'Galeria', 'electron'),
    overridden: false,
  };
}

/** Paso 3 del arranque (§5.2): fija userData antes de pedir el lock de instancia única. */
export function initAppPaths(): AppPaths {
  const paths = resolveAppPaths();
  mkdirSync(paths.dataRoot, { recursive: true });
  app.setPath('userData', paths.userData);
  current = paths;
  return paths;
}

export function getAppPaths(): AppPaths {
  if (!current) throw new Error('initAppPaths() no se ha llamado');
  return current;
}
