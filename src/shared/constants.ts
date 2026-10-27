// Formatos y límites compartidos (docs/DESIGN.md §10.3 y §12.3). Solo datos puros: main los usa en
// los esquemas zod y en la importación; el renderer, para validar antes de enviar (§10.3) y para
// los textos de la Ayuda.
import type { AutoLockMinutes, BuiltinAvatarId } from './types';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

// ── Identificadores ────────────────────────────────────────────────────────────────────────────

/** id, profileId, mediaId, jobId, trackId: 16 bytes aleatorios en hexadecimal (§10.3). */
export const ID_PATTERN = /^[0-9a-f]{32}$/;
export const ID_BYTES = 16;

// ── Perfiles (§10.3, §14.4) ────────────────────────────────────────────────────────────────────

export const MAX_PROFILES = 10;
/** Nombre de perfil: 1–40 code points, sin \p{Cc}, único por pliegue de mayúsculas y diacríticos. */
export const PROFILE_NAME_MIN = 1;
export const PROFILE_NAME_MAX = 40;

/** Contraseña en main: 8–1024 bytes UTF-8 (la única regla que se puede comprobar sobre bytes). */
export const PASSWORD_MIN_BYTES = 8;
export const PASSWORD_MAX_BYTES = 1024;
/** Contraseña en la UI: además, ≥ 8 code points de NFC(texto). */
export const PASSWORD_MIN_CODE_POINTS = 8;

export const BUILTIN_AVATAR_IDS = [
  'aurora',
  'bosque',
  'coral',
  'duna',
  'eclipse',
  'fresa',
  'glaciar',
  'hoja',
  'lava',
  'marea',
  'nebula',
  'sol',
] as const satisfies readonly BuiltinAvatarId[];

/** Token de avatar pendiente: 32 bytes en base64url sin relleno (43 caracteres). */
export const AVATAR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const AVATAR_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Foto de avatar elegida: ≤ 50 MiB y ≤ MAX_INPUT_PIXELS; se guarda en WebP de 256×256. */
export const AVATAR_MAX_BYTES = 50 * MiB;
export const AVATAR_SIZE_PX = 256;

// ── Sesión ─────────────────────────────────────────────────────────────────────────────────────

export const AUTO_LOCK_MINUTES = [
  0, 1, 2, 5, 10, 15, 30, 60,
] as const satisfies readonly AutoLockMinutes[];

// ── Medios: nombres, consultas y lotes (§10.3) ─────────────────────────────────────────────────

export const MEDIA_NAME_MAX = 255;
export const PLAYLIST_NAME_MAX = 100;
export const MUSIC_TITLE_MAX = 200;
export const MERGE_NAME_MAX = 255;
export const SEARCH_MAX = 200;
/** dateFrom/dateTo: enteros entre 0 y este valor (9999-12-31T23:59:59.999Z). */
export const DATE_MAX_MS = 253402300799999;
/** ids de media:delete y playlists:addItems/removeItems: 1–100 000, sin duplicados. */
export const IDS_MAX = 100_000;
/** Elementos por playlist (PLAYLIST_FULL) y tamaño máximo de playlists:reorder (§9.2). */
export const PLAYLIST_MAX_ITEMS = 2000;
/** paths de import:paths: 1–10 000 elementos, cada uno de 1–32 767 unidades UTF-16. */
export const IMPORT_PATHS_MAX = 10_000;
export const PATH_MAX_UTF16 = 32_767;

/** edits:save. */
export const EDIT_OPS_MAX = 64;
export const CROP_MIN_SIZE = 0.01;
export const CROP_TOLERANCE = 1e-9;

/** PresentationSettings (§10.3). */
export const PRESENTATION_LIMITS = Object.freeze({
  transitionMsMin: 0,
  transitionMsMax: 3000,
  slideMsMin: 1000,
  slideMsMax: 60_000,
  slideMsStep: 500,
  musicFadeMsMin: 0,
  musicFadeMsMax: 5000,
  trackIdsMax: 100,
});

/** music:import (§8.6.1): archivos por diálogo y tamaño de cada uno. */
export const MUSIC_IMPORT_MAX_FILES = 200;
export const MUSIC_MAX_BYTES = 1 * GiB;
/** La firma de una pista se decide con los primeros 64 bytes (§8.6.1). */
export const MUSIC_SNIFF_BYTES = 64;
/** Filtro "Música" del diálogo de music:import (§8.6.1). Solo es una ayuda: decide la firma. */
export const MUSIC_DIALOG_EXTENSIONS: readonly string[] = Object.freeze([
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'wav',
]);

// ── Importación (§12.3) ────────────────────────────────────────────────────────────────────────

/** sniff.ts lee como mucho estos bytes del principio del archivo. */
export const SNIFF_MAX_BYTES = 512;
/** Recorrido de carpetas: profundidad y archivos por trabajo. */
export const WALK_MAX_DEPTH = 32;
export const WALK_MAX_FILES = 100_000;
/** Fotos: se procesan en memoria. */
export const PHOTO_MAX_BYTES = 256 * MiB;
/** limitInputPixels de sharp (≈ 268 MP), también para avatares (§14.4). */
export const MAX_INPUT_PIXELS = 268_402_689;
export const VIDEO_MAX_BYTES = 64 * GiB;
/** Espacio libre exigido: tamaño × 1,2 + 100 MiB. */
export const DISK_FREE_FACTOR = 1.2;
export const DISK_FREE_MARGIN_BYTES = 100 * MiB;

export type PhotoFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif';
export type VideoContainer = 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi';

/** Formatos de foto admitidos por firma (§12.3). BMP, HEIC y RAW se rechazan. */
export const PHOTO_FORMATS: Readonly<Record<PhotoFormat, { mime: string; extensions: string[] }>> =
  Object.freeze({
    jpeg: { mime: 'image/jpeg', extensions: ['jpg', 'jpeg', 'jfif'] },
    png: { mime: 'image/png', extensions: ['png'] },
    webp: { mime: 'image/webp', extensions: ['webp'] },
    gif: { mime: 'image/gif', extensions: ['gif'] },
    avif: { mime: 'image/avif', extensions: ['avif'] },
  });

/** Contenedores de vídeo admitidos por firma y el demuxer que se fuerza en ffmpeg (§12.4, paso 0). */
export const VIDEO_CONTAINERS: Readonly<
  Record<VideoContainer, { extensions: string[]; demuxer: 'mov' | 'matroska' | 'avi' }>
> = Object.freeze({
  mp4: { extensions: ['mp4', 'm4v'], demuxer: 'mov' },
  mov: { extensions: ['mov'], demuxer: 'mov' },
  webm: { extensions: ['webm'], demuxer: 'matroska' },
  mkv: { extensions: ['mkv'], demuxer: 'matroska' },
  avi: { extensions: ['avi'], demuxer: 'avi' },
});

/** Filtro de los diálogos de importación (§12.1). Solo es una ayuda: decide la firma. */
export const IMPORT_DIALOG_EXTENSIONS: readonly string[] = Object.freeze([
  'jpg',
  'jpeg',
  'jfif',
  'png',
  'webp',
  'gif',
  'avif',
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'avi',
]);

/** Filtro del diálogo de avatar (§10.3): solo fotos, sin BMP. */
export const AVATAR_DIALOG_EXTENSIONS: readonly string[] = Object.freeze(
  Object.values(PHOTO_FORMATS).flatMap((f) => f.extensions),
);
