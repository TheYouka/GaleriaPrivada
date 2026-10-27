// Biblioteca de música del perfil (docs/DESIGN.md §8.6.1, §9.2). P6: funciones con `db` como primer
// parámetro. Los títulos (que salen del nombre del archivo original) y qué pistas usa cada
// presentación viven solo aquí, en la DB cifrada; en music/ cada archivo se llama `<trackId>.<ext>`.
import { AppErrorException } from '@shared/errors';
import { ID_PATTERN } from '@shared/constants';
import type { Id, MusicTrack } from '@shared/types';
import { foldName } from '../../import/naming';
import type { Db } from '../database';
import { KV_DEFAULT_TRACKS, kvGet, kvSet } from './kv-repo';

export interface NewTrack {
  id: Id;
  /** `<id>.<ext>` dentro de music/. */
  fileName: string;
  title: string;
  ext: string;
  mime: string;
  sizeBytes: number;
  durationMs: number | null;
  importedAt: number;
}

interface TrackRow {
  id: string;
  title: string;
  duration_ms: number | null;
  size_bytes: number;
}

function requireId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new RangeError('id inválido');
}

function toTrack(r: TrackRow): MusicTrack {
  return { id: r.id, title: r.title, durationMs: r.duration_ms, sizeBytes: r.size_bytes };
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Una pista nueva (en su propia transacción, §8.6.1). */
export function insertTrack(db: Db, t: NewTrack): MusicTrack {
  requireId(t.id);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO music_tracks (id, file_name, title, title_fold, ext, mime, size_bytes,
         duration_ms, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id,
      t.fileName,
      t.title,
      foldName(t.title),
      t.ext,
      t.mime,
      t.sizeBytes,
      t.durationMs,
      t.importedAt,
    );
  })();
  return { id: t.id, title: t.title, durationMs: t.durationMs, sizeBytes: t.sizeBytes };
}

/** music:list: por título (colación española natural); desempate por importación e id. */
export function listTracks(db: Db): MusicTrack[] {
  const rows = db
    .prepare('SELECT id, title, duration_ms, size_bytes, imported_at FROM music_tracks')
    .all() as (TrackRow & { imported_at: number })[];
  rows.sort(
    (a, b) =>
      collator.compare(a.title, b.title) ||
      a.imported_at - b.imported_at ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return rows.map(toTrack);
}

/**
 * Las pistas de `ids` que existen, en el mismo orden (§10.2: los ids borrados se descartan al
 * componer), con un único parámetro JSON.
 */
export function tracksInOrder(db: Db, ids: readonly Id[]): MusicTrack[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.duration_ms, t.size_bytes FROM json_each(?) j
       JOIN music_tracks t ON t.id = j.value ORDER BY j.key`,
    )
    .all(JSON.stringify(ids)) as TrackRow[];
  return rows.map(toTrack);
}

/** ¿Existen todas? (trackIds de PresentationSettings, §10.3: si no, NOT_FOUND). */
export function allTracksExist(db: Db, ids: readonly Id[]): boolean {
  if (ids.length === 0) return true;
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM json_each(?) j JOIN music_tracks t ON t.id = j.value')
    .get(JSON.stringify([...new Set(ids)])) as { n: number };
  return row.n === new Set(ids).size;
}

/** vault://music: archivo y MIME de una pista. */
export function findTrackFile(db: Db, id: Id): { fileName: string; mime: string } | null {
  const row = db.prepare('SELECT file_name, mime FROM music_tracks WHERE id = ?').get(id) as
    { file_name: string; mime: string } | undefined;
  return row ? { fileName: row.file_name, mime: row.mime } : null;
}

/** music:rename (`title` ya validado: 1–200 code points, NFC, sin \p{Cc}). NOT_FOUND si no existe. */
export function renameTrack(db: Db, id: Id, title: string): MusicTrack {
  const changed = db
    .prepare('UPDATE music_tracks SET title = ?, title_fold = ? WHERE id = ?')
    .run(title, foldName(title), id).changes;
  if (changed === 0) throw new AppErrorException({ code: 'NOT_FOUND' });
  const row = db
    .prepare('SELECT id, title, duration_ms, size_bytes FROM music_tracks WHERE id = ?')
    .get(id) as TrackRow;
  return toTrack(row);
}

/** Quita ids de kv['presentation.defaultTracks'] (sin escribir si no cambia nada). */
export function removeDefaultTracks(db: Db, ids: ReadonlySet<Id>): void {
  const current = kvGet(db, KV_DEFAULT_TRACKS);
  if (!current) return;
  const next = current.filter((t) => !ids.has(t));
  if (next.length !== current.length) kvSet(db, KV_DEFAULT_TRACKS, next);
}

/**
 * music:delete (§8.6.1), en una transacción: la fila (la cascada limpia playlist_music) y el id de
 * kv['presentation.defaultTracks']. Devuelve el archivo para borrarlo tras el COMMIT, o null si no
 * existía.
 */
export function deleteTrack(db: Db, id: Id): string | null {
  return db.transaction(() => {
    const row = findTrackFile(db, id);
    if (!row) return null;
    db.prepare('DELETE FROM music_tracks WHERE id = ?').run(id);
    removeDefaultTracks(db, new Set([id]));
    return row.fileName;
  })();
}

/** Reconciliación (§12.6 punto 5): id y archivo de cada pista. */
export function listTrackFiles(db: Db): { id: Id; fileName: string }[] {
  const rows = db.prepare('SELECT id, file_name FROM music_tracks').all() as {
    id: string;
    file_name: string;
  }[];
  return rows.map((r) => ({ id: r.id, fileName: r.file_name }));
}

/**
 * Reconciliación (§12.6 punto 5): borra las filas sin archivo (la cascada limpia playlist_music) y
 * deja en kv['presentation.defaultTracks'] solo pistas que existen. Una transacción, json_each(?).
 */
export function dropTracks(db: Db, ids: readonly Id[]): number {
  for (const id of ids) requireId(id);
  return db.transaction(() => {
    const removed =
      ids.length === 0
        ? 0
        : db
            .prepare('DELETE FROM music_tracks WHERE id IN (SELECT value FROM json_each(?))')
            .run(JSON.stringify(ids)).changes;
    const current = kvGet(db, KV_DEFAULT_TRACKS);
    if (current && current.length > 0) {
      const existing = new Set(tracksInOrder(db, current).map((t) => t.id));
      const next = current.filter((t) => existing.has(t));
      if (next.length !== current.length) kvSet(db, KV_DEFAULT_TRACKS, next);
    }
    return removed;
  })();
}
