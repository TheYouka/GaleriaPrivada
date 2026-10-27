// playlist-repo.ts (docs/DESIGN.md §9.2, §10.2, §10.3, §14.8; PLAN.md 4.1 [H3-4]): crear,
// renombrar, borrar (sin borrar medios), añadir al final con orden estable, `alreadyPresent`,
// PLAYLIST_FULL, quitar y volver a numerar, reordenar (permutación exacta), borrar un medio que está
// en playlists (cascada + posiciones densas) y las operaciones masivas con json_each(?) y 40 000 ids.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/main/db/database';
import { migrate } from '../../../src/main/db/migrate';
import { deleteMedia, listMedia } from '../../../src/main/db/repos/media-repo';
import {
  addItems,
  compactPositions,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  playlistItemIds,
  removeItems,
  renamePlaylist,
  reorderItems,
} from '../../../src/main/db/repos/playlist-repo';
import { playlistHandlers } from '../../../src/main/ipc/handlers/playlists';
import { PLAYLIST_MAX_ITEMS } from '../../../src/shared/constants';
import type { LibraryChangeReason } from '../../../src/shared/types';
import { appErrorOf } from '../helpers/crypto';
import { createDb } from '../helpers/db';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.setConfig({ testTimeout: 60_000 });

const tmp = makeTmpDir('playlist-repo');
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

function nextId(): string {
  seq += 1;
  return seq.toString(16).padStart(32, '0');
}

const INSERT_MEDIA = `INSERT INTO media (id, kind, state, source, name, name_fold, original_ext,
  mime, size_bytes, original_size_bytes, captured_at, captured_at_source, imported_at,
  content_hmac, thumb_id)
  VALUES (?, 'photo', ?, 'import', ?, ?, 'jpg', 'image/jpeg', 1, 1, ?, 'exif', 0, ?, NULL)`;

/** `n` medios (`ready` salvo que se diga otra cosa), en una transacción. */
function addMedia(n: number, state: 'ready' | 'pending' = 'ready'): string[] {
  const insert = db.prepare(INSERT_MEDIA);
  const ids: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const id = nextId();
      insert.run(id, state, `m${seq}`, `m${seq}`, seq, randomBytes(32));
      ids.push(id);
    }
  })();
  return ids;
}

function positions(playlistId: string): { media_id: string; position: number }[] {
  return db
    .prepare(
      'SELECT media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position',
    )
    .all(playlistId) as { media_id: string; position: number }[];
}

function expectDense(playlistId: string): void {
  expect(positions(playlistId).map((r) => r.position)).toEqual(
    positions(playlistId).map((_, i) => i),
  );
}

describe('crear, renombrar, listar y borrar', () => {
  it('crea con nombre (no tiene que ser único), renombra y lista por nombre natural', () => {
    const b = createPlaylist(db, 'Viaje 10', 1000);
    const a = createPlaylist(db, 'viaje 2', 2000);
    const c = createPlaylist(db, 'Ávila', 3000);
    const dup = createPlaylist(db, 'Viaje 10', 4000);
    expect(a).toMatchObject({
      name: 'viaje 2',
      itemCount: 0,
      coverMediaId: null,
      hasCustomPresentation: false,
      updatedAt: 2000,
    });
    expect(listPlaylists(db).map((p) => p.id)).toEqual([c.id, a.id, b.id, dup.id]);
    expect(renamePlaylist(db, a.id, 'Zoológico', 5000)).toMatchObject({
      name: 'Zoológico',
      updatedAt: 5000,
    });
    expect(listPlaylists(db).at(-1)?.id).toBe(a.id);
  });

  it('renombrar o borrar una que no existe → NOT_FOUND', async () => {
    expect((await appErrorOf(() => renamePlaylist(db, nextId(), 'x'))).code).toBe('NOT_FOUND');
    expect((await appErrorOf(() => deletePlaylist(db, nextId()))).code).toBe('NOT_FOUND');
  });

  it('borrar la playlist no borra los medios', () => {
    const ids = addMedia(3);
    const p = createPlaylist(db, 'P');
    addItems(db, p.id, ids);
    deletePlaylist(db, p.id);
    expect(getPlaylist(db, p.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM playlist_items').get()).toEqual({ n: 0 });
    expect(listMedia(db, { kind: 'all', sort: { field: 'captured', dir: 'asc' } })).toHaveLength(3);
  });
});

describe('añadir: orden estable, alreadyPresent y límite', () => {
  it('añade al final en el orden recibido; repetir solo cuenta alreadyPresent', () => {
    const [a, b, c, d] = addMedia(4) as [string, string, string, string];
    const p = createPlaylist(db, 'P', 1);
    expect(addItems(db, p.id, [c, a], { now: 10 })).toEqual({ added: 2, alreadyPresent: 0 });
    expect(addItems(db, p.id, [a, d, b], { now: 20 })).toEqual({ added: 2, alreadyPresent: 1 });
    expect(playlistItemIds(db, p.id)).toEqual([c, a, d, b]);
    expectDense(p.id);
    expect(getPlaylist(db, p.id)).toMatchObject({ itemCount: 4, coverMediaId: c, updatedAt: 20 });
    // El orden no cambia con otras operaciones ni al volver a leer.
    addItems(db, p.id, [a, b], { now: 30 });
    expect(playlistItemIds(db, p.id)).toEqual([c, a, d, b]);
    // La galería filtrada por la playlist, en el orden de la playlist (y al revés).
    const q = (dir: 'asc' | 'desc') =>
      listMedia(db, { kind: 'all', playlistId: p.id, sort: { field: 'position', dir } }).map(
        (m) => m.id,
      );
    expect(q('asc')).toEqual([c, a, d, b]);
    expect(q('desc')).toEqual([b, d, a, c]);
  });

  it('ignora los ids que no existen o no están ready', () => {
    const [a] = addMedia(1) as [string];
    const [pending] = addMedia(1, 'pending') as [string];
    const p = createPlaylist(db, 'P');
    expect(addItems(db, p.id, [nextId(), pending, a])).toEqual({ added: 1, alreadyPresent: 0 });
    expect(playlistItemIds(db, p.id)).toEqual([a]);
  });

  it('playlist inexistente → NOT_FOUND', async () => {
    const ids = addMedia(1);
    expect((await appErrorOf(() => addItems(db, nextId(), ids))).code).toBe('NOT_FOUND');
    expect((await appErrorOf(() => removeItems(db, nextId(), ids))).code).toBe('NOT_FOUND');
    expect((await appErrorOf(() => reorderItems(db, nextId(), ids))).code).toBe('NOT_FOUND');
  });

  it('con el límite real de 2000 → PLAYLIST_FULL sin añadir nada', async () => {
    const ids = addMedia(PLAYLIST_MAX_ITEMS + 1);
    const p = createPlaylist(db, 'P');
    expect(addItems(db, p.id, ids.slice(0, PLAYLIST_MAX_ITEMS - 1)).added).toBe(
      PLAYLIST_MAX_ITEMS - 1,
    );
    // 1999 + 2 = 2001 > 2000: no entra ninguno.
    const full = await appErrorOf(() => addItems(db, p.id, ids.slice(PLAYLIST_MAX_ITEMS - 1)));
    expect(full.code).toBe('PLAYLIST_FULL');
    expect(playlistItemIds(db, p.id)).toHaveLength(PLAYLIST_MAX_ITEMS - 1);
    // Los que ya están no cuentan para el límite: 1999 repetidos + 1 nuevo = 2000 justo.
    expect(
      addItems(db, p.id, [...ids.slice(0, PLAYLIST_MAX_ITEMS - 1), ids[PLAYLIST_MAX_ITEMS - 1]!]),
    ).toEqual({
      added: 1,
      alreadyPresent: PLAYLIST_MAX_ITEMS - 1,
    });
    expect((await appErrorOf(() => addItems(db, p.id, [ids[PLAYLIST_MAX_ITEMS]!]))).code).toBe(
      'PLAYLIST_FULL',
    );
  });

  it('[H3-4] 40 000 ids en una sola llamada (sin límite de prueba), y quitarlos en otra', async () => {
    const N = 40_000;
    const ids = addMedia(N);
    const p = createPlaylist(db, 'Grande');
    const prepare = vi.spyOn(db, 'prepare');
    expect(addItems(db, p.id, ids, { limit: Infinity })).toEqual({ added: N, alreadyPresent: 0 });
    // Ninguna sentencia con un parámetro por id: todo va por json_each(?).
    for (const [sql] of prepare.mock.calls) expect((sql.match(/\?/g) ?? []).length).toBeLessThan(8);
    expect(playlistItemIds(db, p.id)).toEqual(ids);
    expectDense(p.id);
    // Repetirlos: todos alreadyPresent.
    expect(addItems(db, p.id, ids, { limit: Infinity })).toEqual({ added: 0, alreadyPresent: N });
    // Con el límite real, la misma llamada en una playlist vacía → PLAYLIST_FULL.
    const q = createPlaylist(db, 'Otra');
    expect((await appErrorOf(() => addItems(db, q.id, ids))).code).toBe('PLAYLIST_FULL');
    // Quitar 39 999 en una llamada: queda uno, en la posición 0.
    expect(removeItems(db, p.id, ids.slice(1))).toEqual({ removed: N - 1 });
    expect(positions(p.id)).toEqual([{ media_id: ids[0], position: 0 }]);
    prepare.mockRestore();
  });
});

describe('quitar y reordenar', () => {
  it('quitar renumera sin huecos y conserva el orden relativo', () => {
    const ids = addMedia(6);
    const p = createPlaylist(db, 'P');
    addItems(db, p.id, ids);
    expect(removeItems(db, p.id, [ids[1]!, ids[4]!, nextId()])).toEqual({ removed: 2 });
    expect(playlistItemIds(db, p.id)).toEqual([ids[0], ids[2], ids[3], ids[5]]);
    expectDense(p.id);
    expect(removeItems(db, p.id, [ids[1]!])).toEqual({ removed: 0 });
  });

  it('reordenar con la permutación exacta reescribe position densa', () => {
    const [a, b, c, d] = addMedia(4) as [string, string, string, string];
    const p = createPlaylist(db, 'P');
    addItems(db, p.id, [a, b, c, d]);
    reorderItems(db, p.id, [d, b, a, c], 99);
    expect(playlistItemIds(db, p.id)).toEqual([d, b, a, c]);
    expectDense(p.id);
    expect(getPlaylist(db, p.id)?.updatedAt).toBe(99);
  });

  it('una permutación incompleta, con extras, repetidos u otra playlist → VALIDATION sin cambios', async () => {
    const [a, b, c, other] = addMedia(4) as [string, string, string, string];
    const p = createPlaylist(db, 'P');
    addItems(db, p.id, [a, b, c]);
    for (const bad of [[a, b], [a, b, c, other], [a, b, b], [a, b, other], []]) {
      const err = await appErrorOf(() => reorderItems(db, p.id, bad));
      expect(err.code).toBe('VALIDATION');
      expect(err.reason).toBe('permutation');
    }
    expect(playlistItemIds(db, p.id)).toEqual([a, b, c]);
    // La playlist vacía admite la permutación vacía.
    const empty = createPlaylist(db, 'Vacía');
    reorderItems(db, empty.id, []);
  });
});

describe('borrar un medio que está en playlists (§12.10)', () => {
  it('la cascada lo quita de todas sus playlists y las posiciones quedan densas', () => {
    const ids = addMedia(5);
    const p = createPlaylist(db, 'P');
    const q = createPlaylist(db, 'Q');
    addItems(db, p.id, ids);
    addItems(db, q.id, [ids[2]!, ids[0]!]);
    const untouched = createPlaylist(db, 'R');
    addItems(db, untouched.id, [ids[4]!]);

    expect(
      deleteMedia(db, [ids[0]!, ids[2]!])
        .map((d) => d.id)
        .sort(),
    ).toEqual([ids[0], ids[2]].sort());
    expect(playlistItemIds(db, p.id)).toEqual([ids[1], ids[3], ids[4]]);
    expectDense(p.id);
    expect(playlistItemIds(db, q.id)).toEqual([]);
    expect(getPlaylist(db, q.id)).toMatchObject({ itemCount: 0, coverMediaId: null });
    expect(positions(untouched.id)).toEqual([{ media_id: ids[4], position: 0 }]);
    // Después se puede reordenar y añadir sin huecos ni choques.
    reorderItems(db, p.id, [ids[4]!, ids[1]!, ids[3]!]);
    addItems(db, p.id, [ids[2]!]); // ya no existe: se ignora
    expect(playlistItemIds(db, p.id)).toEqual([ids[4], ids[1], ids[3]]);
  });

  it('la portada es el primer elemento ready y la cuenta ignora los pending', () => {
    const [a, b] = addMedia(2) as [string, string];
    const p = createPlaylist(db, 'P');
    addItems(db, p.id, [a, b]);
    db.prepare("UPDATE media SET state = 'pending' WHERE id = ?").run(a);
    expect(getPlaylist(db, p.id)).toMatchObject({ itemCount: 1, coverMediaId: b });
  });

  it('compactPositions conserva el orden con huecos arbitrarios', () => {
    const ids = addMedia(3);
    const p = createPlaylist(db, 'P');
    addItems(db, p.id, ids);
    db.prepare('UPDATE playlist_items SET position = position * 7 + 3 WHERE playlist_id = ?').run(
      p.id,
    );
    compactPositions(db, [p.id]);
    expect(positions(p.id)).toEqual(ids.map((media_id, position) => ({ media_id, position })));
  });
});

describe('handlers (cuerpos sin ipcMain)', () => {
  it('emiten library:changed { reason: playlist } solo cuando cambian los elementos', () => {
    const events: LibraryChangeReason[] = [];
    const session = { epoch: 1, getDb: () => db };
    const h = playlistHandlers({
      session,
      library: { changed: (reason) => events.push(reason) },
      now: () => 5,
    });
    const ids = addMedia(2);
    const p = h.create({ name: 'P' });
    h.rename({ id: p.id, name: 'Q' });
    expect(events).toEqual([]);
    expect(h.addItems({ id: p.id, mediaIds: ids })).toEqual({ added: 2, alreadyPresent: 0 });
    h.addItems({ id: p.id, mediaIds: ids }); // nada nuevo: sin evento
    h.reorder({ id: p.id, mediaIds: [ids[1]!, ids[0]!] });
    expect(h.removeItems({ id: p.id, mediaIds: [ids[0]!] })).toEqual({ removed: 1 });
    h.delete({ id: p.id });
    expect(events).toEqual(['playlist', 'playlist', 'playlist', 'playlist']);
    expect(h.list()).toEqual([]);
  });
});
