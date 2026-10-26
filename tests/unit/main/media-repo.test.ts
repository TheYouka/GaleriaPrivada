// media-repo.ts (docs/DESIGN.md §9.2, §10.2, §12.10; PLAN.md 2.5 [H3-4]).
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/main/db/database';
import { migrate } from '../../../src/main/db/migrate';
import {
  deleteMedia,
  deletePending,
  findByHmac,
  findReady,
  getMedia,
  insertPending,
  likePattern,
  listMedia,
  markReady,
  renameMedia,
  type NewMedia,
} from '../../../src/main/db/repos/media-repo';
import type { MediaQuery, MediaSort } from '../../../src/shared/types';
import { appErrorOf } from '../helpers/crypto';
import { createDb } from '../helpers/db';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('media-repo');
afterAll(() => removeTmpDir(tmp));

let db: Db;
let seq = 0;

beforeEach(() => {
  const created = createDb(mkdtempSync(join(tmp, 'd-')));
  migrate(created.db, created.path);
  db = created.db;
  seq = 0;
  return () => db.close();
});

/** id determinista y ordenable: el sufijo hex sigue el orden de creación. */
function nextId(): string {
  seq += 1;
  return seq.toString(16).padStart(32, '0');
}

function media(over: Partial<NewMedia> = {}): NewMedia {
  return {
    id: nextId(),
    kind: 'photo',
    source: 'import',
    name: 'foto',
    originalExt: 'jpg',
    mime: 'image/jpeg',
    sizeBytes: 100,
    originalSizeBytes: 100,
    width: 640,
    height: 480,
    durationMs: null,
    fps: null,
    hasAudio: null,
    videoCodec: null,
    audioCodec: null,
    converted: false,
    capturedAt: Date.UTC(2024, 0, 1),
    capturedAtSource: 'exif',
    importedAt: Date.UTC(2025, 0, 1),
    contentHmac: randomBytes(32),
    thumbId: null,
    ...over,
  };
}

function addReady(over: Partial<NewMedia> = {}): NewMedia {
  const m = media(over);
  insertPending(db, m);
  expect(markReady(db, m.id)).toBe(true);
  return m;
}

const q = (sort: MediaSort, extra: Partial<MediaQuery> = {}): MediaQuery => ({
  kind: 'all',
  sort,
  ...extra,
});
const ids = (query: MediaQuery): string[] => listMedia(db, query).map((i) => i.id);

describe('importación: pending → ready', () => {
  it('insertPending crea una fila pending invisible para la galería; markReady la muestra', () => {
    const m = media({ name: 'Ñandú' });
    insertPending(db, m, {
      cameraMake: 'Marca',
      cameraModel: 'Modelo',
      lensModel: null,
      fNumber: 1.8,
      exposureS: 0.01,
      iso: 100,
      focalMm: 4.2,
      orientation: 6,
      gpsLat: null,
      gpsLon: null,
      tzOffsetMin: 120,
      rawJson: '{}',
    });
    expect(listMedia(db, q({ field: 'captured', dir: 'desc' }))).toEqual([]);
    expect(findReady(db, m.id)).toBeNull();
    expect(findByHmac(db, m.contentHmac)).toEqual({ id: m.id, state: 'pending', converted: false });
    expect(markReady(db, m.id)).toBe(true);
    expect(markReady(db, m.id)).toBe(false);
    expect(findReady(db, m.id)).toEqual({ mime: 'image/jpeg', thumbId: null });
    const detail = getMedia(db, m.id);
    expect(detail).toMatchObject({
      id: m.id,
      name: 'Ñandú',
      ext: 'jpg',
      converted: false,
      exif: { cameraMake: 'Marca', fNumber: 1.8, iso: 100 },
      edits: [],
    });
    expect(detail?.exif).not.toHaveProperty('lensModel');
  });

  it('content_hmac repetido → SQLITE_CONSTRAINT_UNIQUE; deletePending solo borra pending', () => {
    const a = addReady();
    const dup = media({ contentHmac: a.contentHmac });
    let code: unknown;
    try {
      insertPending(db, dup);
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(findReady(db, dup.id)).toBeNull();
    expect(deletePending(db, a.id)).toBe(false);
    const p = media();
    insertPending(db, p);
    expect(deletePending(db, p.id)).toBe(true);
  });
});

describe('listMedia: filtros', () => {
  it('tipo, fechas (captured_at) y solo filas ready', () => {
    const photo = addReady({ capturedAt: 1000 });
    const video = addReady({ kind: 'video', durationMs: 5000, capturedAt: 2000 });
    insertPending(db, media({ capturedAt: 1500 }));
    const sort: MediaSort = { field: 'captured', dir: 'asc' };
    expect(ids(q(sort))).toEqual([photo.id, video.id]);
    expect(ids(q(sort, { kind: 'photo' }))).toEqual([photo.id]);
    expect(ids(q(sort, { kind: 'video' }))).toEqual([video.id]);
    expect(ids(q(sort, { dateFrom: 1001 }))).toEqual([video.id]);
    expect(ids(q(sort, { dateTo: 1000 }))).toEqual([photo.id]);
    expect(ids(q(sort, { dateFrom: 1000, dateTo: 2000 }))).toEqual([photo.id, video.id]);
  });

  it('búsqueda con pliegue de acentos y mayúsculas', () => {
    const a = addReady({ name: 'Cumpleaños de MAMÁ' });
    const b = addReady({ name: 'Playa' });
    const sort: MediaSort = { field: 'captured', dir: 'asc' };
    expect(ids(q(sort, { search: 'mama' }))).toEqual([a.id]);
    expect(ids(q(sort, { search: 'CUMPLEANOS' }))).toEqual([a.id]);
    expect(ids(q(sort, { search: 'A\u0301' }))).toEqual([a.id, b.id]);
    expect(ids(q(sort, { search: 'zzz' }))).toEqual([]);
    expect(ids(q(sort, { search: '' }))).toEqual([a.id, b.id]);
  });

  it('%, _ y \\ se buscan literalmente', () => {
    const pct = addReady({ name: '100% real' });
    const under = addReady({ name: 'a_b' });
    const slash = addReady({ name: 'c\\d' });
    addReady({ name: 'axb 100 real' });
    const sort: MediaSort = { field: 'captured', dir: 'asc' };
    expect(ids(q(sort, { search: '%' }))).toEqual([pct.id]);
    expect(ids(q(sort, { search: '_' }))).toEqual([under.id]);
    expect(ids(q(sort, { search: '\\' }))).toEqual([slash.id]);
    expect(likePattern('50%_\\')).toBe('%50\\%\\_\\\\%');
  });

  it('playlistId y orden por posición', () => {
    const a = addReady();
    const b = addReady();
    addReady();
    const pl = nextId();
    db.prepare(
      'INSERT INTO playlists (id, name, name_fold, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
    ).run(pl, 'Lista', 'lista');
    const add = db.prepare(
      'INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES (?, ?, ?, 0)',
    );
    add.run(pl, b.id, 0);
    add.run(pl, a.id, 1);
    expect(ids(q({ field: 'position', dir: 'asc' }, { playlistId: pl }))).toEqual([b.id, a.id]);
    expect(ids(q({ field: 'position', dir: 'desc' }, { playlistId: pl }))).toEqual([a.id, b.id]);
    expect(ids(q({ field: 'captured', dir: 'asc' }, { playlistId: pl }))).toEqual([a.id, b.id]);
  });

  it("'position' sin playlistId → VALIDATION", async () => {
    expect((await appErrorOf(() => listMedia(db, q({ field: 'position', dir: 'asc' })))).code).toBe(
      'VALIDATION',
    );
  });
});

describe('listMedia: orden total', () => {
  it('captured, imported y size con empates resueltos por id, en los dos sentidos', () => {
    const a = addReady({ capturedAt: 5, importedAt: 7, sizeBytes: 9 });
    const b = addReady({ capturedAt: 5, importedAt: 7, sizeBytes: 9 });
    const c = addReady({ capturedAt: 1, importedAt: 1, sizeBytes: 1 });
    for (const field of ['captured', 'imported', 'size'] as const) {
      expect(ids(q({ field, dir: 'asc' }))).toEqual([c.id, a.id, b.id]);
      expect(ids(q({ field, dir: 'desc' }))).toEqual([b.id, a.id, c.id]);
    }
  });

  it('duration: las fotos (NULL) van al final en los dos sentidos', () => {
    const p1 = addReady();
    const v1 = addReady({ kind: 'video', durationMs: 3000 });
    const v2 = addReady({ kind: 'video', durationMs: 1000 });
    const p2 = addReady();
    const v3 = addReady({ kind: 'video', durationMs: 1000 });
    expect(ids(q({ field: 'duration', dir: 'asc' }))).toEqual([v2.id, v3.id, v1.id, p1.id, p2.id]);
    expect(ids(q({ field: 'duration', dir: 'desc' }))).toEqual([v1.id, v3.id, v2.id, p2.id, p1.id]);
  });

  it('name: orden natural en español, sin distinguir acentos; desempate imported_at e id', () => {
    const f10 = addReady({ name: 'foto 10' });
    const f2 = addReady({ name: 'foto 2' });
    const arbolNew = addReady({ name: 'árbol', importedAt: 20 });
    const arbolOld = addReady({ name: 'Arbol', importedAt: 10 });
    const arbolTie = addReady({ name: 'arbol', importedAt: 10 });
    const nino = addReady({ name: 'niño' });
    const nube = addReady({ name: 'nube' });
    const zeta = addReady({ name: 'zeta' });
    const asc = [arbolOld.id, arbolTie.id, arbolNew.id, f2.id, f10.id, nino.id, nube.id, zeta.id];
    expect(ids(q({ field: 'name', dir: 'asc' }))).toEqual(asc);
    expect(ids(q({ field: 'name', dir: 'desc' }))).toEqual([...asc].reverse());
  });
});

describe('rename', () => {
  it('cambia el nombre y su pliegue; NOT_FOUND si no hay fila ready', async () => {
    const m = addReady({ name: 'viejo' });
    const item = renameMedia(db, m.id, 'Verano en Cádiz');
    expect(item).toMatchObject({ id: m.id, name: 'Verano en Cádiz' });
    expect(ids(q({ field: 'captured', dir: 'asc' }, { search: 'cadiz' }))).toEqual([m.id]);
    expect((await appErrorOf(() => renameMedia(db, nextId(), 'x'))).code).toBe('NOT_FOUND');
    const p = media();
    insertPending(db, p);
    expect((await appErrorOf(() => renameMedia(db, p.id, 'x'))).code).toBe('NOT_FOUND');
  });
});

describe('deleteMedia [H3-4]', () => {
  it('devuelve objetos y miniaturas, borra en cascada y no toca filas pending', () => {
    const thumb = nextId();
    const a = addReady({ thumbId: thumb });
    const b = addReady();
    const keep = addReady();
    const pending = media();
    insertPending(db, pending);
    const pl = nextId();
    db.prepare(
      'INSERT INTO playlists (id, name, name_fold, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
    ).run(pl, 'L', 'l');
    db.prepare(
      'INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES (?, ?, 0, 0)',
    ).run(pl, a.id);
    db.prepare(
      'INSERT INTO media_edits (media_id, seq, op_json, created_at) VALUES (?, 0, ?, 0)',
    ).run(a.id, '{"t":"flipH"}');
    const deleted = deleteMedia(db, [a.id, b.id, pending.id, nextId()]);
    expect(deleted.sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([
      { id: a.id, thumbId: thumb },
      { id: b.id, thumbId: null },
    ]);
    expect(ids(q({ field: 'captured', dir: 'asc' }))).toEqual([keep.id]);
    expect(db.prepare('SELECT count(*) FROM playlist_items').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM media_edits').pluck().get()).toBe(0);
    expect(findByHmac(db, pending.contentHmac)?.state).toBe('pending');
  });

  it('borrar 40 000 filas en una sola llamada funciona (IN (?, ?, …) daría "too many SQL variables")', () => {
    const N = 40_000;
    const all: string[] = [];
    const insert = db.prepare(
      `INSERT INTO media (id, kind, state, source, name, name_fold, original_ext, mime, size_bytes,
       original_size_bytes, captured_at, captured_at_source, imported_at, content_hmac, thumb_id)
       VALUES (?, 'photo', 'ready', 'import', 'f', 'f', 'jpg', 'image/jpeg', 1, 1, 0, 'exif', 0, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < N; i += 1) {
        const id = nextId();
        all.push(id);
        insert.run(id, randomBytes(32), nextId());
      }
    })();
    const survivor = addReady();
    // Control: la forma con un parámetro por id no se puede ni preparar.
    expect(() =>
      db.prepare(`SELECT id FROM media WHERE id IN (${all.map(() => '?').join(',')})`),
    ).toThrow(/too many SQL variables/);
    const deleted = deleteMedia(db, all);
    expect(deleted).toHaveLength(N);
    expect(deleted.every((d) => d.thumbId !== null)).toBe(true);
    expect(db.prepare('SELECT count(*) FROM media').pluck().get()).toBe(1);
    expect(findReady(db, survivor.id)).not.toBeNull();
    // Timeout explícito: con la CPU cargada (ffmpeg/sharp en paralelo) supera los 5 s por defecto.
  }, 60_000);
});
