// Escritor de objetos cifrados en streaming (docs/DESIGN.md §7.2, §7.3 y §7.7).
//
// - La DEK es aleatoria y se genera aquí: nunca se acepta como parámetro (§6.4: (DEK, nonce) únicos).
// - El archivo se crea con 'wx' (nunca se reabre ni se sobrescribe un objeto) y los 108 primeros
//   bytes son cero hasta finish(): sin DEK envuelta, el .part es ilegible y basta con unlink.
// - Retiene el último chunk hasta saber si es el final (P = 0 da un chunk final vacío; un múltiplo
//   exacto de 64 KiB no añade un chunk vacío extra).
// - finish(): último chunk con final = 1, cabecera en el offset 0, fsync, close y DEK a cero.
// - destroyKeys() es síncrono (paso 4 de §13.3): DEK a cero y writer muerto (LOCKED); el .part lo
//   borra abort() después. El evento 'abort' de opts.signal llama a destroyKeys().
// - abort() nunca lanza: DEK a cero, close y unlink del .part.
// - ENOSPC → DISK_FULL; otros errores de E/S → IO. En los dos casos se llama a abort().
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import { log } from '../log';
import {
  CHUNK,
  FILE_ID_LEN,
  HEADER_LEN,
  KIND_MEDIA,
  KIND_THUMB,
  MAX_PLAINTEXT,
  NONCE_LEN,
  chunkAad,
  chunkNonce,
  chunkOffset,
  encodeHeader,
  encodeHeaderAad,
  type ObjectKind,
} from './file-format';
import { AUTH_TAG_LENGTH, GCM, wrapDek } from './keys';
import { KEY_LEN, randomOwned, zeroize } from './secure-buffer';

export interface ObjectWriterOptions {
  kind: ObjectKind;
  fileId: Buffer;
  kWrap: Buffer;
  tmpPath: string;
  /** Solo originales: HMAC-SHA256(K_dedup, contenido) para los duplicados (§12.4, paso 1). */
  hmacKey?: Buffer;
  signal?: AbortSignal;
}

export interface ObjectWriterResult {
  plaintextSize: number;
  sha256: Buffer;
  hmac: Buffer | null;
}

export interface ObjectWriter {
  /** Acumula y cifra cada chunk completo; retiene el último hasta saber si es final. */
  write(data: Uint8Array): Promise<void>;
  finish(): Promise<ObjectWriterResult>;
  /** DEK a cero (síncrono) + close + unlink del .part. Nunca lanza. */
  abort(): Promise<void>;
  /** Síncrono: DEK a cero y writer muerto; write()/finish() rechazan con LOCKED. */
  destroyKeys(): void;
}

/** Subconjunto de FileHandle que usa el escritor (inyectable en los tests). */
export interface WriterFileHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface WriterIo {
  /** Crea el archivo; falla si ya existe (escritura única). */
  create(path: string): Promise<WriterFileHandle>;
  unlink(path: string): Promise<void>;
}

export const defaultWriterIo: WriterIo = {
  create: (path) => open(path, 'wx', 0o600),
  unlink: (path) => unlink(path),
};

function appError(code: ErrorCode): AppErrorException {
  return new AppErrorException({ code });
}

function errnoOf(err: unknown): { errno?: string; syscall?: string } {
  const e = err as { code?: unknown; syscall?: unknown } | null;
  return {
    errno: typeof e?.code === 'string' ? e.code : undefined,
    syscall: typeof e?.syscall === 'string' ? e.syscall : undefined,
  };
}

async function writeAll(fh: WriterFileHandle, buf: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buf.length) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, position + done);
    if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    done += bytesWritten;
  }
}

export function createObjectWriter(
  opts: ObjectWriterOptions,
  io: WriterIo = defaultWriterIo,
): ObjectWriter {
  const { kind, fileId, tmpPath } = opts;
  if (kind !== KIND_MEDIA && kind !== KIND_THUMB) throw new RangeError('kind 1 o 2');
  if (fileId.length !== FILE_ID_LEN) throw new RangeError('fileId de 16 bytes');
  if (opts.kWrap.length !== KEY_LEN) throw new RangeError('K_wrap de 32 bytes');

  const dek = randomOwned(KEY_LEN);
  const nonceBase = randomOwned(NONCE_LEN);
  const fileIdCopy = Buffer.from(fileId);
  let kWrap: Buffer | null = opts.kWrap;
  const sha = createHash('sha256');
  const hmac = opts.hmacKey ? createHmac('sha256', opts.hmacKey) : null;

  const pending = Buffer.alloc(CHUNK);
  let pendingLen = 0;
  let index = 0;
  let total = 0;

  let state: 'open' | 'finishing' | 'finished' | 'dead' = 'open';
  let failure: AppErrorException | null = null;
  let created = false;
  let closed = false;
  let abortPromise: Promise<void> | null = null;

  const onAbortSignal = (): void => writer.destroyKeys();
  const detachSignal = (): void => opts.signal?.removeEventListener('abort', onAbortSignal);

  // Crear el .part con los 108 bytes de cabecera a cero. Si falla la escritura de los ceros, el
  // descriptor se cierra aquí (abort() no lo recibe) y abort() borra el .part.
  const ready: Promise<WriterFileHandle> = (async () => {
    const fh = await io.create(tmpPath);
    created = true;
    try {
      await writeAll(fh, Buffer.alloc(HEADER_LEN), 0);
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
    return fh;
  })();
  ready.catch(() => undefined); // el error se entrega en la primera operación

  let queue: Promise<unknown> = ready.catch(() => undefined);

  function deadError(): AppErrorException {
    return failure ?? appError('LOCKED');
  }

  function assertAlive(): void {
    if (state === 'dead') throw deadError();
  }

  /** write()/finish() fuera del estado 'open': muerto → LOCKED (o el fallo); tras finish() → uso indebido. */
  function notOpen(): Promise<never> {
    return Promise.reject(state === 'dead' ? deadError() : appError('INTERNAL'));
  }

  async function emitChunk(fh: WriterFileHandle, final: boolean): Promise<void> {
    assertAlive();
    const cipher = createCipheriv(GCM, dek, chunkNonce(nonceBase, index), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    cipher.setAAD(chunkAad(fileIdCopy, index, final));
    const out = Buffer.concat([
      cipher.update(pending.subarray(0, pendingLen)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const position = chunkOffset(index);
    index += 1;
    pendingLen = 0;
    await writeAll(fh, out, position);
    assertAlive();
  }

  /** Tras un fallo de E/S (o TOO_LARGE): abort() y el error mapeado. LOCKED se entrega tal cual. */
  async function fail(err: unknown): Promise<AppErrorException> {
    if (err instanceof AppErrorException && (err.error.code === 'LOCKED' || err === failure)) {
      return err;
    }
    let mapped: AppErrorException;
    if (err instanceof AppErrorException) {
      mapped = err;
    } else {
      const { errno, syscall } = errnoOf(err);
      mapped = appError(errno === 'ENOSPC' ? 'DISK_FULL' : 'IO');
      log.warn('crypto.writer-failed', { code: mapped.error.code, errno, syscall });
    }
    failure ??= mapped;
    await writer.abort();
    return failure;
  }

  function enqueue<T>(task: (fh: WriterFileHandle) => Promise<T>): Promise<T> {
    const run = queue.then(async () => task(await ready));
    queue = run.catch(() => undefined);
    return run.catch(async (err: unknown) => {
      throw await fail(err);
    });
  }

  const writer: ObjectWriter = {
    write(data) {
      if (state !== 'open') return notOpen();
      const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      return enqueue(async (fh) => {
        assertAlive();
        if (total + chunk.length > MAX_PLAINTEXT) throw appError('TOO_LARGE');
        sha.update(chunk);
        hmac?.update(chunk);
        total += chunk.length;
        let off = 0;
        while (off < chunk.length) {
          // Un chunk lleno solo se cifra cuando llegan más datos: entonces ya se sabe que no es final.
          if (pendingLen === CHUNK) await emitChunk(fh, false);
          const n = Math.min(CHUNK - pendingLen, chunk.length - off);
          chunk.copy(pending, pendingLen, off, off + n);
          pendingLen += n;
          off += n;
        }
      });
    },

    finish() {
      if (state !== 'open') return notOpen();
      state = 'finishing';
      return enqueue(async (fh) => {
        await emitChunk(fh, true);
        const aad = encodeHeaderAad({ kind, plaintextSize: total, fileId: fileIdCopy, nonceBase });
        if (!kWrap) throw deadError();
        const wrapped = wrapDek(dek, kWrap, aad);
        const header = encodeHeader({
          kind,
          plaintextSize: total,
          fileId: fileIdCopy,
          nonceBase,
          ...wrapped,
        });
        assertAlive();
        await writeAll(fh, header, 0);
        await fh.sync();
        assertAlive();
        closed = true;
        await fh.close();
        // destroyKeys() o abort() durante el close: el writer está muerto y finish() no puede
        // devolver éxito (abort() borra el .part en cuanto termina esta tarea).
        if (state === 'dead') {
          zeroize(dek);
          throw deadError();
        }
        state = 'finished';
        zeroize(dek);
        kWrap = null;
        detachSignal();
        return { plaintextSize: total, sha256: sha.digest(), hmac: hmac ? hmac.digest() : null };
      });
    },

    destroyKeys() {
      zeroize(dek);
      kWrap = null;
      if (state !== 'finished') state = 'dead';
      detachSignal();
    },

    abort() {
      if (abortPromise) return abortPromise;
      const finishedBefore = state === 'finished';
      writer.destroyKeys();
      const settled = queue;
      abortPromise = (async () => {
        await settled; // nunca rechaza
        const fh = await ready.catch(() => null);
        if (fh && !closed) {
          closed = true;
          await fh.close().catch(() => undefined);
        }
        // Solo se borra lo que creó este writer, y nunca un objeto ya terminado (12.10).
        if (created && !finishedBefore) await io.unlink(tmpPath).catch(() => undefined);
      })().catch(() => undefined);
      return abortPromise;
    },
  };

  if (opts.signal) {
    if (opts.signal.aborted) writer.destroyKeys();
    else opts.signal.addEventListener('abort', onAbortSignal, { once: true });
  }

  return writer;
}
