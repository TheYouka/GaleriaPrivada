// Tabla kv con claves cerradas (docs/DESIGN.md §9.2).
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/main/db/database';
import { migrate } from '../../../src/main/db/migrate';
import {
  KV_DEFAULT_TRACKS,
  importReplaceKey,
  isKvKey,
  kvDelete,
  kvGet,
  kvSet,
  type KvKey,
} from '../../../src/main/db/repos/kv-repo';
import { appErrorOf } from '../helpers/crypto';
import { createDb } from '../helpers/db';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('kv-repo');
afterAll(() => removeTmpDir(tmp));

const id = (): string => randomBytes(16).toString('hex');
let db: Db;

beforeEach(() => {
  const created = createDb(mkdtempSync(join(tmp, 'd-')));
  migrate(created.db, created.path);
  db = created.db;
  return () => db.close();
});

function count(): number {
  return db.prepare('SELECT count(*) FROM kv').pluck().get() as number;
}

describe('kv-repo', () => {
  it('presentation.defaultTracks: guarda, sustituye, lee y borra', () => {
    expect(kvGet(db, KV_DEFAULT_TRACKS)).toBeNull();
    const a = [id(), id()];
    kvSet(db, KV_DEFAULT_TRACKS, a);
    expect(kvGet(db, KV_DEFAULT_TRACKS)).toEqual(a);
    const b = [id()];
    kvSet(db, KV_DEFAULT_TRACKS, b);
    expect(kvGet(db, KV_DEFAULT_TRACKS)).toEqual(b);
    expect(count()).toBe(1);
    expect(kvDelete(db, KV_DEFAULT_TRACKS)).toBe(true);
    expect(kvGet(db, KV_DEFAULT_TRACKS)).toBeNull();
  });

  it('import.replace.<newId>: { old, hmac } en minúsculas', () => {
    const key = importReplaceKey(id());
    const value = { old: id(), hmac: randomBytes(32).toString('hex') };
    kvSet(db, key, value);
    expect(kvGet(db, key)).toEqual(value);
  });

  it('rechaza claves desconocidas sin escribir', async () => {
    expect(isKvKey('otra.cosa')).toBe(false);
    expect(isKvKey(`import.replace.${id().toUpperCase()}`)).toBe(false);
    for (const key of ['otra.cosa', 'import.replace.corto', 'presentation.defaultTracks.x']) {
      const err = await appErrorOf(() => kvSet(db, key as KvKey, [] as never));
      expect(err).toEqual({ code: 'VALIDATION', reason: 'kv-key' });
      expect((await appErrorOf(() => kvGet(db, key as KvKey))).code).toBe('VALIDATION');
    }
    expect(() => importReplaceKey('no-es-un-id')).toThrow();
    expect(count()).toBe(0);
  });

  it('rechaza valores que no validan sin escribir', async () => {
    const bad: [KvKey, unknown][] = [
      [KV_DEFAULT_TRACKS, ['no-es-un-id']],
      [KV_DEFAULT_TRACKS, Array.from({ length: 101 }, id)],
      [
        KV_DEFAULT_TRACKS,
        (() => {
          const x = id();
          return [x, x];
        })(),
      ],
      [KV_DEFAULT_TRACKS, 'texto'],
      [importReplaceKey(id()), { old: id(), hmac: randomBytes(32).toString('hex').toUpperCase() }],
      [importReplaceKey(id()), { old: id(), hmac: 'ab' }],
      [importReplaceKey(id()), { old: id(), hmac: randomBytes(32).toString('hex'), extra: 1 }],
    ];
    for (const [key, value] of bad) {
      const err = await appErrorOf(() => kvSet(db, key, value as never));
      expect(err).toEqual({ code: 'VALIDATION', reason: 'kv-value' });
    }
    expect(count()).toBe(0);
  });

  it('un valor guardado que no valida se lee como ausente', () => {
    db.prepare('INSERT INTO kv (key, value_json) VALUES (?, ?)').run(KV_DEFAULT_TRACKS, '["x"]');
    expect(kvGet(db, KV_DEFAULT_TRACKS)).toBeNull();
    db.prepare('UPDATE kv SET value_json = ? WHERE key = ?').run('{no es json', KV_DEFAULT_TRACKS);
    expect(kvGet(db, KV_DEFAULT_TRACKS)).toBeNull();
  });
});
