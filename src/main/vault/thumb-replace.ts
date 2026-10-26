// Pasos 2–6 de docs/DESIGN.md §16.5: rehacer la miniatura de un medio con un objeto NUEVO. Lo usan
// edits:save (ipc/handlers/edits.ts), la cola de regeneración de la reconciliación (§12.6 punto 3)
// y la sustitución de un duplicado con ediciones (§12.7 punto 3, si las ediciones cambiaron entre
// el paso 4 de la importación y la transacción B).
//
//   2. descifrar el original en memoria (readAll; si no descifra → INTEGRITY);
//   3. renderizar las ediciones con sharp (edits-render.ts; si falla → INTERNAL);
//   4. cifrar la miniatura en tmp/<thumbId>.part (finish = fsync), registrar thumbId en inFlight y
//      renombrarla a thumbs/<aa>/<thumbId> ANTES de la transacción;
//   5. transacción del llamador (`commit`); si falla o ya no aplica, borrado criptográfico de la
//      miniatura nueva y salida de inFlight;
//   6. tras el COMMIT, salida de inFlight y borrado criptográfico de la miniatura antigua.
//
// Nunca se reescribe el objeto original: solo se lee. Nada descifrado toca el disco: el original y
// el WebP viven en memoria y se ponen a cero al terminar. Sesión [H3-6]: la DB, las claves y la
// carpeta se piden con la época del llamador. Tras un bloqueo (señal abortada) no se ejecuta
// ninguna sentencia ni se toca thumbs/: el .part se borra por KeylessCleanup y una miniatura ya
// renombrada pero sin COMMIT la borra el barrido de huérfanos del desbloqueo siguiente (§12.6
// punto 7; ya no está en inFlight). En todos los casos de fallo se borra el .part y las ediciones
// guardadas no cambian.
import { randomBytes } from 'node:crypto';
import { AppErrorException } from '@shared/errors';
import type { EditState } from '@shared/edits';
import type { Id } from '@shared/types';
import { KIND_MEDIA, KIND_THUMB } from '../crypto/file-format';
import type { ObjectReader } from '../crypto/object-reader';
import type { Db } from '../db/database';
import { log } from '../log';
import { renderEdits } from '../media/edits-render';
import type { SessionManager } from '../session/session-manager';
import type { InFlight } from './in-flight';
import { ObjectStore } from './object-store';

export type ThumbReplaceSession = Pick<
  SessionManager,
  'getDb' | 'getKeyRing' | 'getVaultDir' | 'registerReader' | 'registerWriter' | 'cleanup'
>;

/** Puntos de prueba (solo tests): se llaman al EMPEZAR cada paso y pueden esperar o lanzar. */
export type ThumbReplaceStep = 'decrypt' | 'render' | 'write' | 'promote' | 'commit' | 'erase-old';

export interface ThumbReplaceDeps {
  session: ThumbReplaceSession;
  /** Un único conjunto por proceso (index.ts). */
  inFlight: InFlight;
  /** Paso 3 (inyectable en los tests). */
  render?: (buffer: Buffer, state: EditState) => Promise<Buffer>;
  /** Solo tests. */
  onStep?: (step: ThumbReplaceStep) => void | Promise<void>;
}

export interface ThumbReplaceRequest<T> {
  epoch: number;
  mediaId: Id;
  /** Señal del trabajo o de la sesión: se aborta al bloquear. */
  signal: AbortSignal;
  /** Foto: las ediciones a aplicar (pasos 2–3 por defecto). */
  state?: EditState;
  /** Otra fuente de la miniatura (vídeo: el fotograma por loopback). Sustituye a los pasos 2–3. */
  produce?: () => Promise<Buffer>;
  /**
   * Paso 5: la transacción con el thumbId nuevo. Devuelve la miniatura anterior (o null) y el
   * valor para el llamador, o null si ya no aplica (no ha cambiado nada).
   */
  commit(db: Db, thumbId: Id): { oldThumbId: Id | null; value: T } | null;
}

const locked = (): AppErrorException => new AppErrorException({ code: 'LOCKED' });

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

function isLockedError(err: unknown): boolean {
  return err instanceof AppErrorException && err.error.code === 'LOCKED';
}

/** E/S y DB fuera de los códigos propios de §16.5 → DISK_FULL o IO. */
function ioError(err: unknown, stage: string, mediaId: Id): AppErrorException {
  if (err instanceof AppErrorException) return err;
  const errno = errnoOf(err);
  if (errno === 'ENOSPC' || errno === 'SQLITE_FULL') {
    log.warn('edit.failed', { mediaId, code: 'DISK_FULL', stage, errno });
    return new AppErrorException({ code: 'DISK_FULL' });
  }
  log.error('edit.failed', { mediaId, code: 'IO', stage, errno });
  return new AppErrorException({ code: 'IO' });
}

/** Paso 2: el original descifrado entero (fotos ≤ 256 MiB), verificando cada tag. */
async function decryptOriginal(
  session: ThumbReplaceSession,
  store: ObjectStore,
  epoch: number,
  mediaId: Id,
  signal: AbortSignal,
): Promise<Buffer> {
  const keys = session.getKeyRing(epoch);
  let reader: ObjectReader;
  try {
    reader = await store.open(mediaId, KIND_MEDIA, keys.kWrap, keys.dekCache);
  } catch (err) {
    throw decryptError(err, signal, mediaId);
  }
  let unregister: () => void = () => undefined;
  try {
    unregister = session.registerReader(reader, epoch);
    return await reader.readAll();
  } catch (err) {
    throw decryptError(err, signal, mediaId);
  } finally {
    unregister();
    await reader.close();
  }
}

/** §16.5: el original no descifra (dañado o ausente) → INTEGRITY con warn; un bloqueo → LOCKED. */
function decryptError(err: unknown, signal: AbortSignal, mediaId: Id): AppErrorException {
  if (signal.aborted || isLockedError(err)) return locked();
  if (err instanceof AppErrorException) {
    const code = err.error.code;
    if (code === 'INTEGRITY' || code === 'NOT_FOUND') {
      log.warn('edit.failed', { mediaId, code: 'INTEGRITY', stage: 'decrypt' });
      return new AppErrorException({ code: 'INTEGRITY' });
    }
  }
  return ioError(err, 'decrypt', mediaId);
}

/**
 * Pasos 2–6 de §16.5. Devuelve el valor del `commit`, o null si el commit ya no aplicaba (la
 * miniatura nueva se borra). Errores: INTEGRITY, INTERNAL, LOCKED, DISK_FULL, IO.
 */
export async function replaceThumb<T>(
  deps: ThumbReplaceDeps,
  req: ThumbReplaceRequest<T>,
): Promise<T | null> {
  const { session, inFlight } = deps;
  const { epoch, mediaId, signal } = req;
  const step = async (s: ThumbReplaceStep): Promise<void> => {
    await deps.onStep?.(s);
    if (signal.aborted) throw locked();
  };
  if (signal.aborted) throw locked();
  const store = new ObjectStore(session.getVaultDir(epoch));

  // 2–3. Miniatura en memoria.
  let webp: Buffer;
  if (req.produce) {
    webp = await req.produce();
  } else {
    if (!req.state) throw new RangeError('state o produce');
    await step('decrypt');
    const original = await decryptOriginal(session, store, epoch, mediaId, signal);
    try {
      await step('render');
      try {
        webp = await (deps.render ?? renderEdits)(original, req.state);
      } catch (err) {
        if (signal.aborted) throw locked();
        if (isLockedError(err)) throw err;
        log.warn('edit.failed', { mediaId, code: 'INTERNAL', stage: 'render' });
        throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'render' } });
      }
    } finally {
      original.fill(0); // píxeles descifrados: fuera de la memoria en cuanto hay miniatura
    }
  }

  // 4. Objeto miniatura nuevo en tmp/<thumbId>.part (fsync en finish()).
  const thumbId = randomBytes(16).toString('hex');
  const partPath = store.partPath(thumbId);
  try {
    await step('write');
    const keys = session.getKeyRing(epoch);
    const writer = store.createWriter({ id: thumbId, kind: KIND_THUMB, kWrap: keys.kWrap, signal });
    let unregister: () => void = () => undefined;
    try {
      unregister = session.registerWriter(writer, partPath, epoch);
      await writer.write(webp);
      await writer.finish();
    } catch (err) {
      await writer.abort(); // nunca lanza: borra el .part sin terminar
      throw err;
    } finally {
      unregister();
    }
  } catch (err) {
    if (signal.aborted || isLockedError(err)) throw locked();
    throw ioError(err, 'write', mediaId);
  } finally {
    webp.fill(0);
  }

  // 4 (sigue). inFlight antes del renombrado; el renombrado, antes de la transacción.
  const release = inFlight.track(thumbId);
  try {
    try {
      await step('promote');
      await store.promote(thumbId, KIND_THUMB);
    } catch (err) {
      if (signal.aborted || isLockedError(err)) {
        // [H3-6] Sin tocar thumbs/: el .part (si sigue ahí) se borra sin claves.
        await session.cleanup.run(partPath, async () => {
          await store.erasePart(thumbId);
        });
        throw locked();
      }
      await store.erasePart(thumbId);
      throw ioError(err, 'promote', mediaId);
    }

    // 5. Transacción del llamador.
    let committed: { oldThumbId: Id | null; value: T } | null;
    try {
      await step('commit');
      committed = req.commit(session.getDb(epoch), thumbId);
    } catch (err) {
      // Tras un bloqueo no se toca thumbs/: la miniatura nueva (ya sin inFlight) la borra el
      // barrido de huérfanos del desbloqueo siguiente (§12.6 punto 7).
      if (signal.aborted || isLockedError(err)) throw locked();
      await store.eraseObject(thumbId, KIND_THUMB);
      throw ioError(err, 'commit', mediaId);
    }
    if (!committed) {
      if (!signal.aborted) await store.eraseObject(thumbId, KIND_THUMB);
      return null;
    }

    // 6. Tras el COMMIT: salida de inFlight y borrado criptográfico de la antigua (nunca lanza).
    release();
    if (committed.oldThumbId && committed.oldThumbId !== thumbId) {
      await deps.onStep?.('erase-old');
      // Tras un bloqueo, la antigua (ya sin referencia) la borra el barrido [H3-6].
      if (!signal.aborted) await store.eraseObject(committed.oldThumbId, KIND_THUMB);
    }
    return committed.value;
  } finally {
    release();
  }
}
