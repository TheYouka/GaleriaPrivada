// Migraciones de la DB (docs/DESIGN.md §9.2 y §9.3). Lista ordenada { version, sql }: solo hacia
// delante y nunca se edita una migración ya publicada. La versión vive en PRAGMA user_version.

export interface Migration {
  /** 1, 2, 3… sin huecos. */
  version: number;
  sql: string;
}

/** Esquema v1, literal de §9.2 (con sus comentarios). */
const SCHEMA_V1 = `
CREATE TABLE media (
  id                  TEXT    PRIMARY KEY CHECK (length(id) = 32),
  kind                TEXT    NOT NULL CHECK (kind IN ('photo','video')),
  state               TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  source              TEXT    NOT NULL CHECK (source IN ('import','merge')),
  name                TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  name_fold           TEXT    NOT NULL,          -- minúsculas, sin diacríticos (búsqueda)
  original_ext        TEXT    NOT NULL,          -- 'jpg','png','mp4','mkv',… del archivo original
  mime                TEXT    NOT NULL,          -- MIME del objeto almacenado (tras conversión)
  size_bytes          INTEGER NOT NULL CHECK (size_bytes >= 0),          -- plaintext almacenado
  original_size_bytes INTEGER NOT NULL CHECK (original_size_bytes >= 0),
  width               INTEGER,                   -- dimensiones de visualización (EXIF/rotación aplicadas)
  height              INTEGER,
  duration_ms         INTEGER,                   -- solo vídeo
  fps                 REAL,                      -- solo vídeo
  has_audio           INTEGER CHECK (has_audio IN (0,1)),
  video_codec         TEXT,
  audio_codec         TEXT,
  converted           INTEGER NOT NULL DEFAULT 0 CHECK (converted IN (0,1)),  -- 1 = lo almacenado NO es byte a byte el original (salida de ffmpeg: remultiplexado, recodificado o fusión)
  captured_at         INTEGER NOT NULL,          -- ms, hora local "naive" (pared) codificada con Date.UTC; siempre presente (12.8)
  captured_at_source  TEXT    NOT NULL CHECK (captured_at_source IN ('exif','container','file_mtime','generated')),
  imported_at         INTEGER NOT NULL,          -- ms UTC
  content_hmac        BLOB    NOT NULL UNIQUE CHECK (length(content_hmac) = 32),
  thumb_id            TEXT    CHECK (thumb_id IS NULL OR length(thumb_id) = 32),
  thumb_rev           INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX media_state_captured ON media(state, captured_at DESC);
CREATE INDEX media_state_imported ON media(state, imported_at DESC);
CREATE INDEX media_kind_captured  ON media(kind, captured_at DESC);
CREATE INDEX media_size           ON media(size_bytes);
CREATE INDEX media_duration       ON media(duration_ms);

CREATE TABLE media_exif (
  media_id      TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  camera_make   TEXT, camera_model TEXT, lens_model TEXT,
  f_number      REAL, exposure_s REAL, iso INTEGER, focal_mm REAL,
  orientation   INTEGER, gps_lat REAL, gps_lon REAL,
  tz_offset_min INTEGER,                           -- de OffsetTimeOriginal si existe
  raw_json      TEXT NOT NULL                      -- subconjunto saneado (strings ≤ 256 chars, ≤ 16 KiB)
) STRICT;

CREATE TABLE media_edits (                         -- operaciones no destructivas, en orden
  media_id   TEXT    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  op_json    TEXT    NOT NULL,                     -- EditOp (sección 16.3)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE playlists (
  id                TEXT PRIMARY KEY CHECK (length(id) = 32),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_fold         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  presentation_json TEXT                           -- PresentationPlainSettings (SIN trackIds) o NULL = usar defaults
) STRICT;

CREATE TABLE playlist_items (
  playlist_id TEXT    NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id    TEXT    NOT NULL REFERENCES media(id)     ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),  -- denso 0..n-1, reescrito al reordenar
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX playlist_items_order ON playlist_items(playlist_id, position);
CREATE INDEX playlist_items_media ON playlist_items(media_id);

CREATE TABLE music_tracks (
  id          TEXT PRIMARY KEY CHECK (length(id) = 32),
  file_name   TEXT NOT NULL UNIQUE,                -- '<id>.<ext>' dentro de music/
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  title_fold  TEXT NOT NULL,
  ext         TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  duration_ms INTEGER,
  imported_at INTEGER NOT NULL
) STRICT;

CREATE TABLE playlist_music (                      -- ÚNICA fuente de verdad de la música de una playlist
  playlist_id TEXT    NOT NULL REFERENCES playlists(id)    ON DELETE CASCADE,
  track_id    TEXT    NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (playlist_id, track_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE kv (                                  -- pares cifrados (claves cerradas, abajo)
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, sql: SCHEMA_V1 }),
]);
