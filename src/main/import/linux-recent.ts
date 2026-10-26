// Linux: archivos recientes de GTK (docs/DESIGN.md §12.9.1). El selector de GTK (y el del portal)
// añade los archivos elegidos a `${XDG_DATA_HOME:-~/.local/share}/recently-used.xbel`. Al final de
// cada trabajo de importación (agrupado: una lectura y una escritura con todas las URIs borradas),
// solo en Linux y best-effort:
//
// 1. si el archivo no existe o pesa más de 16 MiB, no se hace nada;
// 2. se lee como UTF-8 y se buscan los `<bookmark …>…</bookmark>` con la regex de §12.9.1 (formato
//    de GBookmarkFile), decodificando las entidades XML de `href`;
// 3. se eliminan los que tienen un `href` del conjunto; si no hay ninguno, no se escribe nada;
// 4. escritura atómica (temporal `<archivo>.tmp-<8 hex>` en la misma carpeta + fsync + rename),
//    conservando byte a byte el resto del archivo y su `mode`;
// 5. cualquier error se ignora (`debug`); si no tiene la forma esperada (no empieza por `<?xml`, no
//    contiene `<xbel` o no es UTF-8 válido), no se toca.
import { randomBytes } from 'node:crypto';
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { log } from '../log';

export const RECENT_MAX_BYTES = 16 * 1024 * 1024;
const BOOKMARK = /<bookmark\b[^>]*?\bhref="([^"]*)"[^>]*>[\s\S]*?<\/bookmark>\s*/g;

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e] as string);
}

/** Quita los `<bookmark>` cuyo href (decodificado) está en `uris`; el resto queda intacto. */
export function stripBookmarks(
  xml: string,
  uris: ReadonlySet<string>,
): { text: string; removed: number } {
  let removed = 0;
  const text = xml.replace(BOOKMARK, (whole, href: string) => {
    if (!uris.has(decodeXmlEntities(href))) return whole;
    removed += 1;
    return '';
  });
  return { text, removed };
}

export interface RecentOptions {
  home?: string;
  /** XDG_DATA_HOME (solo si es absoluta). */
  xdgDataHome?: string;
  /** Por defecto process.platform; fuera de Linux no hace nada. */
  platform?: NodeJS.Platform;
}

export function recentFilePath(opts: RecentOptions = {}): string {
  const home = opts.home ?? homedir();
  const xdg = opts.xdgDataHome ?? process.env.XDG_DATA_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return join(base, 'recently-used.xbel');
}

async function writeAtomicKeepingMode(path: string, data: Buffer, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data);
      await fh.chmod(mode & 0o7777).catch(() => chmod(tmp, mode & 0o7777));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    if (process.platform === 'linux') {
      const dir = await open(dirname(path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Quita de recently-used.xbel las URIs (de fileUri, linux-thumbnails.ts) de los originales borrados
 * en el trabajo. Devuelve cuántos elementos quitó; nunca lanza.
 */
export async function removeRecentEntries(
  uris: Iterable<string>,
  opts: RecentOptions = {},
): Promise<number> {
  if ((opts.platform ?? process.platform) !== 'linux') return 0;
  const set = new Set(uris);
  if (set.size === 0) return 0;
  const path = recentFilePath(opts);
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > RECENT_MAX_BYTES) return 0;
    const raw = await readFile(path);
    if (raw.length > RECENT_MAX_BYTES) return 0;
    const text = raw.toString('utf8');
    // UTF-8 inválido no sobrevive a la ida y vuelta: entonces no se toca (byte a byte).
    if (!Buffer.from(text, 'utf8').equals(raw)) return 0;
    if (!text.startsWith('<?xml') || !text.includes('<xbel')) return 0;
    const { text: next, removed } = stripBookmarks(text, set);
    if (removed === 0) return 0;
    await writeAtomicKeepingMode(path, Buffer.from(next, 'utf8'), st.mode);
    return removed;
  } catch {
    log.debug('import.linux-cleanup', { stage: 'recent' });
    return 0;
  }
}
