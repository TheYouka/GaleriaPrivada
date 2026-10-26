// Object store de una bóveda (docs/DESIGN.md §8.5, §12.4 paso 6 y §12.10).
//
//   tmp/<id>.part          → solo ciphertext en curso (lo crea object-writer con 'wx')
//   objects/<aa>/<mediaId> → originales cifrados
//   thumbs/<aa>/<thumbId>  → miniaturas cifradas
//
// - Rutas solo por id (32 hex, validado): nunca a partir de un nombre o de una ruta recibida.
// - Nunca reabre un objeto para escribir su contenido: los writers solo crean `tmp/<id>.part` con
//   'wx' (object-writer) y promote() se niega a sustituir un objeto que ya existe. La única
//   escritura sobre un objeto existente es el borrado criptográfico, que lo destruye.
// - Borrado criptográfico (§12.10): sobrescribir los 108 bytes de la cabecera con bytes
//   aleatorios, fsync y unlink. Sin la DEK envuelta, el resto es ilegible aunque quede en disco.
//   Los objetos los crea la app con nombres aleatorios: no tienen enlaces duros (sin comprobar
//   nlink). Nunca sigue un enlace: lstat antes y, en Linux, O_NOFOLLOW.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Id } from '@shared/types';
import { HEADER_LEN, KIND_MEDIA, type ObjectKind } from '../crypto/file-format';
import { createObjectWriter, type ObjectWriter } from '../crypto/object-writer';
import { openObject, type ObjectReader } from '../crypto/object-reader';
import type { DekCache } from '../crypto/keys';
import { log } from '../log';
import { objectPath, shardOf, thumbPath, tmpPartPath } from './vault-layout';

/** Reintentos de rename con EPERM/EBUSY (antivirus o indexador en Windows, §12.4 paso 6). */
export const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 100;

/** E/S del borrado criptográfico y del renombrado (inyectable en los tests). */
export interface StoreIo {
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  openForErase(path: string): Promise<Pick<FileHandle, 'write' | 'sync' | 'close'>>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** fsync de un directorio (Linux, tras rename). */
  syncDir(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const linux = process.platform === 'linux';

export const defaultStoreIo: StoreIo = {
  lstat: (p) => lstat(p),
  // r+ sin crear ni truncar; en Linux sin seguir enlaces.
  openForErase: (p) => open(p, fsConstants.O_RDWR | (linux ? fsConstants.O_NOFOLLOW : 0)),
  unlink: (p) => unlink(p),
  rename: (from, to) => rename(from, to),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  syncDir: async (p) => {
    if (!linux) return;
    const fh = await open(p, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

/** fileId de la cabecera = el id del objeto en bytes (§7.2). */
export function fileIdOf(id: Id): Buffer {
  shardOf(id); // valida el formato
  return Buffer.from(id, 'hex');
}

/**
 * 'erased': cabecera destruida y archivo borrado; 'unlinked': borrado, pero la sobrescritura
 * falló (warn); 'missing': no existía; 'failed': el archivo sigue ahí (warn).
 */
export type EraseResult = 'erased' | 'unlinked' | 'missing' | 'failed';

export class ObjectStore {
  constructor(
    readonly vaultDir: string,
    private readonly io: StoreIo = defaultStoreIo,
  ) {}

  objectPath(mediaId: Id): string {
    return objectPath(this.vaultDir, mediaId);
  }

  thumbPath(thumbId: Id): string {
    return thumbPath(this.vaultDir, thumbId);
  }

  partPath(id: Id): string {
    return tmpPartPath(this.vaultDir, id);
  }

  finalPath(id: Id, kind: ObjectKind): string {
    return kind === KIND_MEDIA ? this.objectPath(id) : this.thumbPath(id);
  }

  /** Writer nuevo sobre `tmp/<id>.part` (lo crea con 'wx'; nunca reabre nada). */
  createWriter(opts: {
    id: Id;
    kind: ObjectKind;
    kWrap: Buffer;
    hmacKey?: Buffer;
    signal?: AbortSignal;
  }): ObjectWriter {
    return createObjectWriter({
      kind: opts.kind,
      fileId: fileIdOf(opts.id),
      kWrap: opts.kWrap,
      tmpPath: this.partPath(opts.id),
      hmacKey: opts.hmacKey,
      signal: opts.signal,
    });
  }

  /** Lector del objeto final (o de su .part con `part: true`, para verificar). */
  open(
    id: Id,
    kind: ObjectKind,
    kWrap: Buffer,
    dekCache?: DekCache,
    opts: { part?: boolean } = {},
  ): Promise<ObjectReader> {
    const path = opts.part ? this.partPath(id) : this.finalPath(id, kind);
    return openObject(path, { fileId: fileIdOf(id), kind }, kWrap, dekCache);
  }

  /**
   * `tmp/<id>.part` → `objects|thumbs/<aa>/<id>` (mismo volumen: atómico). Crea la carpeta `aa`
   * bajo demanda, nunca sustituye un objeto existente (INTERNAL `exists`), reintenta EPERM/EBUSY
   * hasta 5 veces y, en Linux, hace fsync de los dos directorios. Devuelve la ruta final.
   */
  async promote(id: Id, kind: ObjectKind): Promise<string> {
    const from = this.partPath(id);
    const to = this.finalPath(id, kind);
    await this.io.mkdir(dirname(to));
    const existing = await this.io.lstat(to).then(
      () => true,
      (err: unknown) => {
        if (errnoOf(err) === 'ENOENT') return false;
        throw err;
      },
    );
    if (existing) throw Object.assign(new Error('object exists'), { code: 'EEXIST' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.io.rename(from, to);
        break;
      } catch (err) {
        const errno = errnoOf(err);
        if ((errno === 'EPERM' || errno === 'EBUSY') && attempt < RENAME_RETRIES) {
          log.debug('object.rename-retry', { errno, count: attempt + 1 });
          await this.io.sleep(RENAME_RETRY_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    await this.io.syncDir(dirname(to));
    await this.io.syncDir(dirname(from));
    return to;
  }

  /** Borrado criptográfico de `objects/<aa>/<id>` o `thumbs/<aa>/<id>`. */
  eraseObject(id: Id, kind: ObjectKind): Promise<EraseResult> {
    return this.cryptoErase(this.finalPath(id, kind));
  }

  /** Borrado criptográfico de `tmp/<id>.part`. */
  erasePart(id: Id): Promise<EraseResult> {
    return this.cryptoErase(this.partPath(id));
  }

  /**
   * §12.10 punto 3: cabecera (108 bytes) con bytes aleatorios, fsync y unlink. Nunca lanza; si el
   * archivo queda ('failed'), la reconciliación lo borrará como huérfano (§12.10 punto 4). Un
   * enlace o algo que no es un archivo no se toca.
   */
  async cryptoErase(path: string): Promise<EraseResult> {
    try {
      const st = await this.io.lstat(path);
      if (st.isSymbolicLink() || !st.isFile()) {
        log.warn('object.erase-failed', { stage: 'not-a-file' });
        return 'failed';
      }
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return 'missing';
      log.warn('object.erase-failed', { errno: errnoOf(err), stage: 'lstat' });
      return 'failed';
    }
    let overwritten = false;
    try {
      const fh = await this.io.openForErase(path);
      try {
        const noise = randomBytes(HEADER_LEN);
        let done = 0;
        while (done < HEADER_LEN) {
          const { bytesWritten } = await fh.write(noise, done, HEADER_LEN - done, done);
          if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
          done += bytesWritten;
        }
        await fh.sync();
        overwritten = true;
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return 'missing';
      log.warn('object.erase-failed', { errno: errnoOf(err), stage: 'overwrite' });
    }
    // Aunque la sobrescritura falle, se borra igual: mejor sin el archivo que con él.
    try {
      await this.io.unlink(path);
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return overwritten ? 'erased' : 'missing';
      log.warn('object.erase-failed', { errno: errnoOf(err), stage: 'unlink' });
      return 'failed';
    }
    return overwritten ? 'erased' : 'unlinked';
  }
}
