// Tipos compartidos (docs/DESIGN.md §10.1). Son tipos puros: este archivo lo empaquetan main, el
// preload y el renderer. Los tipos de fases posteriores ya están declarados para que el contrato
// IPC sea estable.
import type { Result } from './errors';
import type { ThemeId } from './themes';

export type { ThemeId } from './themes';

export type Id = string; // /^[0-9a-f]{32}$/

export type ColorSchemePref = 'system' | 'light' | 'dark';

export type BuiltinAvatarId =
  | 'aurora'
  | 'bosque'
  | 'coral'
  | 'duna'
  | 'eclipse'
  | 'fresa'
  | 'glaciar'
  | 'hoja'
  | 'lava'
  | 'marea'
  | 'nebula'
  | 'sol';

export type AvatarRef = { type: 'builtin'; id: BuiltinAvatarId } | { type: 'custom'; rev: number };
export type AvatarInput =
  { type: 'builtin'; id: BuiltinAvatarId } | { type: 'custom'; token: string };

export interface AppInfo {
  version: string;
  platform: 'win32' | 'linux';
  ffmpegAvailable: boolean;
}

export interface WindowState {
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
  focused: boolean;
  visible: boolean;
}

export interface GlobalSettings {
  pickerThemeId: ThemeId;
  colorScheme: ColorSchemePref;
}

export interface ProfileSummary {
  id: Id;
  name: string;
  avatar: AvatarRef;
  vaultStatus: 'ok' | 'unavailable';
  /** De prefs, para pintar tras desbloquear. */
  themeId: ThemeId | null;
}

/** 0 = desactivado. */
export type AutoLockMinutes = 0 | 1 | 2 | 5 | 10 | 15 | 30 | 60;

export interface ProfilePrefs {
  themeId: ThemeId | null;
  colorScheme: ColorSchemePref | null;
  autoLockMinutes: AutoLockMinutes;
  /** D15, por defecto true. */
  contentProtection: boolean;
  gridSize: 'small' | 'medium' | 'large';
  gallerySort: MediaSort;
  presentationDefaults: PresentationPlainSettings;
}

export type SessionState =
  | { state: 'locked' }
  | { state: 'unlocking'; profileId: Id }
  /** maintenance: traslado de la bóveda (§8.7). */
  | { state: 'unlocked'; profileId: Id; maintenance: { jobId: Id } | null }
  | { state: 'locking'; profileId: Id };

export type LockReason =
  'manual' | 'inactivity' | 'suspend' | 'os-lock' | 'vault-unavailable' | 'error' | 'shutdown';

export type MediaKind = 'photo' | 'video';

export interface MediaSort {
  /** 'position' solo con playlistId. */
  field: 'captured' | 'imported' | 'name' | 'size' | 'duration' | 'position';
  dir: 'asc' | 'desc';
}

export interface MediaQuery {
  kind: 'all' | MediaKind;
  search?: string;
  dateFrom?: number;
  dateTo?: number;
  playlistId?: Id;
  sort: MediaSort;
}

export interface MediaListItem {
  id: Id;
  kind: MediaKind;
  name: string;
  ext: string;
  /** Hora local naive (§12.8). */
  capturedAt: number;
  importedAt: number;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumbRev: number;
}

export interface ExifSummary {
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  fNumber?: number;
  exposureS?: number;
  iso?: number;
  focalMm?: number;
}

export interface MediaDetail extends MediaListItem {
  mime: string;
  originalSizeBytes: number;
  /** Salida de ffmpeg (§9.2). */
  converted: boolean;
  hasAudio: boolean | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  exif: ExifSummary | null;
  edits: EditOp[];
}

/** Motivo de `library:changed` (§10.2). */
export type LibraryChangeReason = 'import' | 'delete' | 'rename' | 'edit' | 'merge' | 'playlist';

/** Payload de `library:changed`: sin `ids` cuando se agrupa durante un trabajo. */
export interface LibraryChanged {
  reason: LibraryChangeReason;
  ids?: Id[];
}

export type EditOp =
  /** Cuartos de vuelta en sentido horario. */
  | { t: 'rotate'; q: 1 | 2 | 3 }
  | { t: 'flipH' }
  | { t: 'flipV' }
  /** Normalizado [0,1] sobre la vista actual. */
  | { t: 'crop'; x: number; y: number; w: number; h: number };

export interface ImportProgress {
  jobId: Id;
  total: number;
  done: number;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  currentName: string | null;
  phase:
    'scanning' | 'awaiting-confirmation' | 'encrypting' | 'converting' | 'verifying' | 'finalizing';
}

/** §12.5.1. */
export interface ImportConfirmNeeded {
  jobId: Id;
  toConvert: number;
  toConvertBytes: number;
}

export type ImportFailureCode =
  | 'UNSUPPORTED_FORMAT'
  | 'TOO_LARGE'
  | 'DISK_FULL'
  | 'IO'
  | 'INTEGRITY'
  | 'FFMPEG_MISSING'
  | 'FFMPEG_FAILED'
  | 'CANCELLED'
  | 'CHANGED_DURING_IMPORT';

export interface ImportReport {
  jobId: Id;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: { name: string; code: ImportFailureCode }[];
  /**
   * Originales que se conservaron aunque su copia ya está en la bóveda (§12.4 pasos 8–9). La ruta
   * es el único sitio donde el renderer ve rutas ([H3-8], §14.6). `CANCELLED`: "Cancelar" llegó
   * después del paso 5 de ese archivo (PLAN.md, nota 105).
   */
  originalsNotDeleted: { path: string; reason: 'IO' | 'CHANGED_DURING_IMPORT' | 'CANCELLED' }[];
  cancelled: boolean;
}

export interface PlaylistSummary {
  id: Id;
  name: string;
  itemCount: number;
  coverMediaId: Id | null;
  hasCustomPresentation: boolean;
  updatedAt: number;
}

export interface MusicTrack {
  id: Id;
  title: string;
  durationMs: number | null;
  sizeBytes: number;
}

/** §8.6.1. */
export interface MusicImportResult {
  imported: MusicTrack[];
  failed: { name: string; code: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DISK_FULL' | 'IO' }[];
}

export type TransitionKind = 'fade' | 'slide' | 'zoom' | 'kenburns';

/** Qué suena DURANTE los vídeos. */
export type AudioMode = 'video' | 'music' | 'both' | 'mute';

export interface PresentationPlainSettings {
  transition: TransitionKind | 'random' | 'none';
  randomPool: TransitionKind[];
  transitionMs: number;
  slideMs: number;
  loop: boolean;
  /**
   * «Animaciones» del diálogo de inicio: Ken Burns (movimiento lento) en las fotos con cualquier
   * transición; si es false, las fotos se quedan quietas (las otras tres cosas que se pueden apagar
   * son `transition: 'none'`, `musicEnabled` y `loop`). PLAN.md notas 178 y 191.
   */
  animations: boolean;
  startFullscreen: boolean;
  audioMode: AudioMode;
  musicEnabled: boolean;
  musicVolume: number;
  videoVolume: number;
  musicFadeMs: number;
}

/**
 * Forma del IPC. En disco se separa: lo "plain" va a presentation_json / prefs y trackIds a
 * playlist_music / kv (§9.2).
 */
export interface PresentationSettings extends PresentationPlainSettings {
  trackIds: Id[];
}

export interface MergeRequest {
  leftId: Id;
  rightId: Id;
  audio: 'left' | 'right' | 'mix' | 'none';
  duration: 'shortest' | 'longest';
  name: string;
}

/** `merge:progress` (§10.2, §18.6 paso 2): como mucho cada 250 ms. `fraction` en [0, 1]. */
export interface MergeProgress {
  jobId: Id;
  fraction: number;
}

/**
 * `merge:done` (§18.6, §18.7). `existed: true` = ya había un vídeo idéntico y `mediaId` es el suyo.
 * No llega si un bloqueo interrumpe la fusión (la ventana se sustituye).
 */
export interface MergeDone {
  jobId: Id;
  result: Result<{ mediaId: Id; existed: boolean }>;
}

/**
 * Ajustes → Almacenamiento (§14.9). `path` es la ubicación de la bóveda: junto con las rutas de
 * los originales no borrados (§14.6), la única ruta que ve el renderer [H3-8].
 */
export interface VaultInfo {
  location: 'default' | 'custom';
  path: string;
  sizeBytes: number;
  freeBytes: number;
}

/**
 * Progreso del traslado (§8.7, paso 4). `totalBytes` cuenta la copia y la verificación (dos veces
 * el tamaño de lo que se copia): `copiedBytes === totalBytes` marca el paso 5, desde el que
 * "Cancelar" ya no tiene efecto (PLAN.md, nota 117).
 */
export interface RelocateProgress {
  jobId: Id;
  copiedBytes: number;
  totalBytes: number;
}

/** Fin del traslado (§8.7). `leftoverPath`: restos de la bóveda antigua que no se pudieron borrar. */
export interface RelocateDone {
  jobId: Id;
  result: Result<VaultInfo & { leftoverPath?: string }>;
}
