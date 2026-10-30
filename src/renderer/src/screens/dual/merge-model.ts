// Cálculos puros del diálogo de fusión (docs/DESIGN.md §18.1, §18.2 y §18.7): valores por defecto,
// resolución de salida (solo informativa: `H` lo calcula main, PLAN.md nota 197 f) y los mensajes en
// español de cada error. Sin DOM, para probarlos en Vitest.
import type { AppError } from '@shared/errors';
import { MERGE_RESOLUTION_HEIGHTS } from '@shared/constants';
import type { MergeRequest, MergeResolution } from '@shared/types';
import { errorMessage } from '../../lib/errors-es';

export type MergeAudio = MergeRequest['audio'];
export type MergeDuration = MergeRequest['duration'];

/** Tope de la altura común (§18.2). */
export const MERGE_MAX_HEIGHT = 1080;

export const MERGE_AUDIO_OPTIONS: readonly { value: MergeAudio; label: string }[] = [
  { value: 'left', label: 'Izquierdo' },
  { value: 'right', label: 'Derecho' },
  { value: 'mix', label: 'Mezcla' },
  { value: 'none', label: 'Ninguno' },
];

export const MERGE_DURATION_OPTIONS: readonly { value: MergeDuration; label: string }[] = [
  { value: 'shortest', label: 'La del más corto' },
  { value: 'longest', label: 'La del más largo' },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "Fusión AAAA-MM-DD HH.mm" con la hora local (§18.1). */
export function defaultMergeName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `Fusión ${day} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** `null` (se desconoce) cuenta como "con audio": main rechaza la opción si de verdad no lo tiene. */
const hasSound = (hasAudio: boolean | null): boolean => hasAudio !== false;

/** Mezcla si los dos tienen audio; si no, el que lo tenga; si ninguno, ninguno (§18.1). */
export function defaultMergeAudio(left: boolean | null, right: boolean | null): MergeAudio {
  const l = hasSound(left);
  const r = hasSound(right);
  if (l && r) return 'mix';
  if (l) return 'left';
  if (r) return 'right';
  return 'none';
}

/** Las opciones de audio sin audio de origen aparecen deshabilitadas ("Ninguno" siempre vale). */
export function isMergeAudioAvailable(
  option: MergeAudio,
  left: boolean | null,
  right: boolean | null,
): boolean {
  switch (option) {
    case 'left':
      return hasSound(left);
    case 'right':
      return hasSound(right);
    case 'mix':
      return hasSound(left) || hasSound(right);
    case 'none':
      return true;
  }
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Valor de cada opción de resolución del formulario ('auto' o la altura en texto). */
export type MergeResolutionChoice = 'auto' | `${(typeof MERGE_RESOLUTION_HEIGHTS)[number]}`;

export const MERGE_RESOLUTION_AUTO_LABEL = 'Automática (recomendada)';

/** La petición de `merge:start` para una opción del formulario. */
export function resolutionOfChoice(choice: MergeResolutionChoice): MergeResolution {
  return choice === 'auto' ? 'auto' : (Number(choice) as MergeResolution);
}

/**
 * Opciones de resolución: «Automática (recomendada)» y 360, 480, 720 y 1080 px de alto. Las que
 * superan la altura del vídeo más alto llevan «(amplía la imagen)».
 */
export function mergeResolutionOptions(
  left: { height?: number | null } | null,
  right: { height?: number | null } | null,
): { value: MergeResolutionChoice; label: string }[] {
  const tallest = Math.max(left?.height ?? 0, right?.height ?? 0);
  return [
    { value: 'auto', label: MERGE_RESOLUTION_AUTO_LABEL },
    ...MERGE_RESOLUTION_HEIGHTS.map((h) => ({
      value: String(h) as MergeResolutionChoice,
      label: h > tallest ? `${h} px (amplía la imagen)` : `${h} px`,
    })),
  ];
}

/**
 * Resolución del vídeo fusionado: con «Automática», altura común `H = 2·floor(min(hL, hR, 1080)/2)`;
 * con una fija, esa altura. Cada lado se escala a `H` con `scale=-2:H` (ancho par, redondeo al más
 * cercano). Misma fórmula que `merge-service.ts`; null si falta alguna dimensión.
 */
export function mergeOutputSize(
  left: { width?: number | null; height?: number | null } | null,
  right: { width?: number | null; height?: number | null } | null,
  resolution: MergeResolution = 'auto',
): Dimensions | null {
  const lw = left?.width;
  const lh = left?.height;
  const rw = right?.width;
  const rh = right?.height;
  if (!lw || !lh || !rw || !rh || lw <= 0 || lh <= 0 || rw <= 0 || rh <= 0) return null;
  const height =
    resolution === 'auto' ? 2 * Math.floor(Math.min(lh, rh, MERGE_MAX_HEIGHT) / 2) : resolution;
  if (height < 2) return null;
  const scaled = (w: number, h: number): number => Math.floor((height * w + h) / (2 * h)) * 2;
  return { width: scaled(lw, lh) + scaled(rw, rh), height };
}

/** "560 × 180". */
export function formatSize(size: Dimensions): string {
  return `${size.width} × ${size.height}`;
}

/** Fracción 0–1 → entero 0–100. */
export function percentOf(fraction: number): number {
  return Number.isFinite(fraction) ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : 0;
}

export const MERGE_BUSY_MESSAGE = 'Ya hay una fusión en curso. Espera a que termine.';

const VALIDATION_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'same-video': 'Elige dos vídeos distintos.',
  'not-ready': 'Alguno de los vídeos ya no está disponible.',
  'not-video': 'Solo se pueden fusionar vídeos.',
  audio: 'El lado elegido no tiene audio. Elige otra opción de audio.',
  mime: 'Alguno de los vídeos tiene un formato que no se puede fusionar.',
  resolution: 'La resolución elegida no es válida. Elige otra.',
  metadata:
    'Faltan datos de alguno de los vídeos (tamaño o duración), así que no se puede fusionar.',
});

/**
 * Mensaje de un error de `merge:start` o `merge:done` (tabla de §18.7): BUSY y VALIDATION con su
 * motivo, y el resto por código. main no envía textos.
 */
export function mergeErrorMessage(error: AppError): string {
  switch (error.code) {
    case 'BUSY':
      return MERGE_BUSY_MESSAGE;
    case 'VALIDATION': {
      const reason = error.details?.reason;
      return typeof reason === 'string' && Object.hasOwn(VALIDATION_REASONS, reason)
        ? (VALIDATION_REASONS[reason] as string)
        : 'Algún dato de la fusión no es válido. Revisa las opciones e inténtalo de nuevo.';
    }
    case 'FFMPEG_MISSING':
      return 'Falta el componente de vídeo de Galería, así que no se puede crear el vídeo fusionado.';
    case 'FFMPEG_FAILED':
      return 'No se pudo crear el vídeo fusionado. Inténtalo de nuevo.';
    case 'DISK_FULL':
      return 'No queda espacio suficiente en el disco para el vídeo fusionado.';
    case 'INTEGRITY':
      return 'El vídeo fusionado no pasó la verificación, así que no se ha guardado. Inténtalo de nuevo.';
    case 'CANCELLED':
      return 'Fusión cancelada.';
    default:
      return errorMessage(error);
  }
}
