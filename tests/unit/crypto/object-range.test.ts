// Lectura aleatoria por rangos (docs/DESIGN.md §7.5 y §7.6).
import { randomBytes, randomInt } from 'node:crypto';
import { open } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNK, HEADER_LEN, KIND_MEDIA, chunkCount } from '../../../src/main/crypto/file-format';
import {
  openObject,
  type ObjectReader,
  type ReaderIo,
} from '../../../src/main/crypto/object-reader';
import { collect, randomKey, writeObject, type WrittenObject } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('object-range');
const kWrap = randomKey();
const P = 4 * CHUNK + 12345; // 5 chunks
const plaintext = randomBytes(P);
let obj: WrittenObject;
let reader: ObjectReader;

beforeAll(async () => {
  obj = await writeObject(tmp, plaintext, kWrap);
  reader = await openObject(obj.path, { fileId: obj.fileId, kind: KIND_MEDIA }, kWrap);
});

afterAll(async () => {
  await reader.close();
  removeTmpDir(tmp);
});

async function expectRange(r: ObjectReader, data: Buffer, a: number, b: number): Promise<void> {
  const got = await collect(r.createReadStream(a, b));
  expect(got.length).toBe(b - a + 1);
  expect(got.equals(data.subarray(a, b + 1))).toBe(true);
}

/** ReaderIo que registra cada lectura (posición, longitud). */
function spyIo(): { io: ReaderIo; reads: [number, number][] } {
  const reads: [number, number][] = [];
  const io: ReaderIo = {
    async open(path) {
      const fh = await open(path, 'r');
      return {
        read: (buffer, offset, length, position) => {
          reads.push([position, length]);
          return fh.read(buffer, offset, length, position);
        },
        stat: () => fh.stat(),
        close: () => fh.close(),
      };
    },
  };
  return { io, reads };
}

describe('lecturas aleatorias', () => {
  it('200 rangos aleatorios comparados byte a byte', async () => {
    for (let k = 0; k < 200; k += 1) {
      const a = randomInt(0, P);
      const b = randomInt(a, P);
      await expectRange(reader, plaintext, a, b);
    }
  });

  it('bordes de cada chunk: a y b en k·65536 − 1, k·65536 y k·65536 + 1', async () => {
    const edges: number[] = [0, P - 1];
    for (let k = 1; k < chunkCount(P); k += 1) edges.push(k * CHUNK - 1, k * CHUNK, k * CHUNK + 1);
    const points = [...new Set(edges)].filter((x) => x >= 0 && x < P).sort((x, y) => x - y);
    for (const a of points) {
      for (const b of points) if (b >= a) await expectRange(reader, plaintext, a, b);
    }
  });

  it('rango de un solo byte en el último chunk', async () => {
    await expectRange(reader, plaintext, P - 1, P - 1);
    await expectRange(reader, plaintext, P - 100, P - 100);
    await expectRange(reader, plaintext, (chunkCount(P) - 1) * CHUNK, (chunkCount(P) - 1) * CHUNK);
  });

  it('varios streams a la vez sobre el mismo lector', async () => {
    const ranges: [number, number][] = [
      [0, P - 1],
      [70000, 140000],
      [P - 10, P - 1],
      [CHUNK - 1, CHUNK],
    ];
    const results = await Promise.all(
      ranges.map(([a, b]) => collect(reader.createReadStream(a, b))),
    );
    results.forEach((got, k) => {
      const [a, b] = ranges[k] as [number, number];
      expect(got.equals(plaintext.subarray(a, b + 1))).toBe(true);
    });
  });

  it('rangos inválidos → RangeError', () => {
    expect(() => reader.createReadStream(-1, 10)).toThrow(RangeError);
    expect(() => reader.createReadStream(10, 9)).toThrow(RangeError);
    expect(() => reader.createReadStream(0, P)).toThrow(RangeError);
    expect(() => reader.createReadStream(0.5, 10)).toThrow(RangeError);
  });
});

describe('ejemplo de §7.6 (P = 150000)', () => {
  it('bytes=70000-140000 → 70001 bytes y solo se leen los chunks 1 y 2', async () => {
    const data = randomBytes(150000);
    const o = await writeObject(tmp, data, kWrap);
    const { io, reads } = spyIo();
    const r = await openObject(
      o.path,
      { fileId: o.fileId, kind: KIND_MEDIA },
      kWrap,
      undefined,
      io,
    );
    expect(reads).toEqual([[0, HEADER_LEN]]); // al abrir solo se lee la cabecera
    reads.length = 0;

    const got = await collect(r.createReadStream(70000, 140000));
    expect(got).toHaveLength(70001);
    expect(got.equals(data.subarray(70000, 140001))).toBe(true);
    // Chunk 1 (offset 65660, 65552 bytes) y chunk 2 (offset 131212, 18944 bytes); nada más.
    expect(reads).toEqual([
      [65660, 65552],
      [131212, 18944],
    ]);
    // Del chunk 1 se toman 61072 bytes (desde 4464) y del chunk 2 [0, 8928], 8929 bytes.
    expect(got.subarray(0, 61072).equals(data.subarray(70000, 131072))).toBe(true);
    expect(got.subarray(61072).equals(data.subarray(131072, 140001))).toBe(true);
    await r.close();
  });

  it('un rango dentro de un chunk solo lee ese chunk', async () => {
    const data = randomBytes(150000);
    const o = await writeObject(tmp, data, kWrap);
    const { io, reads } = spyIo();
    const r = await openObject(
      o.path,
      { fileId: o.fileId, kind: KIND_MEDIA },
      kWrap,
      undefined,
      io,
    );
    reads.length = 0;
    await expectRange(r, data, 140000, 140000);
    expect(reads).toEqual([[131212, 18944]]);
    await r.close();
  });
});
