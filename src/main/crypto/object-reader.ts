// Lector de objetos cifrados con acceso aleatorio (docs/DESIGN.md §7.4, §7.5 y §7.7).
//
// openObject() valida la cabecera, el fileId y el kind esperados, el tamaño L con fstat y
// desenvuelve la DEK (que autentica la cabecera entera). createReadStream(a, b) lee solo los chunks
// i0..i1 y verifica el tag de cada uno antes de entregar ningún byte suyo. destroyKeys() es
// síncrono: pone a cero la DEK propia y las lecturas pendientes fallan con LOCKED.
//
// Errores: ENOENT → NOT_FOUND; la validación → INTEGRITY; el resto → IO.
import { createDecipheriv } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import { PHOTO_MAX_BYTES } from '@shared/constants';
import {
  CHUNK,
  DEK_LEN,
  FILE_ID_LEN,
  HEADER_AAD_LEN,
  HEADER_LEN,
  TAG,
  chunkAad,
  chunkCount,
  chunkLen,
  chunkNonce,
  chunkOffset,
  decodeHeader,
  fileLength,
  type ObjectHeader,
  type ObjectKind,
} from './file-format';
import { AUTH_TAG_LENGTH, GCM, unwrapDek, type DekCache } from './keys';
import { KEY_LEN, zeroize } from './secure-buffer';

/** readAll() solo para fotos (≤ 256 MiB) y miniaturas. */
export const READ_ALL_MAX = PHOTO_MAX_BYTES;

export interface ObjectReader {
  readonly plaintextSize: number;
  /** Verifica chunk a chunk; nunca entrega bytes de un chunk sin haber validado su tag. */
  createReadStream(start: number, endInclusive: number): Readable;
  readAll(): Promise<Buffer>;
  /** Síncrono: pone a cero su DEK; las lecturas pendientes fallan con LOCKED. */
  destroyKeys(): void;
  close(): Promise<void>;
}

/** Subconjunto de FileHandle que usa el lector (inyectable en los tests). */
export interface ReaderFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

export interface ReaderIo {
  open(path: string): Promise<ReaderFileHandle>;
}

export const defaultReaderIo: ReaderIo = {
  open: (path) => open(path, 'r'),
};

function appError(code: ErrorCode, reason?: string): AppErrorException {
  return new AppErrorException(reason ? { code, details: { reason } } : { code });
}

function mapError(err: unknown): AppErrorException {
  if (err instanceof AppErrorException) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return appError(code === 'ENOENT' ? 'NOT_FOUND' : 'IO');
}

/** Lee hasta llenar `buf` o llegar al final del archivo; devuelve los bytes leídos. */
async function readFully(fh: ReaderFileHandle, buf: Buffer, position: number): Promise<number> {
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, position + done);
    if (bytesRead <= 0) break;
    done += bytesRead;
  }
  return done;
}

class Reader implements ObjectReader {
  readonly plaintextSize: number;
  private dek: Buffer | null;
  private fhClosed = false;
  private readonly n: number;
  private readonly streams = new Set<Readable>();

  constructor(
    private readonly fh: ReaderFileHandle,
    private readonly header: ObjectHeader,
    dek: Buffer,
  ) {
    this.plaintextSize = header.plaintextSize;
    this.n = chunkCount(header.plaintextSize);
    this.dek = dek;
  }

  private liveDek(): Buffer {
    if (!this.dek) throw appError('LOCKED');
    return this.dek;
  }

  /** Lee y verifica el chunk i. El plaintext solo sale si el tag valida. */
  private async decryptChunk(i: number): Promise<Buffer> {
    this.liveDek();
    const len = chunkLen(this.plaintextSize, i);
    const buf = Buffer.alloc(len + TAG);
    let got: number;
    try {
      got = await readFully(this.fh, buf, chunkOffset(i));
    } catch (err) {
      this.liveDek(); // si se bloqueó mientras tanto, LOCKED antes que IO
      throw mapError(err);
    }
    const dek = this.liveDek();
    if (got !== buf.length) throw appError('INTEGRITY', 'short-read');
    const decipher = createDecipheriv(GCM, dek, chunkNonce(this.header.nonceBase, i), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAAD(chunkAad(this.header.fileId, i, i === this.n - 1));
    decipher.setAuthTag(buf.subarray(len));
    const plain = decipher.update(buf.subarray(0, len));
    try {
      decipher.final();
    } catch {
      zeroize(plain);
      throw appError('INTEGRITY', 'chunk');
    }
    return plain;
  }

  createReadStream(start: number, endInclusive: number): Readable {
    const p = this.plaintextSize;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start ||
      endInclusive >= p
    ) {
      throw new RangeError('rango fuera de [0, P)');
    }
    const i0 = Math.floor(start / CHUNK);
    const i1 = Math.floor(endInclusive / CHUNK);
    let next = i0;
    const stream: Readable = new Readable({
      highWaterMark: CHUNK,
      read: () => {
        const i = next;
        if (i > i1) {
          stream.push(null);
          return;
        }
        next += 1;
        this.decryptChunk(i).then(
          (plain) => {
            if (stream.destroyed) return;
            // Recorte inicial (solo i0) y final (solo i1, inclusivo) de §7.5.
            const from = i === i0 ? start - i * CHUNK : 0;
            const to = i === i1 ? endInclusive - i * CHUNK + 1 : plain.length;
            // El final del stream lo marca la siguiente llamada a read() (i > i1).
            stream.push(plain.subarray(from, to));
          },
          (err: unknown) => {
            stream.destroy(mapError(err));
          },
        );
      },
      destroy: (err, callback) => {
        this.streams.delete(stream);
        callback(err);
      },
    });
    this.streams.add(stream);
    return stream;
  }

  async readAll(): Promise<Buffer> {
    if (this.plaintextSize > READ_ALL_MAX) throw appError('TOO_LARGE');
    const out = Buffer.alloc(this.plaintextSize);
    for (let i = 0; i < this.n; i += 1) {
      const plain = await this.decryptChunk(i);
      plain.copy(out, i * CHUNK);
    }
    return out;
  }

  destroyKeys(): void {
    zeroize(this.dek);
    this.dek = null;
    for (const s of [...this.streams]) s.destroy(appError('LOCKED'));
    this.streams.clear();
  }

  async close(): Promise<void> {
    this.destroyKeys();
    if (this.fhClosed) return;
    this.fhClosed = true;
    await this.fh.close().catch(() => undefined);
  }
}

/**
 * Abre un objeto cifrado. Con `dekCache`, un acierto (misma cabecera byte a byte) evita volver a
 * desenvolver la DEK; un fallo la desenvuelve y guarda una copia en la caché. El lector siempre
 * tiene su propia copia de la DEK.
 */
export async function openObject(
  path: string,
  expected: { fileId: Buffer; kind: ObjectKind },
  kWrap: Buffer,
  dekCache?: DekCache,
  io: ReaderIo = defaultReaderIo,
): Promise<ObjectReader> {
  if (expected.fileId.length !== FILE_ID_LEN) throw new RangeError('fileId de 16 bytes');
  if (kWrap.length !== KEY_LEN) throw new RangeError('K_wrap de 32 bytes');
  let fh: ReaderFileHandle;
  try {
    fh = await io.open(path);
  } catch (err) {
    throw mapError(err);
  }
  let dek: Buffer | null = null;
  try {
    const headerBytes = Buffer.alloc(HEADER_LEN);
    if ((await readFully(fh, headerBytes, 0)) !== HEADER_LEN) {
      throw appError('INTEGRITY', 'header');
    }
    const header = decodeHeader(headerBytes);
    if (!header.fileId.equals(expected.fileId)) throw appError('INTEGRITY', 'file-id');
    if (header.kind !== expected.kind) throw appError('INTEGRITY', 'kind');
    const { size } = await fh.stat();
    if (size !== fileLength(header.plaintextSize)) throw appError('INTEGRITY', 'size');
    dek = dekCache?.get(header.fileId, headerBytes) ?? null;
    if (!dek) {
      dek = unwrapDek(header, kWrap, headerBytes.subarray(0, HEADER_AAD_LEN));
      if (dekCache) {
        const forCache = Buffer.alloc(DEK_LEN);
        dek.copy(forCache);
        dekCache.set(header.fileId, headerBytes, forCache);
      }
    }
    return new Reader(fh, header, dek);
  } catch (err) {
    zeroize(dek);
    await fh.close().catch(() => undefined);
    throw mapError(err);
  }
}
