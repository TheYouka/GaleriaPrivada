// Ciclo de vida del escritor y el lector: abort, destroyKeys, AbortSignal y errores de E/S
// (docs/DESIGN.md §6.7, §7.7 y §13.3).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CHUNK, HEADER_LEN, KIND_MEDIA } from '../../../src/main/crypto/file-format';
import { openObject, type ReaderIo } from '../../../src/main/crypto/object-reader';
import {
  createObjectWriter,
  defaultWriterIo,
  type ObjectWriter,
  type WriterIo,
} from '../../../src/main/crypto/object-writer';
import { appErrorOf, isAllZero, randomFileId, randomKey, writeObject } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// Captura las DEKs sin ganchos en el código de producción: la del writer es el primer
// randomOwned(32) de createObjectWriter; la de un reader sin caché, la salida de takeOwned del
// desenvolvimiento.
const captured = vi.hoisted(() => ({ random32: [] as Buffer[], owned: [] as Buffer[] }));
vi.mock('../../../src/main/crypto/secure-buffer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/main/crypto/secure-buffer')>();
  return {
    ...mod,
    randomOwned: (n: number): Buffer => {
      const b = mod.randomOwned(n);
      if (n === 32) captured.random32.push(b);
      return b;
    },
    takeOwned: (src: Buffer): Buffer => {
      const b = mod.takeOwned(src);
      captured.owned.push(b);
      return b;
    },
  };
});

const tmp = makeTmpDir('object-lifecycle');
afterAll(() => removeTmpDir(tmp));
const kWrap = randomKey();

function newWriter(options: { signal?: AbortSignal; io?: WriterIo } = {}): {
  writer: ObjectWriter;
  dek: Buffer;
  path: string;
  fileId: Buffer;
} {
  const fileId = randomFileId();
  const path = join(tmp, `${fileId.toString('hex')}.part`);
  const before = captured.random32.length;
  const writer = createObjectWriter(
    { kind: KIND_MEDIA, fileId, kWrap, tmpPath: path, signal: options.signal },
    options.io,
  );
  const dek = captured.random32[before] as Buffer;
  expect(dek).toHaveLength(32);
  expect(isAllZero(dek)).toBe(false);
  return { writer, dek, path, fileId };
}

/** Error con que termina un stream (o null si termina bien). */
function streamError(stream: Readable): Promise<{ code?: string; bytes: number }> {
  return new Promise((resolve) => {
    let bytes = 0;
    stream.on('data', (d: Buffer) => (bytes += d.length));
    stream.on('end', () => resolve({ bytes }));
    stream.on('error', (e) =>
      resolve({ code: (e as { error?: { code?: string } }).error?.code, bytes }),
    );
  });
}

describe('ObjectWriter', () => {
  it('antes de finish() los 108 primeros bytes del .part son cero', async () => {
    const { writer, path } = newWriter();
    await writer.write(randomBytes(3 * CHUNK + 500));
    const partial = readFileSync(path);
    expect(partial.length).toBeGreaterThanOrEqual(HEADER_LEN + 3 * (CHUNK + 16));
    expect(isAllZero(partial.subarray(0, HEADER_LEN))).toBe(true);
    await writer.finish();
    const done = readFileSync(path);
    expect(done.subarray(0, 4).toString('latin1')).toBe('GALV');
  });

  it('finish() pone la DEK a cero', async () => {
    const { writer, dek } = newWriter();
    await writer.write(randomBytes(1000));
    await writer.finish();
    expect(isAllZero(dek)).toBe(true);
  });

  it('abort() borra el .part, deja la DEK a cero y nunca lanza', async () => {
    const { writer, dek, path } = newWriter();
    await writer.write(randomBytes(2 * CHUNK + 10));
    expect(existsSync(path)).toBe(true);
    const pending = writer.abort();
    expect(isAllZero(dek)).toBe(true); // síncrono, antes de esperar a nada
    await expect(pending).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(false);
    await expect(writer.abort()).resolves.toBeUndefined(); // idempotente
    expect((await appErrorOf(() => writer.write(randomBytes(10)))).code).toBe('LOCKED');
  });

  it('tras destroyKeys(), write() y finish() rechazan con LOCKED; abort() borra el .part', async () => {
    const { writer, dek, path } = newWriter();
    await writer.write(randomBytes(CHUNK + 1));
    writer.destroyKeys();
    expect(isAllZero(dek)).toBe(true); // síncrono
    expect((await appErrorOf(() => writer.write(randomBytes(10)))).code).toBe('LOCKED');
    expect((await appErrorOf(() => writer.finish())).code).toBe('LOCKED');
    expect(existsSync(path)).toBe(true); // destroyKeys no borra: lo hace abort() después
    await writer.abort();
    expect(existsSync(path)).toBe(false);
  });

  it('destroyKeys() con una escritura en curso: la DEK queda a cero y la escritura da LOCKED', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const io: WriterIo = {
      async create(p) {
        const fh = await defaultWriterIo.create(p);
        let calls = 0;
        return {
          write: async (...args) => {
            calls += 1;
            if (calls === 2) await gate; // el primer chunk se queda "colgado" en el disco
            return fh.write(...args);
          },
          sync: () => fh.sync(),
          close: () => fh.close(),
        };
      },
      unlink: defaultWriterIo.unlink,
    };
    const { writer, dek, path } = newWriter({ io });
    const inFlight = writer.write(randomBytes(2 * CHUNK + 1));
    await new Promise((r) => setTimeout(r, 20));
    writer.destroyKeys();
    expect(isAllZero(dek)).toBe(true);
    release();
    expect((await appErrorOf(() => inFlight)).code).toBe('LOCKED');
    await writer.abort();
    expect(existsSync(path)).toBe(false);
  });

  it('disparar el AbortSignal pone la DEK a cero de forma síncrona', async () => {
    const controller = new AbortController();
    const { writer, dek, path } = newWriter({ signal: controller.signal });
    await writer.write(randomBytes(500));
    controller.abort();
    expect(isAllZero(dek)).toBe(true);
    expect((await appErrorOf(() => writer.write(randomBytes(10)))).code).toBe('LOCKED');
    await writer.abort();
    expect(existsSync(path)).toBe(false);
  });

  it('con una señal ya abortada el writer nace muerto', async () => {
    const controller = new AbortController();
    controller.abort();
    const { writer, dek } = newWriterAllowZero(controller.signal);
    expect(isAllZero(dek)).toBe(true);
    expect((await appErrorOf(() => writer.write(randomBytes(10)))).code).toBe('LOCKED');
    await writer.abort();
  });

  it.each([
    ['ENOSPC', 'DISK_FULL'],
    ['EIO', 'IO'],
  ])('%s simulado al escribir → %s y el .part se borra', async (errno, code) => {
    const io: WriterIo = {
      async create(p) {
        const fh = await defaultWriterIo.create(p);
        let calls = 0;
        return {
          write: async (...args) => {
            calls += 1;
            // 1: cabecera a cero; 2: chunk 0; 3: chunk 1 → falla
            if (calls === 3)
              throw Object.assign(new Error('simulado'), { code: errno, syscall: 'write' });
            return fh.write(...args);
          },
          sync: () => fh.sync(),
          close: () => fh.close(),
        };
      },
      unlink: defaultWriterIo.unlink,
    };
    const { writer, dek, path } = newWriter({ io });
    const err = await appErrorOf(() => writer.write(randomBytes(3 * CHUNK)));
    expect(err.code).toBe(code);
    expect(existsSync(path)).toBe(false);
    expect(isAllZero(dek)).toBe(true);
    expect((await appErrorOf(() => writer.finish())).code).toBe(code);
  });

  it('fsync que falla en finish() → IO y el .part se borra', async () => {
    const io: WriterIo = {
      async create(p) {
        const fh = await defaultWriterIo.create(p);
        return {
          write: (...args) => fh.write(...args),
          sync: () => Promise.reject(Object.assign(new Error('simulado'), { code: 'EIO' })),
          close: () => fh.close(),
        };
      },
      unlink: defaultWriterIo.unlink,
    };
    const { writer, path } = newWriter({ io });
    await writer.write(randomBytes(100));
    expect((await appErrorOf(() => writer.finish())).code).toBe('IO');
    expect(existsSync(path)).toBe(false);
  });

  it('ENOSPC al escribir la cabecera a cero: DISK_FULL, el descriptor se cierra y el .part se borra', async () => {
    let closes = 0;
    const io: WriterIo = {
      async create(p) {
        const fh = await defaultWriterIo.create(p);
        return {
          write: () =>
            Promise.reject(
              Object.assign(new Error('simulado'), { code: 'ENOSPC', syscall: 'write' }),
            ),
          sync: () => fh.sync(),
          close: async () => {
            closes += 1;
            await fh.close();
          },
        };
      },
      unlink: defaultWriterIo.unlink,
    };
    const { writer, dek, path } = newWriter({ io });
    expect((await appErrorOf(() => writer.write(randomBytes(10)))).code).toBe('DISK_FULL');
    expect(closes).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(isAllZero(dek)).toBe(true);
    await writer.abort();
    expect(closes).toBe(1); // abort() no lo vuelve a cerrar
  });

  it.each(['destroyKeys', 'abort'] as const)(
    '%s() durante el close de finish(): finish() rechaza con LOCKED y el .part se borra',
    async (how) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let entered: () => void = () => undefined;
      const inClose = new Promise<void>((r) => (entered = r));
      const io: WriterIo = {
        async create(p) {
          const fh = await defaultWriterIo.create(p);
          return {
            write: (...args) => fh.write(...args),
            sync: () => fh.sync(),
            close: async () => {
              entered();
              await gate; // el close de finish() se queda "colgado"
              await fh.close();
            },
          };
        },
        unlink: defaultWriterIo.unlink,
      };
      const { writer, dek, path } = newWriter({ io });
      await writer.write(randomBytes(CHUNK + 5));
      const finishing = appErrorOf(() => writer.finish());
      await inClose;
      let aborting: Promise<void> | null = null;
      if (how === 'abort') aborting = writer.abort();
      else writer.destroyKeys();
      expect(isAllZero(dek)).toBe(true); // síncrono
      release();
      expect((await finishing).code).toBe('LOCKED');
      await (aborting ?? writer.abort());
      expect(existsSync(path)).toBe(false);
    },
  );

  it('nunca reabre ni borra un archivo existente (escritura única)', async () => {
    const fileId = randomFileId();
    const path = join(tmp, `${fileId.toString('hex')}.part`);
    writeFileSync(path, 'ya existía');
    const writer = createObjectWriter({ kind: KIND_MEDIA, fileId, kWrap, tmpPath: path });
    expect((await appErrorOf(() => writer.write(randomBytes(10)))).code).toBe('IO');
    expect(readFileSync(path, 'utf8')).toBe('ya existía');
    await writer.abort();
    expect(readFileSync(path, 'utf8')).toBe('ya existía');
  });

  it('carpeta inexistente → IO', async () => {
    const fileId = randomFileId();
    const path = join(tmp, 'no-existe', `${fileId.toString('hex')}.part`);
    const writer = createObjectWriter({ kind: KIND_MEDIA, fileId, kWrap, tmpPath: path });
    expect((await appErrorOf(() => writer.finish())).code).toBe('IO');
  });
});

/** newWriter sin exigir que la DEK capturada sea distinta de cero (señal ya abortada). */
function newWriterAllowZero(signal: AbortSignal): { writer: ObjectWriter; dek: Buffer } {
  const fileId = randomFileId();
  const before = captured.random32.length;
  const writer = createObjectWriter({
    kind: KIND_MEDIA,
    fileId,
    kWrap,
    tmpPath: join(tmp, `${fileId.toString('hex')}.part`),
    signal,
  });
  return { writer, dek: captured.random32[before] as Buffer };
}

describe('ObjectReader', () => {
  async function openWithDek(
    plaintext: Buffer,
    io?: ReaderIo,
  ): Promise<{ reader: Awaited<ReturnType<typeof openObject>>; dek: Buffer }> {
    const obj = await writeObject(tmp, plaintext, kWrap);
    const before = captured.owned.length;
    const reader = await openObject(
      obj.path,
      { fileId: obj.fileId, kind: KIND_MEDIA },
      kWrap,
      undefined,
      io,
    );
    const dek = captured.owned[before] as Buffer;
    expect(dek).toHaveLength(32);
    expect(isAllZero(dek)).toBe(false);
    return { reader, dek };
  }

  it('destroyKeys() pone la DEK a cero y hace fallar con LOCKED las lecturas pendientes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    const io: ReaderIo = {
      async open(p) {
        const fh = await open(p, 'r');
        return {
          read: async (buffer, offset, length, position) => {
            if (gated) await gate; // lecturas de chunks "colgadas" en el disco
            return fh.read(buffer, offset, length, position);
          },
          stat: () => fh.stat(),
          close: () => fh.close(),
        };
      },
    };
    const plaintext = randomBytes(3 * CHUNK);
    const { reader, dek } = await openWithDek(plaintext, io);
    gated = true;
    const stream = streamError(reader.createReadStream(0, plaintext.length - 1));
    const all = appErrorOf(() => reader.readAll());
    await new Promise((r) => setTimeout(r, 20));

    reader.destroyKeys();
    expect(isAllZero(dek)).toBe(true); // síncrono
    release();

    expect(await stream).toEqual({ code: 'LOCKED', bytes: 0 });
    expect((await all).code).toBe('LOCKED');
    // Lecturas nuevas tras destroyKeys() también fallan.
    expect((await streamError(reader.createReadStream(0, 10))).code).toBe('LOCKED');
    await reader.close();
  });

  it('close() pone la DEK a cero y las lecturas posteriores dan LOCKED', async () => {
    const { reader, dek } = await openWithDek(randomBytes(1000));
    await reader.close();
    expect(isAllZero(dek)).toBe(true);
    expect((await appErrorOf(() => reader.readAll())).code).toBe('LOCKED');
    await expect(reader.close()).resolves.toBeUndefined();
  });

  it('ENOENT → NOT_FOUND; una carpeta → IO', async () => {
    const fileId = randomFileId();
    expect(
      (
        await appErrorOf(() =>
          openObject(join(tmp, 'no-existe'), { fileId, kind: KIND_MEDIA }, kWrap),
        )
      ).code,
    ).toBe('NOT_FOUND');
    const dir = join(tmp, 'una-carpeta');
    mkdirSync(dir, { recursive: true });
    expect(
      (await appErrorOf(() => openObject(dir, { fileId, kind: KIND_MEDIA }, kWrap))).code,
    ).toBe('IO');
  });

  it('error de E/S al leer un chunk → IO', async () => {
    const io: ReaderIo = {
      async open(p) {
        const fh = await open(p, 'r');
        let calls = 0;
        return {
          read: async (buffer, offset, length, position) => {
            calls += 1;
            if (calls > 1) throw Object.assign(new Error('simulado'), { code: 'EIO' });
            return fh.read(buffer, offset, length, position);
          },
          stat: () => fh.stat(),
          close: () => fh.close(),
        };
      },
    };
    const { reader } = await openWithDek(randomBytes(1000), io);
    expect((await appErrorOf(() => reader.readAll())).code).toBe('IO');
    await reader.close();
  });
});
