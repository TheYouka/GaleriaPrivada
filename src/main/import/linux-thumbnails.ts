// Linux: miniaturas freedesktop del original borrado (docs/DESIGN.md §12.9). Solo en Linux y solo
// después de borrar el original; best-effort (los errores se ignoran con `debug`).
//
// 1. uri = 'file://' + la ruta absoluta escapada con la regla de g_filename_to_uri de GLib
//    (g_escape_uri_string con la máscara UNSAFE_PATH de glib/gconvert.c): UTF-8 y `%XX` en
//    mayúsculas para todo byte fuera de `A–Z a–z 0–9 - . _ ~ ! $ & ' ( ) * + , = : @ /`.
//    Los vectores fijados con GLib llegan en 7.4 (anexo §5); en F2 son it.todo.
// 2. md5 = MD5(uri) en hex.
// 3. Para `${XDG_CACHE_HOME:-~/.cache}/thumbnails` y la carpeta antigua `~/.thumbnails`: se borra
//    `<base>/{normal,large,x-large,xx-large}/<md5>.png` y `<base>/fail/*/<md5>.png`, con
//    sobrescritura best-effort (sin seguir enlaces).
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { log } from '../log';

export const THUMBNAIL_SIZES = ['normal', 'large', 'x-large', 'xx-large'] as const;

/** Bytes que g_filename_to_uri deja sin escapar en una ruta. */
const SAFE = new Set(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,=:@/"].map((c) =>
    c.charCodeAt(0),
  ),
);

/** `file://` + ruta absoluta escapada como g_filename_to_uri(path, NULL). */
export function fileUri(absPath: string): string {
  let out = 'file://';
  for (const byte of Buffer.from(absPath, 'utf8')) {
    out += SAFE.has(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function thumbnailName(uri: string): string {
  return `${createHash('md5').update(uri, 'utf8').digest('hex')}.png`;
}

export interface FreedesktopEnv {
  home?: string;
  /** XDG_CACHE_HOME (solo si es absoluta, como en la especificación XDG). */
  xdgCacheHome?: string;
}

/** Las dos bases: `${XDG_CACHE_HOME:-~/.cache}/thumbnails` y `~/.thumbnails`. */
export function thumbnailBases(env: FreedesktopEnv = {}): string[] {
  const home = env.home ?? homedir();
  const xdg = env.xdgCacheHome ?? process.env.XDG_CACHE_HOME;
  const cache = xdg && isAbsolute(xdg) ? xdg : join(home, '.cache');
  return [join(cache, 'thumbnails'), join(home, '.thumbnails')];
}

/** Sobrescritura best-effort (ceros, fsync) y unlink, sin seguir enlaces. */
async function eraseFile(path: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return false; // no existe: lo normal
  }
  if (!st.isFile() || st.isSymbolicLink()) return false;
  try {
    const nofollow = process.platform === 'linux' ? fsConstants.O_NOFOLLOW : 0;
    const fh = await open(path, fsConstants.O_RDWR | nofollow);
    try {
      if (st.nlink === 1 && st.size > 0) {
        await fh.write(Buffer.alloc(st.size), 0, st.size, 0);
        await fh.sync();
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch {
    // best-effort: se borra igual
  }
  try {
    await unlink(path);
    return true;
  } catch {
    log.debug('import.linux-cleanup', { stage: 'thumbnail-unlink' });
    return false;
  }
}

export interface ThumbnailCleanupOptions extends FreedesktopEnv {
  /** Por defecto process.platform; fuera de Linux no hace nada. */
  platform?: NodeJS.Platform;
}

/** Borra las miniaturas freedesktop del original borrado. Devuelve cuántas borró; nunca lanza. */
export async function cleanupThumbnails(
  absPath: string,
  opts: ThumbnailCleanupOptions = {},
): Promise<number> {
  if ((opts.platform ?? process.platform) !== 'linux') return 0;
  const name = thumbnailName(fileUri(absPath));
  let removed = 0;
  for (const base of thumbnailBases(opts)) {
    const candidates = THUMBNAIL_SIZES.map((size) => join(base, size, name));
    try {
      for (const app of await readdir(join(base, 'fail'))) {
        candidates.push(join(base, 'fail', app, name));
      }
    } catch {
      // sin carpeta fail/
    }
    for (const candidate of candidates) {
      if (await eraseFile(candidate)) removed += 1;
    }
  }
  return removed;
}
