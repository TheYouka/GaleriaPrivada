// Ida y vuelta del formato cifrado (docs/DESIGN.md §7.3, §7.7 y §22).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHUNK,
  HEADER_AAD_LEN,
  HEADER_LEN,
  KIND_MEDIA,
  KIND_THUMB,
  TAG,
  decodeHeader,
  fileLength,
} from '../../../src/main/crypto/file-format';
import { DekCache, unwrapDek } from '../../../src/main/crypto/keys';
import { openObject } from '../../../src/main/crypto/object-reader';
import { createObjectWriter } from '../../../src/main/crypto/object-writer';
import { MiB, collect, randomFileId, randomKey, writeObject } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('object-roundtrip');
afterAll(() => removeTmpDir(tmp));

const SIZES = [0, 1, 65535, 65536, 65537, 3 * 65536, MiB + 123];

describe('ida y vuelta', () => {
  it.each(SIZES)('P = %i escrito en trozos aleatorios', async (p) => {
    const kWrap = randomKey();
    const plaintext = randomBytes(p);
    const obj = await writeObject(tmp, plaintext, kWrap);
    expect(obj.result.plaintextSize).toBe(p);
    expect(obj.result.sha256.equals(createHash('sha256').update(plaintext).digest())).toBe(true);
    expect(obj.result.hmac).toBeNull();
    expect(statSync(obj.path).size).toBe(fileLength(p));

    const reader = await openObject(obj.path, { fileId: obj.fileId, kind: KIND_MEDIA }, kWrap);
    expect(reader.plaintextSize).toBe(p);
    expect((await reader.readAll()).equals(plaintext)).toBe(true);
    if (p > 0)
      expect((await collect(reader.createReadStream(0, p - 1))).equals(plaintext)).toBe(true);
    await reader.close();
  });

  it('archivo vacío: un chunk final de 0 bytes + tag (L = 124)', async () => {
    const kWrap = randomKey();
    const obj = await writeObject(tmp, Buffer.alloc(0), kWrap);
    const bytes = readFileSync(obj.path);
    expect(bytes).toHaveLength(HEADER_LEN + TAG);
    expect(bytes).toHaveLength(124);
    expect(decodeHeader(bytes).plaintextSize).toBe(0);
    const reader = await openObject(obj.path, { fileId: obj.fileId, kind: KIND_MEDIA }, kWrap);
    expect(await reader.readAll()).toHaveLength(0);
    await reader.close();
    expect(() => reader.createReadStream(0, 0)).toThrow(RangeError);
  });

  it.each([65536, 3 * 65536])(
    'múltiplo exacto (P = %i): sin chunk vacío extra y el último lleva final = 1',
    async (p) => {
      const kWrap = randomKey();
      const plaintext = randomBytes(p);
      // Escrito en bloques de exactamente 64 KiB, el caso en que hay que retener el último.
      const fileId = randomFileId();
      const path = join(tmp, fileId.toString('hex'));
      const writer = createObjectWriter({ kind: KIND_MEDIA, fileId, kWrap, tmpPath: path });
      for (let off = 0; off < p; off += CHUNK)
        await writer.write(plaintext.subarray(off, off + CHUNK));
      await writer.write(Buffer.alloc(0));
      await writer.finish();
      const n = p / CHUNK;
      expect(statSync(path).size).toBe(HEADER_LEN + p + TAG * n);
      // El lector exige final = 1 en el chunk n−1 (AAD): si el escritor no lo hubiera marcado, o
      // hubiera añadido un chunk vacío, la lectura fallaría.
      const reader = await openObject(path, { fileId, kind: KIND_MEDIA }, kWrap);
      expect((await reader.readAll()).equals(plaintext)).toBe(true);
      expect((await collect(reader.createReadStream(p - 1, p - 1)))[0]).toBe(plaintext[p - 1]);
      await reader.close();
    },
  );

  it('miniaturas (kind = 2) y HMAC de los originales', async () => {
    const kWrap = randomKey();
    const hmacKey = randomKey();
    const plaintext = randomBytes(70000);
    const thumb = await writeObject(tmp, plaintext, kWrap, { kind: KIND_THUMB });
    const reader = await openObject(thumb.path, { fileId: thumb.fileId, kind: KIND_THUMB }, kWrap);
    expect((await reader.readAll()).equals(plaintext)).toBe(true);
    await reader.close();
    const original = await writeObject(tmp, plaintext, kWrap, { hmacKey });
    expect(
      original.result.hmac?.equals(createHmac('sha256', hmacKey).update(plaintext).digest()),
    ).toBe(true);
  });

  it('dos escrituras del mismo contenido dan DEK, cabecera y ciphertext distintos (§22)', async () => {
    const kWrap = randomKey();
    const plaintext = randomBytes(100000);
    const fileId = randomFileId();
    const dirA = makeTmpDir('object-roundtrip-a');
    const dirB = makeTmpDir('object-roundtrip-b');
    try {
      const a = await writeObject(dirA, plaintext, kWrap, { fileId });
      const b = await writeObject(dirB, plaintext, kWrap, { fileId });
      const bytesA = readFileSync(a.path);
      const bytesB = readFileSync(b.path);
      const headerA = bytesA.subarray(0, HEADER_LEN);
      const headerB = bytesB.subarray(0, HEADER_LEN);
      expect(headerA.equals(headerB)).toBe(false);
      expect(bytesA.subarray(HEADER_LEN).equals(bytesB.subarray(HEADER_LEN))).toBe(false);
      const dekA = unwrapDek(decodeHeader(headerA), kWrap, headerA.subarray(0, HEADER_AAD_LEN));
      const dekB = unwrapDek(decodeHeader(headerB), kWrap, headerB.subarray(0, HEADER_AAD_LEN));
      expect(dekA.equals(dekB)).toBe(false);
      expect(decodeHeader(headerA).nonceBase.equals(decodeHeader(headerB).nonceBase)).toBe(false);
    } finally {
      removeTmpDir(dirA);
      removeTmpDir(dirB);
    }
  });

  it('con DekCache: el segundo openObject usa la caché y el lector tiene su copia', async () => {
    const kWrap = randomKey();
    const plaintext = randomBytes(5000);
    const obj = await writeObject(tmp, plaintext, kWrap);
    const cache = new DekCache();
    const first = await openObject(
      obj.path,
      { fileId: obj.fileId, kind: KIND_MEDIA },
      kWrap,
      cache,
    );
    expect(cache.size).toBe(1);
    first.destroyKeys(); // poner a cero la copia del lector no afecta a la caché
    // Con la caché, ni siquiera hace falta la K_wrap correcta: la cabecera es idéntica.
    const second = await openObject(
      obj.path,
      { fileId: obj.fileId, kind: KIND_MEDIA },
      randomKey(),
      cache,
    );
    expect((await second.readAll()).equals(plaintext)).toBe(true);
    await second.close();
    await first.close();
  });
});
