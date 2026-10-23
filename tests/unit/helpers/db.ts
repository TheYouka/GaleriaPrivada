// Ayudas de los tests de la DB: carpeta temporal con una DB SQLCipher recién creada.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../../src/main/db/database';

export function newKey(): Buffer {
  return randomBytes(32);
}

export function createDb(
  dir: string,
  key: Buffer = newKey(),
): { db: Db; path: string; key: Buffer } {
  const path = join(dir, 'library.db');
  const db = openDatabase(path, key, { creating: true });
  return { db, path, key };
}

/** SHA-256 del archivo (y de su -wal si existe). */
export function fileDigest(path: string): string {
  const h = createHash('sha256').update(readFileSync(path));
  if (existsSync(`${path}-wal`)) h.update(readFileSync(`${path}-wal`));
  return h.digest('hex');
}
