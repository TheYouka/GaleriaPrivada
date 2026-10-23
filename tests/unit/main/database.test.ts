// Apertura cifrada de la DB (docs/DESIGN.md §9.1): los cuatro casos obligatorios de la Fase 1.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  RAW_KEY_ARG_LEN,
  closeDatabase,
  openDatabase,
  rawKeyArg,
} from '../../../src/main/db/database';
import { log } from '../../../src/main/log';
import { appErrorOf, isAllZero } from '../helpers/crypto';
import { createDb, newKey } from '../helpers/db';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('database');
afterAll(() => removeTmpDir(tmp));
afterEach(() => vi.restoreAllMocks());

function newDir(): string {
  return mkdtempSync(join(tmp, 'd-'));
}

describe('rawKeyArg', () => {
  it("escribe x'<64 hex>' (67 bytes) sin strings con la clave", () => {
    const key = randomBytes(32);
    const arg = rawKeyArg(key);
    expect(arg).toHaveLength(RAW_KEY_ARG_LEN);
    expect(arg.toString('latin1')).toBe(`x'${key.toString('hex')}'`);
  });

  it('rechaza claves que no son de 32 bytes', () => {
    expect(() => rawKeyArg(Buffer.alloc(31))).toThrow(RangeError);
  });
});

describe('openDatabase', () => {
  it('crea la DB con la clave, la cierra y la vuelve a abrir', () => {
    const dir = newDir();
    const { db, path, key } = createDb(dir);
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('hola');
    db.close();

    const again = openDatabase(path, key, { creating: false });
    expect(again.prepare('SELECT v FROM t').pluck().get()).toBe('hola');
    expect(again.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(again.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(again.pragma('temp_store', { simple: true })).toBe(2); // MEMORY
    expect(again.pragma('secure_delete', { simple: true })).toBe(1);
    again.close();
    // La clave pertenece al KeyRing: openDatabase no la pone a cero.
    expect(isAllZero(key)).toBe(false);
  });

  it('con una clave incorrecta, SQLITE_NOTADB → VAULT_CORRUPT { stage: open }', async () => {
    const dir = newDir();
    const { db, path } = createDb(dir);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
    const errors = vi.spyOn(log, 'error');
    const err = await appErrorOf(() => openDatabase(path, newKey(), { creating: false }));
    expect(err.code).toBe('VAULT_CORRUPT');
    expect(errors).toHaveBeenCalledWith('db.open-failed', {
      errno: 'SQLITE_NOTADB',
      stage: 'open',
    });
  });

  it('los 16 primeros bytes del archivo no son "SQLite format 3\\0"', () => {
    const dir = newDir();
    const { db, path } = createDb(dir);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
    const head = readFileSync(path).subarray(0, 16).toString('latin1');
    expect(head).not.toBe('SQLite format 3\0');
  });

  it('un string insertado no aparece en los bytes del archivo ni del -wal', () => {
    const dir = newDir();
    const { db, path } = createDb(dir);
    const marker = `MARCADOR-${randomBytes(12).toString('hex')}`;
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run(marker);
    // Con la DB abierta, el dato está en el -wal; tras cerrar, en el archivo principal.
    expect(existsSync(`${path}-wal`)).toBe(true);
    const needle = Buffer.from(marker, 'utf8');
    expect(readFileSync(path).includes(needle)).toBe(false);
    expect(readFileSync(`${path}-wal`).includes(needle)).toBe(false);
    closeDatabase(db);
    expect(readFileSync(path).includes(needle)).toBe(false);
    if (existsSync(`${path}-wal`)) expect(readFileSync(`${path}-wal`).includes(needle)).toBe(false);
  });

  it('sin `creating` y sin archivo → IO, sin crear nada', async () => {
    const dir = newDir();
    const path = join(dir, 'library.db');
    const err = await appErrorOf(() => openDatabase(path, newKey(), { creating: false }));
    expect(err.code).toBe('IO');
    expect(existsSync(path)).toBe(false);
  });

  it('closeDatabase no lanza con una DB ya cerrada o null', () => {
    const dir = newDir();
    const { db } = createDb(dir);
    db.close();
    expect(() => closeDatabase(db)).not.toThrow();
    expect(() => closeDatabase(null)).not.toThrow();
  });
});
