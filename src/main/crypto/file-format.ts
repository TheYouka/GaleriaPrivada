// Formato de archivo cifrado, versión 1 (docs/DESIGN.md §7.1–§7.6): constantes, cabecera de 108
// bytes y aritmética de chunks. Módulo puro: no hace E/S ni conoce claves.
//
// Cabecera (big-endian):
//   0 magic "GALV" · 4 version · 5 kind · 6 flags · 8 chunkSize · 12 plaintextSize (u64)
//   20 fileId (16) · 36 nonceBase (12) · 48 wrapNonce (12) · 60 wrappedDek (32) · 92 wrapTag (16)
// La AAD de la envoltura de la DEK son los bytes [0, 48): cambiar cualquier bit de la cabecera hace
// fallar el desenvolvimiento.
import { AppErrorException } from '@shared/errors';

export const MAGIC = Object.freeze([0x47, 0x41, 0x4c, 0x56]); // "GALV"
export const VERSION = 1;
export const HEADER_LEN = 108;
export const CHUNK = 65536;
export const TAG = 16;
export const CHUNK_CT = CHUNK + TAG;
export const MAX_PLAINTEXT = 2 ** 40;

export const KIND_MEDIA = 1;
export const KIND_THUMB = 2;
export type ObjectKind = typeof KIND_MEDIA | typeof KIND_THUMB;

export const FILE_ID_LEN = 16;
export const NONCE_LEN = 12;
export const DEK_LEN = 32;
/** Bytes de la cabecera autenticados como AAD de la envoltura de la DEK (magic … nonceBase). */
export const HEADER_AAD_LEN = 48;
export const CHUNK_AAD_LEN = 25;

const OFF = Object.freeze({
  magic: 0,
  version: 4,
  kind: 5,
  flags: 6,
  chunkSize: 8,
  plaintextSize: 12,
  fileId: 20,
  nonceBase: 36,
  wrapNonce: 48,
  wrappedDek: 60,
  wrapTag: 92,
});

export interface ObjectHeader {
  kind: ObjectKind;
  plaintextSize: number;
  fileId: Buffer;
  nonceBase: Buffer;
  wrapNonce: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
}

function integrity(reason: string): AppErrorException {
  return new AppErrorException({ code: 'INTEGRITY', details: { reason } });
}

function assertLen(name: string, buf: Uint8Array, len: number): void {
  if (buf.length !== len) throw new RangeError(`${name}: ${len} bytes`);
}

function assertPlaintextSize(p: number): void {
  if (!Number.isSafeInteger(p) || p < 0 || p > MAX_PLAINTEXT) {
    throw new RangeError('plaintextSize fuera de [0, 2^40]');
  }
}

/**
 * Los 48 primeros bytes de la cabecera (AAD de la envoltura). El escritor los necesita antes de
 * envolver la DEK, porque wrapNonce/wrappedDek/wrapTag aún no existen.
 */
export function encodeHeaderAad(
  h: Pick<ObjectHeader, 'kind' | 'plaintextSize' | 'fileId' | 'nonceBase'>,
): Buffer {
  assertPlaintextSize(h.plaintextSize);
  assertLen('fileId', h.fileId, FILE_ID_LEN);
  assertLen('nonceBase', h.nonceBase, NONCE_LEN);
  const out = Buffer.alloc(HEADER_AAD_LEN);
  out.set(MAGIC, OFF.magic);
  out.writeUInt8(VERSION, OFF.version);
  out.writeUInt8(h.kind, OFF.kind);
  out.writeUInt16BE(0, OFF.flags);
  out.writeUInt32BE(CHUNK, OFF.chunkSize);
  out.writeBigUInt64BE(BigInt(h.plaintextSize), OFF.plaintextSize);
  h.fileId.copy(out, OFF.fileId);
  h.nonceBase.copy(out, OFF.nonceBase);
  return out;
}

export function encodeHeader(h: ObjectHeader): Buffer {
  assertLen('wrapNonce', h.wrapNonce, NONCE_LEN);
  assertLen('wrappedDek', h.wrappedDek, DEK_LEN);
  assertLen('wrapTag', h.wrapTag, TAG);
  const out = Buffer.alloc(HEADER_LEN);
  encodeHeaderAad(h).copy(out, 0);
  h.wrapNonce.copy(out, OFF.wrapNonce);
  h.wrappedDek.copy(out, OFF.wrappedDek);
  h.wrapTag.copy(out, OFF.wrapTag);
  return out;
}

/**
 * Validación estructural de la cabecera (§7.2). La autenticidad la da después el desenvolvimiento
 * de la DEK con la AAD [0, 48). Cualquier fallo es INTEGRITY.
 */
export function decodeHeader(buf: Uint8Array): ObjectHeader {
  if (buf.length < HEADER_LEN) throw integrity('header');
  const b = Buffer.from(buf.buffer, buf.byteOffset, HEADER_LEN);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (b[OFF.magic + i] !== MAGIC[i]) throw integrity('header');
  }
  if (b.readUInt8(OFF.version) !== VERSION) throw integrity('header');
  const kind = b.readUInt8(OFF.kind);
  if (kind !== KIND_MEDIA && kind !== KIND_THUMB) throw integrity('header');
  if (b.readUInt16BE(OFF.flags) !== 0) throw integrity('header');
  if (b.readUInt32BE(OFF.chunkSize) !== CHUNK) throw integrity('header');
  const p = b.readBigUInt64BE(OFF.plaintextSize);
  if (p > BigInt(MAX_PLAINTEXT)) throw integrity('header');
  const slice = (off: number, len: number): Buffer => Buffer.from(b.subarray(off, off + len));
  return {
    kind,
    plaintextSize: Number(p),
    fileId: slice(OFF.fileId, FILE_ID_LEN),
    nonceBase: slice(OFF.nonceBase, NONCE_LEN),
    wrapNonce: slice(OFF.wrapNonce, NONCE_LEN),
    wrappedDek: slice(OFF.wrappedDek, DEK_LEN),
    wrapTag: slice(OFF.wrapTag, TAG),
  };
}

/** n = 1 si P = 0 (un chunk final vacío); si no, ceil(P / CHUNK). */
export function chunkCount(plaintextSize: number): number {
  assertPlaintextSize(plaintextSize);
  return plaintextSize === 0 ? 1 : Math.ceil(plaintextSize / CHUNK);
}

/** Bytes de plaintext del chunk i: CHUNK salvo el último, que vale CHUNK si P es múltiplo exacto. */
export function chunkLen(plaintextSize: number, i: number): number {
  const n = chunkCount(plaintextSize);
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError('chunk fuera de rango');
  return i < n - 1 ? CHUNK : plaintextSize - (n - 1) * CHUNK;
}

/** Offset del chunk i en el archivo. Ocupa chunkLen + TAG bytes. */
export function chunkOffset(i: number): number {
  if (!Number.isInteger(i) || i < 0) throw new RangeError('chunk fuera de rango');
  return HEADER_LEN + i * CHUNK_CT;
}

/** L = HEADER_LEN + P + TAG · n. */
export function fileLength(plaintextSize: number): number {
  return HEADER_LEN + plaintextSize + TAG * chunkCount(plaintextSize);
}

/** nonce_i = nonceBase XOR (0x00000000 ‖ uint64_be(i)): XOR sobre los bytes 4..11. */
export function chunkNonce(nonceBase: Uint8Array, i: number): Buffer {
  assertLen('nonceBase', nonceBase, NONCE_LEN);
  if (!Number.isSafeInteger(i) || i < 0) throw new RangeError('chunk fuera de rango');
  const out = Buffer.alloc(NONCE_LEN);
  out.set(nonceBase);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(i));
  for (let k = 0; k < 8; k += 1) out[4 + k] = (out[4 + k] as number) ^ (counter[k] as number);
  return out;
}

/** AAD del chunk i (25 bytes): fileId (16) ‖ uint64_be(i) (8) ‖ final (1). */
export function chunkAad(fileId: Uint8Array, i: number, final: boolean): Buffer {
  assertLen('fileId', fileId, FILE_ID_LEN);
  if (!Number.isSafeInteger(i) || i < 0) throw new RangeError('chunk fuera de rango');
  const out = Buffer.alloc(CHUNK_AAD_LEN);
  out.set(fileId, 0);
  out.writeBigUInt64BE(BigInt(i), FILE_ID_LEN);
  out.writeUInt8(final ? 1 : 0, FILE_ID_LEN + 8);
  return out;
}
