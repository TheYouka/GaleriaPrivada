// Ayudas de los tests de crypto: claves aleatorias, escritura en trozos y comprobación de AppError.
import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import { KIND_MEDIA, type ObjectKind } from '../../../src/main/crypto/file-format';
import {
  createObjectWriter,
  type ObjectWriterResult,
  type WriterIo,
} from '../../../src/main/crypto/object-writer';

export const MiB = 1024 * 1024;

export function randomKey(): Buffer {
  return randomBytes(32);
}

export function randomFileId(): Buffer {
  return randomBytes(16);
}

/** Trozos de tamaños aleatorios (1 B … 3 chunks) que cubren `data` entero. */
export function randomPieces(data: Buffer): Buffer[] {
  const pieces: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const max = Math.min(data.length - off, 3 * 65536 + 7);
    const n = randomInt(1, max + 1);
    pieces.push(data.subarray(off, off + n));
    off += n;
  }
  return pieces;
}

export interface WrittenObject {
  path: string;
  fileId: Buffer;
  kind: ObjectKind;
  result: ObjectWriterResult;
}

/** Cifra `plaintext` en `dir/<fileId hex>` escribiendo en trozos aleatorios. */
export async function writeObject(
  dir: string,
  plaintext: Buffer,
  kWrap: Buffer,
  options: { kind?: ObjectKind; fileId?: Buffer; hmacKey?: Buffer; io?: WriterIo } = {},
): Promise<WrittenObject> {
  const fileId = options.fileId ?? randomFileId();
  const kind = options.kind ?? KIND_MEDIA;
  const path = join(dir, fileId.toString('hex'));
  const writer = createObjectWriter(
    { kind, fileId, kWrap, tmpPath: path, hmacKey: options.hmacKey },
    options.io,
  );
  for (const piece of randomPieces(plaintext)) await writer.write(piece);
  const result = await writer.finish();
  return { path, fileId, kind, result };
}

export async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** El código de AppError con que rechaza (o lanza) `fn`; falla si no es un AppErrorException. */
export async function appErrorOf(
  fn: () => unknown,
): Promise<{ code: ErrorCode; reason?: unknown }> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppErrorException);
    const e = (err as AppErrorException).error;
    return { code: e.code, reason: e.details?.reason };
  }
  throw new Error('se esperaba un AppError y no hubo error');
}

export function isAllZero(buf: Uint8Array): boolean {
  return buf.every((b) => b === 0);
}
