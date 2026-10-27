// Repositorio de playlists (docs/DESIGN.md §9.2, §10.2, §10.3 y §14.8). P6: funciones con `db` como
// primer parámetro; SessionManager.getDb(epoch) es el único sitio que entrega la DB. Todo (nombres,
// orden, elementos y la música de cada presentación) vive en la DB cifrada.
//
// - `position` es densa (0..n-1) dentro de cada playlist: añadir va al final en el orden recibido,
//   quitar y borrar medios vuelven a numerar sin huecos (compactPositions) y reordenar reescribe la
//   permutación completa. El orden es estable: nada más cambia `position`.
// - [H3-4] addItems y removeItems (y el control de la permutación de reorder) usan un único
//   parámetro JSON con json_each(?), nunca un `IN (?, ?, …)` que pasaría de las 32 766 variables de
//   SQLite.
// - Límite de 2000 elementos por playlist (§9.2): PLAYLIST_FULL sin añadir nada.
// - Ninguna transacción abarca un `await` (§22): todas las funciones son síncronas.
import { randomBytes } from 'node:crypto';
import { AppErrorException } from '@shared/errors';
import { ID_PATTERN, PLAYLIST_MAX_ITEMS } from '@shared/constants';
import type { Id, PlaylistSummary, PresentationPlainSettings } from '@shared/types';
import { foldName } from '../../import/naming';
import type { Db } from '../database';

function requireId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new RangeError('id inválido');
}

const notFound = (): AppErrorException => new AppErrorException({ code: 'NOT_FOUND' });

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

interface SummaryRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  custom: number;
  item_count: number;
  cover: string | null;
}

/**
 * Resumen de cada playlist. Cuenta y portada solo con medios `ready` (una fila `pending` es de un
 * trabajo en curso; la UI nunca la ve).
 */
const SUMMARY_SQL = `SELECT p.id, p.name, p.created_at, p.updated_at,
    p.presentation_json IS NOT NULL AS custom,
    (SELECT COUNT(*) FROM playlist_items pi JOIN media m ON m.id = pi.media_id AND m.state = 'ready'
       WHERE pi.playlist_id = p.id) AS item_count,
    (SELECT pi.media_id FROM playlist_items pi JOIN media m ON m.id = pi.media_id AND m.state = 'ready'
       WHERE pi.playlist_id = p.id ORDER BY pi.position LIMIT 1) AS cover
  FROM playlists p`;

function toSummary(r: SummaryRow): PlaylistSummary {
  return {
    id: r.id,
    name: r.name,
    itemCount: r.item_count,
    coverMediaId: r.cover,
    hasCustomPresentation: r.custom === 1,
    updatedAt: r.updated_at,
  };
}

/** playlists:list: por nombre (colación española natural); desempate por creación e id. */
export function listPlaylists(db: Db): PlaylistSummary[] {
  const rows = db.prepare(SUMMARY_SQL).all() as SummaryRow[];
  rows.sort(
    (a, b) =>
      collator.compare(a.name, b.name) ||
      a.created_at - b.created_at ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return rows.map(toSummary);
}

export function getPlaylist(db: Db, id: Id): PlaylistSummary | null {
  const row = db.prepare(`${SUMMARY_SQL} WHERE p.id = ?`).get(id) as SummaryRow | undefined;
  return row ? toSummary(row) : null;
}

export function playlistExists(db: Db, id: Id): boolean {
  return db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id) !== undefined;
}

/** playlists:create (`name` ya validado: 1–100 code points, NFC, sin \p{Cc}). */
export function createPlaylist(
  db: Db,
  name: string,
  now: number = Date.now(),
  id: Id = randomBytes(16).toString('hex'),
): PlaylistSummary {
  requireId(id);
  db.prepare(
    `INSERT INTO playlists (id, name, name_fold, created_at, updated_at, presentation_json)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, name, foldName(name), now, now);
  return getPlaylist(db, id) as PlaylistSummary;
}

/** playlists:rename. NOT_FOUND si no existe. */
export function renamePlaylist(
  db: Db,
  id: Id,
  name: string,
  now: number = Date.now(),
): PlaylistSummary {
  const changed = db
    .prepare('UPDATE playlists SET name = ?, name_fold = ?, updated_at = ? WHERE id = ?')
    .run(name, foldName(name), now, id).changes;
  if (changed === 0) throw notFound();
  return getPlaylist(db, id) as PlaylistSummary;
}

/** playlists:delete: la cascada borra sus elementos y su música; los medios no se tocan. */
export function deletePlaylist(db: Db, id: Id): void {
  if (db.prepare('DELETE FROM playlists WHERE id = ?').run(id).changes === 0) throw notFound();
}

function touch(db: Db, id: Id, now: number): void {
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * Vuelve a numerar `position` de 0 a n-1 conservando el orden relativo (tras quitar elementos o
 * borrar medios: la cascada deja huecos).
 */
export function compactPositions(db: Db, playlistIds: readonly Id[]): void {
  const update = db.prepare(
    `UPDATE playlist_items SET position = r.rn
     FROM (SELECT media_id, ROW_NUMBER() OVER (ORDER BY position, added_at, media_id) - 1 AS rn
           FROM playlist_items WHERE playlist_id = @id) AS r
     WHERE playlist_items.playlist_id = @id AND playlist_items.media_id = r.media_id
       AND playlist_items.position <> r.rn`,
  );
  for (const id of playlistIds) update.run({ id });
}

/** Playlists que contienen alguno de los medios (borrado de medios, §12.10), con json_each(?). */
export function playlistsContaining(db: Db, mediaIdsJson: string): Id[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT playlist_id AS id FROM playlist_items
       WHERE media_id IN (SELECT value FROM json_each(?))`,
    )
    .all(mediaIdsJson) as { id: string }[];
  return rows.map((r) => r.id);
}

export interface AddItemsOptions {
  now?: number;
  /** Límite de elementos (PLAYLIST_FULL). Por defecto 2000; los tests de [H3-4] usan Infinity. */
  limit?: number;
}

/**
 * playlists:addItems ([H3-4]): en una transacción, los medios `ready` que aún no están se añaden al
 * final en el orden recibido; los que ya están cuentan en `alreadyPresent` y los que no existen (o
 * no están `ready`) se ignoran. Si el total pasaría del límite, PLAYLIST_FULL sin añadir nada.
 */
export function addItems(
  db: Db,
  id: Id,
  mediaIds: readonly Id[],
  options: AddItemsOptions = {},
): { added: number; alreadyPresent: number } {
  for (const m of mediaIds) requireId(m);
  const limit = options.limit ?? PLAYLIST_MAX_ITEMS;
  const now = options.now ?? Date.now();
  // Sin duplicados (el esquema ya los rechaza; el primero gana para el orden).
  const json = JSON.stringify([...new Set(mediaIds)]);
  return db.transaction(() => {
    if (!playlistExists(db, id)) throw notFound();
    const current = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(MAX(position) + 1, 0) AS next FROM playlist_items WHERE playlist_id = ?',
      )
      .get(id) as { n: number; next: number };
    const counts = db
      .prepare(
        `SELECT
           SUM(EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = @id AND pi.media_id = j.value)) AS present,
           SUM(NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = @id AND pi.media_id = j.value)
               AND EXISTS (SELECT 1 FROM media m WHERE m.id = j.value AND m.state = 'ready')) AS fresh
         FROM json_each(@json) j`,
      )
      .get({ id, json }) as { present: number | null; fresh: number | null };
    const alreadyPresent = counts.present ?? 0;
    const fresh = counts.fresh ?? 0;
    if (current.n + fresh > limit) {
      throw new AppErrorException({ code: 'PLAYLIST_FULL', details: { count: current.n } });
    }
    if (fresh === 0) return { added: 0, alreadyPresent };
    const added = db
      .prepare(
        `INSERT INTO playlist_items (playlist_id, media_id, position, added_at)
         SELECT @id, j.value, @next + ROW_NUMBER() OVER (ORDER BY j.key) - 1, @now
         FROM json_each(@json) j
         WHERE EXISTS (SELECT 1 FROM media m WHERE m.id = j.value AND m.state = 'ready')
           AND NOT EXISTS (SELECT 1 FROM playlist_items pi
                           WHERE pi.playlist_id = @id AND pi.media_id = j.value)`,
      )
      .run({ id, json, next: current.next, now }).changes;
    touch(db, id, now);
    return { added, alreadyPresent };
  })();
}

/** playlists:removeItems ([H3-4]): quita los que estén y vuelve a numerar sin huecos. */
export function removeItems(
  db: Db,
  id: Id,
  mediaIds: readonly Id[],
  now: number = Date.now(),
): { removed: number } {
  for (const m of mediaIds) requireId(m);
  const json = JSON.stringify(mediaIds);
  return db.transaction(() => {
    if (!playlistExists(db, id)) throw notFound();
    const removed = db
      .prepare(
        `DELETE FROM playlist_items
         WHERE playlist_id = ? AND media_id IN (SELECT value FROM json_each(?))`,
      )
      .run(id, json).changes;
    if (removed > 0) {
      compactPositions(db, [id]);
      touch(db, id, now);
    }
    return { removed };
  })();
}

/**
 * playlists:reorder: `mediaIds` tiene que ser la permutación exacta de los elementos actuales
 * (mismos ids, ni uno más ni uno menos; sin duplicados, que ya rechaza el esquema). Si no,
 * VALIDATION { reason: 'permutation' } sin cambiar nada. `position` = índice en `mediaIds`.
 */
export function reorderItems(
  db: Db,
  id: Id,
  mediaIds: readonly Id[],
  now: number = Date.now(),
): void {
  for (const m of mediaIds) requireId(m);
  if (new Set(mediaIds).size !== mediaIds.length) {
    throw new AppErrorException({ code: 'VALIDATION', details: { reason: 'permutation' } });
  }
  const json = JSON.stringify(mediaIds);
  db.transaction(() => {
    if (!playlistExists(db, id)) throw notFound();
    const check = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = @id) AS total,
           (SELECT COUNT(*) FROM json_each(@json) j JOIN playlist_items pi
              ON pi.playlist_id = @id AND pi.media_id = j.value) AS matched`,
      )
      .get({ id, json }) as { total: number; matched: number };
    if (check.total !== mediaIds.length || check.matched !== mediaIds.length) {
      throw new AppErrorException({ code: 'VALIDATION', details: { reason: 'permutation' } });
    }
    db.prepare(
      `UPDATE playlist_items SET position = j.key
       FROM json_each(@json) AS j
       WHERE playlist_items.playlist_id = @id AND playlist_items.media_id = j.value`,
    ).run({ id, json });
    touch(db, id, now);
  })();
}

/** Ids de los elementos en el orden de la playlist (todos los estados; para tests y reorder). */
export function playlistItemIds(db: Db, id: Id): Id[] {
  const rows = db
    .prepare('SELECT media_id FROM playlist_items WHERE playlist_id = ? ORDER BY position')
    .all(id) as { media_id: string }[];
  return rows.map((r) => r.media_id);
}

// ── Música y ajustes de la presentación de una playlist (§10.2) ───────────────────────────────

/** presentation_json en bruto (JSON o null) y las pistas de playlist_music por `position`. */
export function playlistPresentation(
  db: Db,
  id: Id,
): { json: string | null; trackIds: Id[] } | null {
  const row = db.prepare('SELECT presentation_json FROM playlists WHERE id = ?').get(id) as
    { presentation_json: string | null } | undefined;
  if (!row) return null;
  const tracks = db
    .prepare(
      'SELECT track_id FROM playlist_music WHERE playlist_id = ? ORDER BY position, track_id',
    )
    .all(id) as { track_id: string }[];
  return { json: row.presentation_json, trackIds: tracks.map((t) => t.track_id) };
}

/**
 * playlists:setPresentation (§10.2), en una transacción: con ajustes, `presentation_json` = la parte
 * en claro (ya validada, sin `trackIds`) y playlist_music = `trackIds` en orden; con null, ambos se
 * vacían. NOT_FOUND si la playlist no existe o alguna pista no existe (sin cambiar nada).
 */
export function setPlaylistPresentation(
  db: Db,
  id: Id,
  value: { plain: PresentationPlainSettings; trackIds: readonly Id[] } | null,
  now: number = Date.now(),
): void {
  if (value) for (const t of value.trackIds) requireId(t);
  db.transaction(() => {
    if (!playlistExists(db, id)) throw notFound();
    db.prepare('DELETE FROM playlist_music WHERE playlist_id = ?').run(id);
    if (!value) {
      db.prepare('UPDATE playlists SET presentation_json = NULL, updated_at = ? WHERE id = ?').run(
        now,
        id,
      );
      return;
    }
    const json = JSON.stringify(value.trackIds);
    const existing = db
      .prepare('SELECT COUNT(*) AS n FROM json_each(?) j JOIN music_tracks t ON t.id = j.value')
      .get(json) as { n: number };
    if (existing.n !== value.trackIds.length) throw notFound();
    db.prepare(
      `INSERT INTO playlist_music (playlist_id, track_id, position)
       SELECT ?, j.value, j.key FROM json_each(?) j`,
    ).run(id, json);
    db.prepare('UPDATE playlists SET presentation_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(value.plain),
      now,
      id,
    );
  })();
}
