// Comparación de rutas con las raíces protegidas (P8, [H3-3], docs/DESIGN.md §12.3 punto 2).
// Protección contra pérdida de datos: la importación borra el original, así que nunca puede tocar
// nada dentro de GaleriaData ni de ninguna carpeta de bóveda conocida.
//
// - Las rutas se usan EXACTAMENTE como llegaron (webUtils.getPathForFile o el diálogo): sin NFC ni
//   trim (rawPath() de ipc/schemas.ts). Una ruta NFD o con un espacio final es otro archivo.
// - El candidato y las raíces se comparan después de fs.realpath.native (resuelve enlaces
//   simbólicos y junctions). Si el realpath del candidato falla, el candidato es `skipped`. Si
//   falla el de una raíz (disco desconectado), se protege su ruta absoluta tal cual.
// - En win32 los dos lados van en minúsculas después de path.win32.normalize (NTFS no distingue
//   mayúsculas), sin el prefijo `\\?\` de las rutas largas.
// - Pertenencia por segmentos, no por prefijos (GaleriaData2 queda fuera de GaleriaData):
//   rel = path.relative(raíz, p); dentro si rel === '' o si su primer segmento no es '..' y no es
//   absoluta. Un hijo llamado "..algo" queda dentro (PLAN.md, nota 94).
// - Rutas de dispositivo (`\\.\`, `\\?\GLOBALROOT`): siempre rechazadas.
import { realpath } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export type GuardVerdict =
  /** Fuera de todas las raíces: se puede importar (y borrar tras verificar). */
  | 'outside'
  /** Dentro de GaleriaData o de una bóveda. */
  | 'inside'
  /** Ruta de dispositivo. */
  | 'device'
  /** realpath falló (no existe, sin permiso, bucle…). */
  | 'unresolved';

export interface GuardOptions {
  platform?: NodeJS.Platform;
  /** Solo tests. */
  realpath?: (p: string) => Promise<string>;
}

const DEVICE_PREFIX = /^[\\/]{2}\.[\\/]/;
const GLOBALROOT_PREFIX = /^[\\/]{2}\?[\\/]globalroot(?:[\\/]|$)/i;
const LONG_UNC_PREFIX = /^[\\/]{2}\?[\\/]unc[\\/]/i;
const LONG_PREFIX = /^[\\/]{2}\?[\\/]/;

/** `\\.\…` y `\\?\GLOBALROOT…` (también con barras normales). Solo tiene sentido en Windows. */
export function isDevicePath(p: string): boolean {
  return DEVICE_PREFIX.test(p) || GLOBALROOT_PREFIX.test(p);
}

/** fs.promises no tiene realpath.native: se usa la versión con callback (GetFinalPathNameByHandle / realpath(3)). */
const realpathNative = promisify(realpath.native);
const nativeRealpath = (p: string): Promise<string> => realpathNative(p);

/** Forma comparable de una ruta ya resuelta. */
export function comparable(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.posix.normalize(p);
  let s = p;
  if (LONG_UNC_PREFIX.test(s)) s = `\\\\${s.slice(8)}`;
  else if (LONG_PREFIX.test(s)) s = s.slice(4);
  return path.win32.normalize(s).toLowerCase();
}

/** true si `p` es `root` o está dentro (por segmentos). Ambas ya en forma comparable. */
export function isWithin(
  root: string,
  p: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const rel = impl.relative(root, p);
  if (rel === '') return true;
  if (impl.isAbsolute(rel)) return false;
  const first = rel.split(impl.sep)[0];
  return first !== '..';
}

/**
 * Raíces protegidas en forma comparable: realpath de cada una; si falla, su ruta absoluta (nunca se
 * pierde una raíz porque su disco no esté).
 */
export async function resolveProtectedRoots(
  roots: readonly string[],
  opts: GuardOptions = {},
): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  const real = opts.realpath ?? nativeRealpath;
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const out = new Set<string>();
  for (const root of roots) {
    out.add(comparable(impl.resolve(root), platform));
    try {
      out.add(comparable(await real(root), platform));
    } catch {
      // disco desconectado o carpeta borrada: queda protegida la ruta tal cual
    }
  }
  return [...out];
}

/**
 * Veredicto para un candidato. `roots` sale de resolveProtectedRoots (GaleriaData y cada vaultDir
 * conocido). La ruta se pasa a realpath exactamente como llegó.
 */
export async function isInsideProtectedRoot(
  p: string,
  roots: readonly string[],
  opts: GuardOptions = {},
): Promise<GuardVerdict> {
  const platform = opts.platform ?? process.platform;
  const real = opts.realpath ?? nativeRealpath;
  if (platform === 'win32' && isDevicePath(p)) return 'device';
  let resolved: string;
  try {
    resolved = await real(p);
  } catch {
    return 'unresolved';
  }
  if (platform === 'win32' && isDevicePath(resolved)) return 'device';
  const candidate = comparable(resolved, platform);
  return roots.some((root) => isWithin(root, candidate, platform)) ? 'inside' : 'outside';
}
