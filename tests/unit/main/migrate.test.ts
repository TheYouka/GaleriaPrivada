// Migraciones (docs/DESIGN.md §9.3): v1, fallo con ROLLBACK y .bak conservado, y DB más nueva.
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/main/db/database';
import { backupPath, latestVersion, migrate, userVersion } from '../../../src/main/db/migrate';
import { MIGRATIONS, type Migration } from '../../../src/main/db/migrations';
import { appErrorOf } from '../helpers/crypto';
import { createDb, fileDigest } from '../helpers/db';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('migrate');
afterAll(() => removeTmpDir(tmp));

function fresh(): { db: Db; path: string } {
  return createDb(mkdtempSync(join(tmp, 'd-')));
}

function tables(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[]
  ).filter((n) => !n.startsWith('sqlite_'));
}

describe('migrate', () => {
  it('aplica el esquema v1 con user_version = 1 y borra el .bak', () => {
    const { db, path } = fresh();
    expect(userVersion(db)).toBe(0);
    migrate(db, path);
    expect(userVersion(db)).toBe(1);
    expect(latestVersion()).toBe(1);
    expect(tables(db)).toEqual([
      'kv',
      'media',
      'media_edits',
      'media_exif',
      'music_tracks',
      'playlist_items',
      'playlist_music',
      'playlists',
    ]);
    expect(existsSync(backupPath(path, 0))).toBe(false);
    // STRICT y CHECK de §9.2 activos.
    expect(() =>
      db.prepare("INSERT INTO playlists VALUES ('corto', 'x', 'x', 0, 0, NULL)").run(),
    ).toThrow();
    db.close();
  });

  it('es idempotente: con user_version = última no hace nada', () => {
    const { db, path } = fresh();
    migrate(db, path);
    const before = fileDigest(path);
    migrate(db, path);
    expect(fileDigest(path)).toBe(before);
    expect(existsSync(backupPath(path, 1))).toBe(false);
    db.close();
  });

  it('una migración que falla hace ROLLBACK, conserva el .bak-v0 y da VAULT_CORRUPT { migration }', async () => {
    const { db, path } = fresh();
    const broken: Migration[] = [
      ...MIGRATIONS,
      { version: 2, sql: 'CREATE TABLE nueva (x INTEGER); CREATE TABLE rota (' },
    ];
    const err = await appErrorOf(() => migrate(db, path, broken));
    expect(err.code).toBe('VAULT_CORRUPT');
    expect(userVersion(db)).toBe(0);
    expect(tables(db)).toEqual([]); // ni v1 ni la primera sentencia de v2
    expect(db.inTransaction).toBe(false);
    expect(existsSync(backupPath(path, 0))).toBe(true);
    db.close();
  });

  it('el detalle del fallo es stage: migration', async () => {
    const { db, path } = fresh();
    try {
      migrate(db, path, [{ version: 1, sql: 'SELECT * FROM no_existe' }]);
      expect.unreachable();
    } catch (e) {
      expect((e as { error: unknown }).error).toEqual({
        code: 'VAULT_CORRUPT',
        details: { stage: 'migration' },
      });
    }
    db.close();
  });

  it('una DB con user_version mayor → VAULT_CORRUPT { newer-version } sin tocar el archivo', () => {
    const { db, path } = fresh();
    migrate(db, path);
    db.pragma('user_version = 7');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const before = fileDigest(path);
    try {
      migrate(db, path);
      expect.unreachable();
    } catch (e) {
      expect((e as { error: unknown }).error).toEqual({
        code: 'VAULT_CORRUPT',
        details: { stage: 'newer-version' },
      });
    }
    expect(fileDigest(path)).toBe(before);
    expect(userVersion(db)).toBe(7);
    expect(existsSync(backupPath(path, 7))).toBe(false);
    db.close();
  });

  it('de v1 a v2 copia library.db.bak-v1 y lo borra al terminar', () => {
    const { db, path } = fresh();
    migrate(db, path);
    migrate(db, path, [...MIGRATIONS, { version: 2, sql: 'CREATE TABLE extra (x INTEGER)' }]);
    expect(userVersion(db)).toBe(2);
    expect(tables(db)).toContain('extra');
    expect(existsSync(backupPath(path, 1))).toBe(false);
    db.close();
  });
});
