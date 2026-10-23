// Formato de archivo cifrado v1: constantes, cabecera y aritmética (docs/DESIGN.md §7.1–§7.6).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppErrorException } from '@shared/errors';
import {
  CHUNK,
  CHUNK_AAD_LEN,
  CHUNK_CT,
  HEADER_AAD_LEN,
  HEADER_LEN,
  MAX_PLAINTEXT,
  TAG,
  VERSION,
  chunkAad,
  chunkCount,
  chunkLen,
  chunkNonce,
  chunkOffset,
  decodeHeader,
  encodeHeader,
  encodeHeaderAad,
  fileLength,
  type ObjectHeader,
} from '../../../src/main/crypto/file-format';

const MiB = 1024 * 1024;

function integrityReason(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppErrorException && err.error.code === 'INTEGRITY') {
      return String(err.error.details?.reason);
    }
    throw err;
  }
  return null;
}

function sampleHeader(overrides: Partial<ObjectHeader> = {}): ObjectHeader {
  return {
    kind: 1,
    plaintextSize: 150000,
    fileId: randomBytes(16),
    nonceBase: randomBytes(12),
    wrapNonce: randomBytes(12),
    wrappedDek: randomBytes(32),
    wrapTag: randomBytes(16),
    ...overrides,
  };
}

describe('constantes (§7.1)', () => {
  it('valores fijos', () => {
    expect(HEADER_LEN).toBe(108);
    expect(CHUNK).toBe(65536);
    expect(TAG).toBe(16);
    expect(CHUNK_CT).toBe(65552);
    expect(MAX_PLAINTEXT).toBe(2 ** 40);
    expect(VERSION).toBe(1);
    expect(HEADER_AAD_LEN).toBe(48);
    expect(CHUNK_AAD_LEN).toBe(25);
  });
});

describe('tamaños y offsets (§7.3)', () => {
  // [P, n, len del último chunk, L]
  const cases: [number, number, number, number][] = [
    [0, 1, 0, 124],
    [1, 1, 1, 125],
    [65535, 1, 65535, 65659],
    [65536, 1, 65536, 65660],
    [65537, 2, 1, 65677],
    [3 * 65536, 3, 65536, 196764],
    [MiB + 123, 17, 123, 1049079],
  ];

  it.each(cases)('P = %i → n = %i, último = %i, L = %i', (p, n, last, l) => {
    expect(chunkCount(p)).toBe(n);
    expect(chunkLen(p, n - 1)).toBe(last);
    for (let i = 0; i < n - 1; i += 1) expect(chunkLen(p, i)).toBe(CHUNK);
    expect(fileLength(p)).toBe(l);
    // Los chunks son contiguos y el último termina exactamente en L.
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      expect(chunkOffset(i)).toBe(HEADER_LEN + i * CHUNK_CT);
      total += chunkLen(p, i);
    }
    expect(total).toBe(p);
    expect(chunkOffset(n - 1) + chunkLen(p, n - 1) + TAG).toBe(l);
  });

  it('múltiplos exactos de 64 KiB: no hay chunk vacío extra', () => {
    expect(chunkCount(65536)).toBe(1);
    expect(chunkCount(3 * 65536)).toBe(3);
    expect(() => chunkLen(3 * 65536, 3)).toThrow(RangeError);
  });

  it('ejemplo resuelto de §7.6 (P = 150000)', () => {
    const p = 150000;
    expect(chunkCount(p)).toBe(3);
    expect([0, 1, 2].map((i) => chunkLen(p, i))).toEqual([65536, 65536, 18928]);
    expect([0, 1, 2].map((i) => chunkOffset(i))).toEqual([108, 65660, 131212]);
    expect(fileLength(p)).toBe(150156);
    expect(chunkLen(p, 2) + TAG).toBe(18944);
    expect(chunkOffset(2) + chunkLen(p, 2) + TAG).toBe(150156);
  });

  it('rechaza tamaños fuera de [0, 2^40] e índices fuera de rango', () => {
    expect(() => chunkCount(-1)).toThrow(RangeError);
    expect(() => chunkCount(MAX_PLAINTEXT + 1)).toThrow(RangeError);
    expect(() => chunkCount(1.5)).toThrow(RangeError);
    expect(chunkCount(MAX_PLAINTEXT)).toBe(2 ** 24);
    expect(() => chunkLen(10, 1)).toThrow(RangeError);
    expect(() => chunkLen(10, -1)).toThrow(RangeError);
    expect(() => chunkOffset(-1)).toThrow(RangeError);
  });
});

describe('nonce y AAD de cada chunk (§7.3, §7.6)', () => {
  const base = Buffer.from('00112233445566778899AABB', 'hex');

  it('vector de §7.6: …8899AABB → …8899AAB9 para i = 2', () => {
    expect(chunkNonce(base, 2).toString('hex').toUpperCase()).toBe('00112233445566778899AAB9');
  });

  it('i = 0 deja la base; el XOR solo toca los bytes 4..11', () => {
    expect(chunkNonce(base, 0).equals(base)).toBe(true);
    // i = 2^40 + 1 → XOR con 00 00 01 00 00 00 00 01 sobre los bytes 4..11
    expect(
      chunkNonce(base, 2 ** 40 + 1)
        .toString('hex')
        .toUpperCase(),
    ).toBe('00112233445567778899AABA');
    expect(base.toString('hex').toUpperCase()).toBe('00112233445566778899AABB'); // no muta
  });

  it('i ↦ nonce_i es inyectiva en los primeros chunks', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4096; i += 1) seen.add(chunkNonce(base, i).toString('hex'));
    expect(seen.size).toBe(4096);
  });

  it('AAD de 25 bytes: fileId ‖ uint64_be(i) ‖ final', () => {
    const fileId = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
    const last = chunkAad(fileId, 2, true);
    expect(last).toHaveLength(25);
    expect(last.toString('hex')).toBe(
      '0102030405060708090a0b0c0d0e0f10' + '0000000000000002' + '01',
    );
    const middle = chunkAad(fileId, 2, false);
    expect(middle.toString('hex')).toBe(
      '0102030405060708090a0b0c0d0e0f10' + '0000000000000002' + '00',
    );
  });
});

describe('cabecera (§7.2)', () => {
  it('codifica y decodifica 108 bytes en big-endian', () => {
    const h = sampleHeader({ kind: 2, plaintextSize: 2 ** 40 });
    const buf = encodeHeader(h);
    expect(buf).toHaveLength(HEADER_LEN);
    expect(buf.subarray(0, 4).toString('latin1')).toBe('GALV');
    expect(buf[4]).toBe(1);
    expect(buf[5]).toBe(2);
    expect(buf.readUInt16BE(6)).toBe(0);
    expect(buf.readUInt32BE(8)).toBe(65536);
    expect(buf.readBigUInt64BE(12)).toBe(2n ** 40n);
    expect(buf.subarray(20, 36).equals(h.fileId)).toBe(true);
    expect(buf.subarray(36, 48).equals(h.nonceBase)).toBe(true);
    expect(buf.subarray(48, 60).equals(h.wrapNonce)).toBe(true);
    expect(buf.subarray(60, 92).equals(h.wrappedDek)).toBe(true);
    expect(buf.subarray(92, 108).equals(h.wrapTag)).toBe(true);
    expect(decodeHeader(buf)).toEqual(h);
  });

  it('la AAD de la envoltura son los 48 primeros bytes de la cabecera', () => {
    const h = sampleHeader();
    expect(encodeHeaderAad(h).equals(encodeHeader(h).subarray(0, HEADER_AAD_LEN))).toBe(true);
  });

  it('validación estructural: magic, version, kind, flags, chunkSize y P → INTEGRITY', () => {
    const good = encodeHeader(sampleHeader());
    const mutate = (fn: (b: Buffer) => void): Buffer => {
      const b = Buffer.from(good);
      fn(b);
      return b;
    };
    expect(integrityReason(() => decodeHeader(good))).toBeNull();
    expect(integrityReason(() => decodeHeader(mutate((b) => (b[0] = 0x48))))).toBe('header');
    expect(integrityReason(() => decodeHeader(mutate((b) => (b[4] = 2))))).toBe('header');
    expect(integrityReason(() => decodeHeader(mutate((b) => (b[5] = 3))))).toBe('header');
    expect(integrityReason(() => decodeHeader(mutate((b) => (b[5] = 0))))).toBe('header');
    expect(integrityReason(() => decodeHeader(mutate((b) => (b[7] = 1))))).toBe('header');
    expect(integrityReason(() => decodeHeader(mutate((b) => b.writeUInt32BE(65537, 8))))).toBe(
      'header',
    );
    expect(
      integrityReason(() => decodeHeader(mutate((b) => b.writeBigUInt64BE(2n ** 40n + 1n, 12)))),
    ).toBe('header');
    expect(integrityReason(() => decodeHeader(good.subarray(0, 107)))).toBe('header');
  });
});
