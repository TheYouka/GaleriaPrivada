// Repositorio de medios (docs/DESIGN.md §9.2, §10.2, §12.4 pasos 5–7, §12.7 y §12.10). P6: funciones
// con `db` como primer parámetro; SessionManager.getDb(epoch) es el único sitio que entrega la DB.
//
// - Toda lectura para la UI usa `state = 'ready'`; las filas `pending` son de trabajos en curso.
// - Orden total y estable (la selección por rango con Shift depende de él, §14.6); por nombre se
//   ordena en JS con Intl.Collator('es', { numeric: true, sensitivity: 'base' }) porque
//   better-sqlite3 no permite registrar collations; desempate por imported_at y después id.
// - Búsqueda por `name_fold LIKE '%' || ? || '%' ESCAPE '\'`, con el término plegado igual y
//   `%`, `_` y `\` escapados.
// - [H3-4] Borrado con un único parámetro JSON (`json_each(?)`): nunca un `IN (?, ?, …)` que pasaría
//   del límite de 32 766 variables de SQLite.
import { AppErrorException } from '@shared/errors';
import { ID_PATTERN } from '@shared/constants';
import type {
  ExifSummary,
  Id,
  MediaDetail,
  MediaKind,
  MediaListItem,
  MediaQuery,
} from '@shared/types';
import type { CapturedAtSource } from '../../import/capture-date';
import { foldName } from '../../import/naming';
import type { Db } from '../database';
import { listEdits } from './edit-repo';
import { importReplaceKey, kvDelete, kvSet } from './kv-repo';

export interface NewMedia {
  id: Id;
  kind: MediaKind;
  source: 'import' | 'merge';
  name: string;
  originalExt: string;
  /** MIME del objeto almacenado (tras la conversión). */
  mime: string;
  /** Plaintext almacenado. */
  sizeBytes: number;
  originalSizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  hasAudio: boolean | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** true si lo almacenado no es byte a byte el original (salida de ffmpeg, §9.2). */
  converted: boolean;
  capturedAt: number;
  capturedAtSource: CapturedAtSource;
  importedAt: number;
  /** HMAC-SHA256(K_dedup, original), 32 bytes. */
  contentHmac: Buffer;
  thumbId: Id | null;
}

/** Fila de media_exif ya saneada (image-pipeline.ts). */
export interface MediaExifInput {
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  fNumber: number | null;
  exposureS: number | null;
  iso: number | null;
  focalMm: number | null;
  orientation: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  tzOffsetMin: number | null;
  /** Subconjunto saneado en JSON (strings ≤ 256, ≤ 16 KiB). */
  rawJson: string;
}

interface MediaRow {
  id: string;
  kind: MediaKind;
  name: string;
  original_ext: string;
  mime: string;
  size_bytes: number;
  original_size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  fps: number | null;
  has_audio: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  converted: number;
  captured_at: number;
  imported_at: number;
  thumb_rev: number;
}

interface ExifRow {
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  f_number: number | null;
  exposure_s: number | null;
  iso: number | null;
  focal_mm: number | null;
}

const LIST_COLUMNS = `m.id, m.kind, m.name, m.original_ext, m.size_bytes, m.duration_ms, m.width,
  m.height, m.captured_at, m.imported_at, m.thumb_rev`;
const DETAIL_COLUMNS = `${LIST_COLUMNS}, m.mime, m.original_size_bytes, m.fps, m.has_audio,
  m.video_codec, m.audio_codec, m.converted`;

function requireId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new RangeError('id inválido');
}

function toListItem(r: MediaRow): MediaListItem {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    ext: r.original_ext,
    capturedAt: r.captured_at,
    importedAt: r.imported_at,
    sizeBytes: r.size_bytes,
    durationMs: r.duration_ms,
    width: r.width,
    height: r.height,
    thumbRev: r.thumb_rev,
  };
}

// ── Importación (§12.4) ────────────────────────────────────────────────────────────────────────

const INSERT_MEDIA = `INSERT INTO media (id, kind, state, source, name, name_fold, original_ext, mime,
  size_bytes, original_size_bytes, width, height, duration_ms, fps, has_audio, video_codec,
  audio_codec, converted, captured_at, captured_at_source, imported_at, content_hmac, thumb_id)
  VALUES (@id, @kind, 'pending', @source, @name, @nameFold, @originalExt, @mime, @sizeBytes,
  @originalSizeBytes, @width, @height, @durationMs, @fps, @hasAudio, @videoCodec, @audioCodec,
  @converted, @capturedAt, @capturedAtSource, @importedAt, @contentHmac, @thumbId)`;

const INSERT_EXIF = `INSERT INTO media_exif (media_id, camera_make, camera_model, lens_model,
  f_number, exposure_s, iso, focal_mm, orientation, gps_lat, gps_lon, tz_offset_min, raw_json)
  VALUES (@mediaId, @cameraMake, @cameraModel, @lensModel, @fNumber, @exposureS, @iso, @focalMm,
  @orientation, @gpsLat, @gpsLon, @tzOffsetMin, @rawJson)`;

/**
 * Paso 5: fila `pending` + media_exif en una transacción (dentro de otra, es un savepoint). Un
 * content_hmac repetido lanza el SqliteError SQLITE_CONSTRAINT_UNIQUE (el llamador lo cuenta como
 * `skipped`, §12.4).
 */
export function insertPending(db: Db, media: NewMedia, exif: MediaExifInput | null = null): void {
  requireId(media.id);
  if (media.thumbId !== null) requireId(media.thumbId);
  if (media.contentHmac.length !== 32) throw new RangeError('content_hmac de 32 bytes');
  db.transaction(() => {
    db.prepare(INSERT_MEDIA).run({
      ...media,
      nameFold: foldName(media.name),
      hasAudio: media.hasAudio === null ? null : media.hasAudio ? 1 : 0,
      converted: media.converted ? 1 : 0,
    });
    if (exif) db.prepare(INSERT_EXIF).run({ mediaId: media.id, ...exif });
  })();
}

// ── Sustitución de un duplicado dañado (§12.7, punto 3) ───────────────────────────────────────

/**
 * Transacción A (paso 5 de una sustitución): libera el UNIQUE de `oldId` con un HMAC aleatorio,
 * inserta la fila `pending` nueva (+ EXIF) y deja `import.replace.<newId>` = { old, hmac } en kv,
 * con el HMAC en hex minúsculas, para que la reconciliación termine o deshaga una caída entre A y B.
 */
export function insertReplacing(
  db: Db,
  media: NewMedia,
  exif: MediaExifInput | null,
  oldId: Id,
): void {
  requireId(oldId);
  db.transaction(() => {
    db.prepare('UPDATE media SET content_hmac = randomblob(32) WHERE id = ?').run(oldId);
    insertPending(db, media, exif);
    kvSet(db, importReplaceKey(media.id), {
      old: oldId,
      hmac: media.contentHmac.toString('hex'),
    });
  })();
}

/**
 * Transacción B (paso 7 de una sustitución, y punto 2 de la reconciliación): `newId` pasa a
 * `ready` con el nombre, el pliegue y la fecha de importación de `oldId`; copia sus ediciones,
 * mueve sus posiciones en las playlists, borra la fila antigua (la cascada solo borra ya su EXIF y
 * sus ediciones copiadas) y la clave de kv. Devuelve la miniatura antigua para el borrado
 * criptográfico tras el COMMIT. Si `oldId` ya no existe (borrado mientras tanto), solo marca
 * `newId` como `ready`. false si `newId` no está `pending`.
 */
export function completeReplacement(
  db: Db,
  newId: Id,
  oldId: Id,
): { ok: boolean; oldExisted: boolean; oldThumbId: Id | null; copiedEdits: number } {
  requireId(newId);
  requireId(oldId);
  return db.transaction(() => {
    const old = db.prepare('SELECT thumb_id FROM media WHERE id = ?').get(oldId) as
      { thumb_id: string | null } | undefined;
    let updated: number;
    let copiedEdits = 0;
    if (old) {
      updated = db
        .prepare(
          `UPDATE media SET state = 'ready',
             name        = (SELECT name        FROM media WHERE id = @old),
             name_fold   = (SELECT name_fold   FROM media WHERE id = @old),
             imported_at = (SELECT imported_at FROM media WHERE id = @old)
           WHERE id = @new AND state = 'pending'`,
        )
        .run({ old: oldId, new: newId }).changes;
      if (updated > 0) {
        copiedEdits = db
          .prepare(
            `INSERT INTO media_edits (media_id, seq, op_json, created_at)
             SELECT @new, seq, op_json, created_at FROM media_edits WHERE media_id = @old`,
          )
          .run({ old: oldId, new: newId }).changes;
        db.prepare('UPDATE playlist_items SET media_id = ? WHERE media_id = ?').run(newId, oldId);
        db.prepare('DELETE FROM media WHERE id = ?').run(oldId);
      }
    } else {
      updated = db
        .prepare("UPDATE media SET state = 'ready' WHERE id = ? AND state = 'pending'")
        .run(newId).changes;
    }
    if (updated === 0)
      return { ok: false, oldExisted: old !== undefined, oldThumbId: null, copiedEdits };
    kvDelete(db, importReplaceKey(newId));
    return {
      ok: true,
      oldExisted: old !== undefined,
      oldThumbId: old?.thumb_id ?? null,
      copiedEdits,
    };
  })();
}

/**
 * Deshace la transacción A (rama de fallo del paso 6 de una sustitución, y punto 2 de la
 * reconciliación cuando la fila nueva ya no existe): borra la fila `pending` nueva, devuelve a
 * `oldId` su HMAC y borra la clave de kv. La fila antigua vuelve a su estado anterior.
 */
export function undoReplacement(db: Db, newId: Id, oldId: Id, hmac: Buffer): void {
  requireId(newId);
  requireId(oldId);
  if (hmac.length !== 32) throw new RangeError('content_hmac de 32 bytes');
  db.transaction(() => {
    deletePending(db, newId);
    db.prepare('UPDATE media SET content_hmac = ? WHERE id = ?').run(hmac, oldId);
    kvDelete(db, importReplaceKey(newId));
  })();
}

/** Paso 7: `pending` → `ready`. false si la fila no existe o ya no está `pending`. */
export function markReady(db: Db, id: Id): boolean {
  return (
    db.prepare("UPDATE media SET state = 'ready' WHERE id = ? AND state = 'pending'").run(id)
      .changes > 0
  );
}

/** Rama de fallo del paso 6: borra la fila `pending` (y su EXIF por cascada). */
export function deletePending(db: Db, id: Id): boolean {
  return db.prepare("DELETE FROM media WHERE id = ? AND state = 'pending'").run(id).changes > 0;
}

/** Duplicados (§12.7): la fila con ese HMAC, si existe. */
export function findByHmac(
  db: Db,
  hmac: Buffer,
): { id: Id; state: 'pending' | 'ready'; converted: boolean } | null {
  const row = db
    .prepare('SELECT id, state, converted FROM media WHERE content_hmac = ?')
    .get(hmac) as { id: string; state: 'pending' | 'ready'; converted: number } | undefined;
  return row ? { id: row.id, state: row.state, converted: row.converted === 1 } : null;
}

/** vault://media|thumb (§11.2): MIME y miniatura de una fila `ready`. */
export function findReady(db: Db, id: Id): { mime: string; thumbId: Id | null } | null {
  const row = db
    .prepare("SELECT mime, thumb_id FROM media WHERE id = ? AND state = 'ready'")
    .get(id) as { mime: string; thumb_id: string | null } | undefined;
  return row ? { mime: row.mime, thumbId: row.thumb_id } : null;
}

// ── Reconciliación (§12.6) ─────────────────────────────────────────────────────────────────────

export interface PendingMedia {
  id: Id;
  thumbId: Id | null;
}

/** Punto 1: filas `pending` (trabajos interrumpidos). */
export function listPending(db: Db): PendingMedia[] {
  const rows = db
    .prepare("SELECT id, thumb_id FROM media WHERE state = 'pending' ORDER BY id")
    .all() as { id: string; thumb_id: string | null }[];
  return rows.map((r) => ({ id: r.id, thumbId: r.thumb_id }));
}

/** Punto 3 [H3-7]: filas `ready` con miniatura. */
export function listReadyThumbs(db: Db): { id: Id; thumbId: Id }[] {
  const rows = db
    .prepare("SELECT id, thumb_id FROM media WHERE state = 'ready' AND thumb_id IS NOT NULL")
    .all() as { id: string; thumb_id: string }[];
  return rows.map((r) => ({ id: r.id, thumbId: r.thumb_id }));
}

/** Punto 3: `thumb_id = NULL` en las filas `ready` dadas, con un único parámetro JSON [H3-4]. */
export function clearThumbIds(db: Db, ids: readonly Id[]): number {
  for (const id of ids) requireId(id);
  if (ids.length === 0) return 0;
  return db
    .prepare(
      `UPDATE media SET thumb_id = NULL
       WHERE state = 'ready' AND id IN (SELECT value FROM json_each(?))`,
    )
    .run(JSON.stringify(ids)).changes;
}

/**
 * Regeneración de miniaturas: lo necesario para rehacer la de una fila `ready`. Por defecto solo
 * si no tiene miniatura (cola del punto 3 de §12.6); con `anyThumb`, también si la tiene (y la
 * devuelve como `thumbId`, la que se sustituirá).
 */
export function thumbSource(
  db: Db,
  id: Id,
  opts: { anyThumb?: boolean } = {},
): { kind: MediaKind; mime: string; durationMs: number | null; thumbId: Id | null } | null {
  const row = db
    .prepare(
      `SELECT kind, mime, duration_ms, thumb_id FROM media WHERE id = ? AND state = 'ready'
       ${opts.anyThumb ? '' : 'AND thumb_id IS NULL'}`,
    )
    .get(id) as
    | { kind: MediaKind; mime: string; duration_ms: number | null; thumb_id: string | null }
    | undefined;
  return row
    ? { kind: row.kind, mime: row.mime, durationMs: row.duration_ms, thumbId: row.thumb_id }
    : null;
}

/**
 * Regeneración (§16.5 paso 5): miniatura nueva y `thumb_rev += 1`, solo si la fila sigue `ready`
 * y con la miniatura `expected` (por defecto ninguna). false si ya no aplica (borrada, o una
 * edición guardó otra miniatura mientras tanto).
 */
export function setRegeneratedThumb(
  db: Db,
  id: Id,
  thumbId: Id,
  expected: Id | null = null,
): boolean {
  requireId(thumbId);
  return (
    db
      .prepare(
        `UPDATE media SET thumb_id = ?, thumb_rev = thumb_rev + 1
         WHERE id = ? AND state = 'ready' AND thumb_id IS ?`,
      )
      .run(thumbId, id, expected).changes > 0
  );
}

/**
 * Barrido de huérfanos (punto 7): ids de objeto (`kind = 'objects'`) o de miniatura (`'thumbs'`)
 * que la DB usa en el shard `aa`, en cualquier estado. Una consulta por directorio.
 */
export function referencedInShard(db: Db, kind: 'objects' | 'thumbs', shard: string): Set<Id> {
  if (!/^[0-9a-f]{2}$/.test(shard)) throw new RangeError('shard inválido');
  const sql =
    kind === 'objects'
      ? 'SELECT id AS ref FROM media WHERE id >= ? AND id < ?'
      : 'SELECT thumb_id AS ref FROM media WHERE thumb_id >= ? AND thumb_id < ?';
  const rows = db.prepare(sql).all(shard, `${shard}g`) as { ref: string }[];
  return new Set(rows.map((r) => r.ref));
}

/** Barrido de huérfanos (punto 7): ¿alguna fila (de cualquier estado) usa este objeto? */
export function isObjectReferenced(db: Db, id: Id): boolean {
  return db.prepare('SELECT 1 FROM media WHERE id = ?').get(id) !== undefined;
}

/** Barrido de huérfanos (punto 7): ¿alguna fila (de cualquier estado) usa esta miniatura? */
export function isThumbReferenced(db: Db, thumbId: Id): boolean {
  return db.prepare('SELECT 1 FROM media WHERE thumb_id = ?').get(thumbId) !== undefined;
}

// ── Consultas de la galería (§9.2, §10.2) ─────────────────────────────────────────────────────

/** Término de búsqueda plegado como name_fold y con `\`, `%` y `_` escapados para LIKE … ESCAPE '\'. */
export function likePattern(search: string): string {
  const escaped = foldName(search).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Orden por nombre (§9.2): colación española natural; desempate por imported_at y después id. */
export function compareByName(a: MediaListItem, b: MediaListItem): number {
  return (
    collator.compare(a.name, b.name) ||
    a.importedAt - b.importedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function orderBy(query: MediaQuery): string {
  const dir = query.sort.dir === 'desc' ? 'DESC' : 'ASC';
  switch (query.sort.field) {
    case 'captured':
      return `ORDER BY m.captured_at ${dir}, m.id ${dir}`;
    case 'imported':
      return `ORDER BY m.imported_at ${dir}, m.id ${dir}`;
    case 'size':
      return `ORDER BY m.size_bytes ${dir}, m.id ${dir}`;
    case 'duration':
      return `ORDER BY m.duration_ms IS NULL, m.duration_ms ${dir}, m.id ${dir}`;
    case 'position':
      return `ORDER BY pi.position ${dir}`;
    case 'name':
      return ''; // en JS
  }
}

/** media:list: la biblioteca entera de la consulta (R13), solo filas `ready`. */
export function listMedia(db: Db, query: MediaQuery): MediaListItem[] {
  if (query.sort.field === 'position' && !query.playlistId) {
    throw new AppErrorException({ code: 'VALIDATION', details: { path: 'sort.field' } });
  }
  const where = ["m.state = 'ready'"];
  const params: (string | number)[] = [];
  let join = '';
  if (query.playlistId) {
    join = 'JOIN playlist_items pi ON pi.media_id = m.id AND pi.playlist_id = ?';
    params.push(query.playlistId);
  }
  if (query.kind !== 'all') {
    where.push('m.kind = ?');
    params.push(query.kind);
  }
  if (query.search && query.search.length > 0) {
    where.push("m.name_fold LIKE ? ESCAPE '\\'");
    params.push(likePattern(query.search));
  }
  if (query.dateFrom !== undefined) {
    where.push('m.captured_at >= ?');
    params.push(query.dateFrom);
  }
  if (query.dateTo !== undefined) {
    where.push('m.captured_at <= ?');
    params.push(query.dateTo);
  }
  const sql = `SELECT ${LIST_COLUMNS} FROM media m ${join} WHERE ${where.join(' AND ')} ${orderBy(query)}`;
  const items = (db.prepare(sql).all(...params) as MediaRow[]).map(toListItem);
  if (query.sort.field === 'name') {
    const sign = query.sort.dir === 'desc' ? -1 : 1;
    items.sort((a, b) => sign * compareByName(a, b));
  }
  return items;
}

function toExifSummary(r: ExifRow | undefined): ExifSummary | null {
  if (!r) return null;
  const out: ExifSummary = {};
  if (r.camera_make !== null) out.cameraMake = r.camera_make;
  if (r.camera_model !== null) out.cameraModel = r.camera_model;
  if (r.lens_model !== null) out.lensModel = r.lens_model;
  if (r.f_number !== null) out.fNumber = r.f_number;
  if (r.exposure_s !== null) out.exposureS = r.exposure_s;
  if (r.iso !== null) out.iso = r.iso;
  if (r.focal_mm !== null) out.focalMm = r.focal_mm;
  return out;
}

/** media:get: detalle de una fila `ready`, o null. */
export function getMedia(db: Db, id: Id): MediaDetail | null {
  const row = db
    .prepare(`SELECT ${DETAIL_COLUMNS} FROM media m WHERE m.id = ? AND m.state = 'ready'`)
    .get(id) as MediaRow | undefined;
  if (!row) return null;
  const exif = db
    .prepare(
      `SELECT camera_make, camera_model, lens_model, f_number, exposure_s, iso, focal_mm
       FROM media_exif WHERE media_id = ?`,
    )
    .get(id) as ExifRow | undefined;
  return {
    ...toListItem(row),
    mime: row.mime,
    originalSizeBytes: row.original_size_bytes,
    converted: row.converted === 1,
    hasAudio: row.has_audio === null ? null : row.has_audio === 1,
    fps: row.fps,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    exif: toExifSummary(exif),
    // Las operaciones guardadas, en orden (el renderer obtiene el EditState con foldEdits, §16.3).
    edits: listEdits(db, id),
  };
}

/** media:rename (`name` ya validado: 1–255 code points, NFC, sin \p{Cc}). NOT_FOUND si no hay fila `ready`. */
export function renameMedia(db: Db, id: Id, name: string): MediaListItem {
  const changed = db
    .prepare("UPDATE media SET name = ?, name_fold = ? WHERE id = ? AND state = 'ready'")
    .run(name, foldName(name), id).changes;
  if (changed === 0) throw new AppErrorException({ code: 'NOT_FOUND' });
  const row = db.prepare(`SELECT ${LIST_COLUMNS} FROM media m WHERE m.id = ?`).get(id) as MediaRow;
  return toListItem(row);
}

// ── Borrado (§12.10) ───────────────────────────────────────────────────────────────────────────

export interface DeletedMedia {
  id: Id;
  thumbId: Id | null;
}

/**
 * §12.10 punto 2 con [H3-4]: en UNA transacción, los objetos de las filas `ready` y su DELETE (la
 * cascada borra EXIF, ediciones y elementos de playlist), con `JSON.stringify(ids)` como único
 * parámetro. Devuelve lo que hay que borrar con borrado criptográfico después del COMMIT. Las filas
 * `pending` (de un trabajo en curso) no se tocan.
 */
export function deleteMedia(db: Db, ids: readonly Id[]): DeletedMedia[] {
  for (const id of ids) requireId(id);
  const json = JSON.stringify(ids);
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, thumb_id FROM media
         WHERE state = 'ready' AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(json) as { id: string; thumb_id: string | null }[];
    db.prepare(
      "DELETE FROM media WHERE state = 'ready' AND id IN (SELECT value FROM json_each(?))",
    ).run(json);
    return rows.map((r) => ({ id: r.id, thumbId: r.thumb_id }));
  })();
}
