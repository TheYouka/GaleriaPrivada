// Comprobar y borrar el original (docs/DESIGN.md §12.4 pasos 8 y 9). Solo se llama después de que la
// copia cifrada está verificada, renombrada a su sitio y confirmada en la DB (paso 7), y nunca tras
// un bloqueo ni una cancelación.
//
// Paso 8: open(p, O_RDWR | O_NOFOLLOW en Linux) y fstat(fd, { bigint: true }) SOBRE EL DESCRIPTOR,
// así lo comprobado es exactamente lo que se va a sobrescribir; { dev, ino, size, mtimeNs } tiene
// que coincidir exactamente con el snapshot del escaneo. Si no coincide (o el archivo ya no está, o
// es un enlace): se cierra sin tocar nada → CHANGED_DURING_IMPORT. Sin permiso de escritura
// (EPERM/EACCES/EROFS): lstat(p, { bigint: true }), la misma comparación y directamente el unlink.
// En Windows no hay O_NOFOLLOW: si la ruta pasó a ser un enlace, el fstat del destino no coincide
// con el snapshot (tomado con lstat del archivo regular) y tampoco se toca.
//
// Paso 9: con nlink > 1 (enlace duro) no se sobrescribe, porque los ceros llegarían a los otros
// nombres, que no forman parte de la importación: solo unlink y `warn` import.original.hardlink.
// Caso normal: ceros en bloques de 1 MiB por el mismo descriptor, fsync, ftruncate(0), fsync,
// cerrar y unlink. Justo antes del unlink se repite un lstat y se exige el mismo { dev, ino }: nunca
// se borra un archivo que no sea el comprobado. Si el unlink falla → `failed` (originalsNotDeleted
// { reason: 'IO' }) y `warn` sin la ruta.
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { log } from '../log';
import { sameSnapshot, snapshotOf, type Snapshot } from './walk';

export const ZERO_BLOCK_BYTES = 1024 * 1024;

export type SecureDeleteResult =
  /** `overwritten`: ceros + truncado; `hardlink`: solo unlink; `unlink-only`: sin permiso de escritura. */
  | { outcome: 'deleted'; mode: 'overwritten' | 'hardlink' | 'unlink-only' }
  /** CHANGED_DURING_IMPORT: el original no se ha tocado. */
  | { outcome: 'changed' }
  /** No se pudo borrar (originalsNotDeleted { reason: 'IO' }). */
  | { outcome: 'failed' };

/** Subconjunto de FileHandle que usa este módulo. */
export type DeleteFileHandle = Pick<FileHandle, 'stat' | 'write' | 'sync' | 'truncate' | 'close'>;

/** E/S inyectable (solo tests). */
export interface SecureDeleteIo {
  open(path: string, flags: number): Promise<DeleteFileHandle>;
  lstat(path: string): Promise<BigIntStats>;
  unlink(path: string): Promise<void>;
}

const linux = process.platform === 'linux';

export const defaultSecureDeleteIo: SecureDeleteIo = {
  open: (p, flags) => open(p, flags),
  lstat: (p) => lstat(p, { bigint: true }),
  unlink: (p) => unlink(p),
};

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

const NO_WRITE_ACCESS: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EROFS']);

async function closeQuietly(fh: DeleteFileHandle): Promise<void> {
  await fh.close().catch(() => undefined);
}

/** unlink solo si la ruta sigue siendo el mismo archivo regular ({ dev, ino }). */
async function unlinkIfSame(
  io: SecureDeleteIo,
  path: string,
  expected: Snapshot,
  mode: 'overwritten' | 'hardlink' | 'unlink-only',
): Promise<SecureDeleteResult> {
  let st: BigIntStats;
  try {
    st = await io.lstat(path);
  } catch (err) {
    log.warn('import.original.unlink-failed', { errno: errnoOf(err), stage: 'lstat' });
    return { outcome: 'failed' };
  }
  if (st.isSymbolicLink() || !st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino) {
    log.warn('import.original.changed', { stage: 'before-unlink' });
    return { outcome: 'changed' };
  }
  try {
    await io.unlink(path);
  } catch (err) {
    log.warn('import.original.unlink-failed', { errno: errnoOf(err), stage: 'unlink' });
    return { outcome: 'failed' };
  }
  return { outcome: 'deleted', mode };
}

async function overwriteWithZeros(fh: DeleteFileHandle, size: number): Promise<void> {
  const zeros = Buffer.alloc(Math.min(ZERO_BLOCK_BYTES, Math.max(size, 1)));
  let pos = 0;
  while (pos < size) {
    const n = Math.min(zeros.length, size - pos);
    const { bytesWritten } = await fh.write(zeros, 0, n, pos);
    if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    pos += bytesWritten;
  }
  await fh.sync();
  await fh.truncate(0);
  await fh.sync();
}

/**
 * Pasos 8 y 9 sobre el original `path` (la ruta tal cual llegó [H3-3]) con su `snapshot` del
 * escaneo. Nunca lanza.
 */
export async function secureDeleteOriginal(
  path: string,
  snapshot: Snapshot,
  io: SecureDeleteIo = defaultSecureDeleteIo,
): Promise<SecureDeleteResult> {
  let fh: DeleteFileHandle;
  try {
    fh = await io.open(path, fsConstants.O_RDWR | (linux ? fsConstants.O_NOFOLLOW : 0));
  } catch (err) {
    const errno = errnoOf(err);
    if (errno && NO_WRITE_ACCESS.has(errno)) {
      // Sin permiso de escritura: comparar con lstat y pasar directamente al unlink.
      let st: BigIntStats;
      try {
        st = await io.lstat(path);
      } catch {
        return { outcome: 'changed' };
      }
      if (st.isSymbolicLink() || !st.isFile() || !sameSnapshot(snapshotOf(st), snapshot)) {
        log.warn('import.original.changed', { stage: 'lstat' });
        return { outcome: 'changed' };
      }
      return unlinkIfSame(io, path, snapshot, 'unlink-only');
    }
    if (errno === 'ENOENT' || errno === 'ELOOP' || errno === 'EISDIR' || errno === 'ENOTDIR') {
      // Ya no está, o es un enlace (O_NOFOLLOW) o una carpeta: no es el archivo del escaneo.
      log.warn('import.original.changed', { errno, stage: 'open' });
      return { outcome: 'changed' };
    }
    log.warn('import.original.unlink-failed', { errno, stage: 'open' });
    return { outcome: 'failed' };
  }

  let hardlink = false;
  try {
    let st: BigIntStats;
    try {
      st = await fh.stat({ bigint: true });
    } catch (err) {
      log.warn('import.original.unlink-failed', { errno: errnoOf(err), stage: 'fstat' });
      return { outcome: 'failed' };
    }
    if (!st.isFile() || !sameSnapshot(snapshotOf(st), snapshot)) {
      log.warn('import.original.changed', { stage: 'fstat' });
      return { outcome: 'changed' };
    }
    if (st.nlink > 1n) {
      hardlink = true;
    } else {
      try {
        await overwriteWithZeros(fh, Number(st.size));
      } catch (err) {
        // La copia ya está a salvo en la bóveda: se borra igual.
        log.warn('import.original.overwrite-failed', { errno: errnoOf(err) });
      }
    }
  } finally {
    await closeQuietly(fh);
  }

  if (hardlink) {
    log.warn('import.original.hardlink');
    return unlinkIfSame(io, path, snapshot, 'hardlink');
  }
  return unlinkIfSame(io, path, snapshot, 'overwritten');
}
