// Detección de manipulaciones del formato cifrado (docs/DESIGN.md §7.2 y §7.4).
import { createDecipheriv, randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { AppErrorException } from '@shared/errors';
import {
  CHUNK,
  CHUNK_CT,
  HEADER_AAD_LEN,
  HEADER_LEN,
  KIND_MEDIA,
  KIND_THUMB,
  TAG,
  chunkAad,
  chunkCount,
  chunkLen,
  chunkNonce,
  chunkOffset,
  decodeHeader,
} from '../../../src/main/crypto/file-format';
import { unwrapDek } from '../../../src/main/crypto/keys';
import { openObject, type ObjectReader } from '../../../src/main/crypto/object-reader';
import { appErrorOf, randomFileId, randomKey, writeObject } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('object-tamper');
afterAll(() => removeTmpDir(tmp));

const P = 3 * CHUNK + 1000; // 4 chunks, el último corto
const kWrap = randomKey();
const plaintext = randomBytes(P);

let counter = 0;
/** Copia `bytes` a un archivo nuevo y lo abre esperando `fileId` y `kind`. */
async function openBytes(
  bytes: Buffer,
  fileId: Buffer,
  options: { kind?: 1 | 2; key?: Buffer } = {},
): Promise<ObjectReader> {
  counter += 1;
  const path = join(tmp, `t-${counter}`);
  writeFileSync(path, bytes);
  return openObject(path, { fileId, kind: options.kind ?? KIND_MEDIA }, options.key ?? kWrap);
}

/** Todo lo que entrega el stream antes de fallar, y el error. */
function drain(stream: Readable): Promise<{ data: Buffer; error: AppErrorException | null }> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    stream.on('data', (d: Buffer) => parts.push(d));
    stream.on('end', () => resolve({ data: Buffer.concat(parts), error: null }));
    stream.on('error', (e) =>
      resolve({ data: Buffer.concat(parts), error: e as AppErrorException }),
    );
  });
}

const HEADER_FIELDS: [string, number, number][] = [
  ['magic', 0, 4],
  ['version', 4, 1],
  ['kind', 5, 1],
  ['flags', 6, 2],
  ['chunkSize', 8, 4],
  ['plaintextSize', 12, 8],
  ['fileId', 20, 16],
  ['nonceBase', 36, 12],
  ['wrapNonce', 48, 12],
  ['wrappedDek', 60, 32],
  ['wrapTag', 92, 16],
];

describe('cabecera manipulada → INTEGRITY al abrir', () => {
  it.each(HEADER_FIELDS)('cada bit de %s', async (_name, offset, length) => {
    const small = randomBytes(100);
    const obj = await writeObject(tmp, small, kWrap);
    const original = readFileSync(obj.path);
    for (let byte = offset; byte < offset + length; byte += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const bytes = Buffer.from(original);
        bytes[byte] = (bytes[byte] as number) ^ (1 << bit);
        const err = await appErrorOf(() => openBytes(bytes, obj.fileId));
        expect(err.code).toBe('INTEGRITY');
      }
    }
    // Control: sin tocar, abre.
    const ok = await openBytes(original, obj.fileId);
    expect((await ok.readAll()).equals(small)).toBe(true);
    await ok.close();
  });
});

describe('chunks manipulados', () => {
  it('un bit del ciphertext o del tag de cada chunk → INTEGRITY sin entregar ese chunk', async () => {
    const obj = await writeObject(tmp, plaintext, kWrap);
    const original = readFileSync(obj.path);
    const n = chunkCount(P);
    for (let i = 0; i < n; i += 1) {
      const len = chunkLen(P, i);
      for (const where of ['ciphertext', 'tag'] as const) {
        const bytes = Buffer.from(original);
        const pos = chunkOffset(i) + (where === 'ciphertext' ? len >> 1 : len + TAG - 1);
        bytes[pos] = (bytes[pos] as number) ^ 0x04;
        const reader = await openBytes(bytes, obj.fileId); // la cabecera está intacta

        // Lectura completa: llegan como mucho los chunks anteriores, nunca bytes del manipulado.
        const full = await drain(reader.createReadStream(0, P - 1));
        expect(full.error?.error.code).toBe('INTEGRITY');
        expect(full.data.length).toBeLessThanOrEqual(i * CHUNK);
        expect(full.data.equals(plaintext.subarray(0, full.data.length))).toBe(true);

        // Un rango que empieza dentro del chunk manipulado no entrega nada.
        const inside = await drain(reader.createReadStream(i * CHUNK + 1, i * CHUNK + 1));
        expect(inside.error?.error.code).toBe('INTEGRITY');
        expect(inside.data).toHaveLength(0);

        expect((await appErrorOf(() => reader.readAll())).code).toBe('INTEGRITY');
        await reader.close();
      }
    }
  });

  it('chunks reordenados (0 ↔ 1) → INTEGRITY', async () => {
    const obj = await writeObject(tmp, plaintext, kWrap);
    const bytes = readFileSync(obj.path);
    const c0 = Buffer.from(bytes.subarray(chunkOffset(0), chunkOffset(0) + CHUNK_CT));
    const c1 = Buffer.from(bytes.subarray(chunkOffset(1), chunkOffset(1) + CHUNK_CT));
    c1.copy(bytes, chunkOffset(0));
    c0.copy(bytes, chunkOffset(1));
    const reader = await openBytes(bytes, obj.fileId);
    const out = await drain(reader.createReadStream(0, 2 * CHUNK - 1));
    expect(out.error?.error.code).toBe('INTEGRITY');
    expect(out.data).toHaveLength(0);
    expect((await appErrorOf(() => reader.readAll())).code).toBe('INTEGRITY');
    await reader.close();
  });

  it('chunk de otro archivo (mismo P, misma bóveda) → INTEGRITY', async () => {
    const a = await writeObject(tmp, plaintext, kWrap);
    const b = await writeObject(tmp, plaintext, kWrap);
    const bytesA = readFileSync(a.path);
    const bytesB = readFileSync(b.path);
    bytesA.copy(bytesB, chunkOffset(1), chunkOffset(1), chunkOffset(1) + CHUNK_CT);
    const reader = await openBytes(bytesB, b.fileId);
    const out = await drain(reader.createReadStream(CHUNK, 2 * CHUNK - 1));
    expect(out.error?.error.code).toBe('INTEGRITY');
    expect(out.data).toHaveLength(0);
    // Los chunks propios siguen leyéndose.
    const ok = await drain(reader.createReadStream(0, CHUNK - 1));
    expect(ok.data.equals(plaintext.subarray(0, CHUNK))).toBe(true);
    await reader.close();
  });

  it('chunk de un archivo de otra bóveda (otra K_wrap) → INTEGRITY', async () => {
    const other = await writeObject(tmp, plaintext, randomKey());
    const mine = await writeObject(tmp, plaintext, kWrap);
    const bytes = readFileSync(mine.path);
    readFileSync(other.path).copy(bytes, chunkOffset(2), chunkOffset(2), chunkOffset(2) + CHUNK_CT);
    const reader = await openBytes(bytes, mine.fileId);
    const out = await drain(reader.createReadStream(2 * CHUNK, 3 * CHUNK - 1));
    expect(out.error?.error.code).toBe('INTEGRITY');
    expect(out.data).toHaveLength(0);
    await reader.close();
  });
});

describe('truncado y extensión → INTEGRITY al abrir', () => {
  it('quitar el último chunk, cortar a mitad de chunk o dejar solo la cabecera', async () => {
    const obj = await writeObject(tmp, plaintext, kWrap);
    const bytes = readFileSync(obj.path);
    const lastChunk = chunkOffset(chunkCount(P) - 1);
    for (const cut of [lastChunk, chunkOffset(1) + 1000, HEADER_LEN, HEADER_LEN - 1, 0]) {
      const err = await appErrorOf(() => openBytes(bytes.subarray(0, cut), obj.fileId));
      expect(err.code).toBe('INTEGRITY');
    }
  });

  it('truncar el archivo vacío entero (deja solo la cabecera) → INTEGRITY', async () => {
    const obj = await writeObject(tmp, Buffer.alloc(0), kWrap);
    const bytes = readFileSync(obj.path);
    expect(
      (await appErrorOf(() => openBytes(bytes.subarray(0, HEADER_LEN), obj.fileId))).code,
    ).toBe('INTEGRITY');
  });

  it('+1 byte y +un chunk copiado', async () => {
    const obj = await writeObject(tmp, plaintext, kWrap);
    const bytes = readFileSync(obj.path);
    const plusOne = Buffer.concat([bytes, Buffer.from([0])]);
    const plusChunk = Buffer.concat([
      bytes,
      bytes.subarray(chunkOffset(1), chunkOffset(1) + CHUNK_CT),
    ]);
    for (const b of [plusOne, plusChunk]) {
      const err = await appErrorOf(() => openBytes(b, obj.fileId));
      expect(err).toEqual({ code: 'INTEGRITY', reason: 'size' });
    }
  });
});

describe('identidad del objeto', () => {
  it('intercambio de archivos: abrir A esperando el fileId de B → INTEGRITY', async () => {
    const a = await writeObject(tmp, plaintext, kWrap);
    const b = await writeObject(tmp, randomBytes(P), kWrap);
    // "Renombrar" A como B: el contenido de A en la ruta de B.
    copyFileSync(a.path, b.path);
    const err = await appErrorOf(() =>
      openObject(b.path, { fileId: b.fileId, kind: KIND_MEDIA }, kWrap),
    );
    expect(err).toEqual({ code: 'INTEGRITY', reason: 'file-id' });
    const err2 = await appErrorOf(() => openBytes(readFileSync(a.path), randomFileId()));
    expect(err2).toEqual({ code: 'INTEGRITY', reason: 'file-id' });
  });

  it('kind esperado distinto → INTEGRITY', async () => {
    const thumb = await writeObject(tmp, randomBytes(2000), kWrap, { kind: KIND_THUMB });
    const media = await writeObject(tmp, randomBytes(2000), kWrap, { kind: KIND_MEDIA });
    expect(
      await appErrorOf(() =>
        openObject(thumb.path, { fileId: thumb.fileId, kind: KIND_MEDIA }, kWrap),
      ),
    ).toEqual({ code: 'INTEGRITY', reason: 'kind' });
    expect(
      await appErrorOf(() =>
        openObject(media.path, { fileId: media.fileId, kind: KIND_THUMB }, kWrap),
      ),
    ).toEqual({ code: 'INTEGRITY', reason: 'kind' });
  });

  it('otra K_wrap (archivo de otra bóveda) → INTEGRITY', async () => {
    const obj = await writeObject(tmp, plaintext, kWrap);
    expect(
      await appErrorOf(() =>
        openObject(obj.path, { fileId: obj.fileId, kind: KIND_MEDIA }, randomKey()),
      ),
    ).toEqual({ code: 'INTEGRITY', reason: 'wrap' });
  });
});

describe('authTagLength: 16', () => {
  it('un tag de 12 bytes no valida', async () => {
    const obj = await writeObject(tmp, plaintext, kWrap);
    const bytes = readFileSync(obj.path);
    const header = decodeHeader(bytes);
    const dek = unwrapDek(header, kWrap, bytes.subarray(0, HEADER_AAD_LEN));
    const ct = bytes.subarray(chunkOffset(0), chunkOffset(0) + CHUNK);
    const tag = bytes.subarray(chunkOffset(0) + CHUNK, chunkOffset(0) + CHUNK + TAG);
    const decrypt = (t: Buffer): Buffer => {
      const d = createDecipheriv('aes-256-gcm', dek, chunkNonce(header.nonceBase, 0), {
        authTagLength: 16,
      });
      d.setAAD(chunkAad(header.fileId, 0, false));
      d.setAuthTag(t);
      return Buffer.concat([d.update(ct), d.final()]);
    };
    expect(decrypt(Buffer.from(tag)).equals(plaintext.subarray(0, CHUNK))).toBe(true);
    expect(() => decrypt(Buffer.from(tag.subarray(0, 12)))).toThrow();

    // En el archivo: los 4 últimos bytes del tag a cero (mismo tamaño) → INTEGRITY.
    const truncatedTag = Buffer.from(bytes);
    truncatedTag.fill(0, chunkOffset(0) + CHUNK + 12, chunkOffset(0) + CHUNK + TAG);
    const reader = await openBytes(truncatedTag, obj.fileId);
    expect((await appErrorOf(() => reader.readAll())).code).toBe('INTEGRITY');
    await reader.close();
  });
});
