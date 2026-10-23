// Carpetas temporales de los unitarios: siempre bajo tests/.tmp/ (en .gitignore), dentro de la
// ruta no ASCII del repo, así cada test ejerce también ese riesgo (R1).
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TMP_ROOT = fileURLToPath(new URL('../../.tmp/unit', import.meta.url));

/** Crea tests/.tmp/unit/<area>/<uuid>/ y devuelve la ruta. */
export function makeTmpDir(area: string): string {
  const dir = join(TMP_ROOT, area, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
