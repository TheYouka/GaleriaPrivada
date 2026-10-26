// Cálculos puros del reproductor de vídeo (docs/DESIGN.md §16.6): velocidades, volumen, saltos,
// rangos cargados, duración y visibilidad de los controles. Sin DOM, para probarlos en Vitest.

/** Velocidades del menú (0,25×–2×, §16.6). */
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_SPEED = 1;
/** −10 s / +10 s (botones, J/L y Mayús+←/→). */
export const SEEK_STEP_S = 10;
/** ←/→ con el foco en la barra de progreso. */
export const BAR_ARROW_S = 5;
/** ↑/↓ cambian el volumen un 5 %. */
export const VOLUME_STEP = 0.05;
/** Los controles se ocultan a los 2,5 s sin movimiento mientras se reproduce. */
export const CONTROLS_HIDE_MS = 2500;
/** La barra de progreso trabaja en milésimas de la duración. */
export const BAR_RESOLUTION = 1000;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** El paso de velocidad más cercano a `current` en la dirección dada (se queda en los extremos). */
export function stepSpeed(current: number, dir: 1 | -1): number {
  let nearest = 0;
  for (const [i, s] of SPEEDS.entries()) {
    if (Math.abs(s - current) < Math.abs((SPEEDS[nearest] ?? 1) - current)) nearest = i;
  }
  const next = clamp(nearest + dir, 0, SPEEDS.length - 1);
  return SPEEDS[next] ?? DEFAULT_SPEED;
}

/** 0.25 → "0,25×"; 1 → "1×". */
export function formatSpeed(speed: number): string {
  return `${String(speed).replace('.', ',')}×`;
}

/** Volumen ±5 % sin arrastrar error de coma flotante. */
export function stepVolume(volume: number, dir: 1 | -1): number {
  const steps = Math.round(volume / VOLUME_STEP) + dir;
  return clamp(Math.round(steps * VOLUME_STEP * 100) / 100, 0, 1);
}

/** Tiempo tras saltar `delta` segundos, dentro de [0, duración] (sin duración, solo ≥ 0). */
export function seekTime(current: number, delta: number, duration: number): number {
  const target = Math.max(0, current + delta);
  return duration > 0 ? Math.min(duration, target) : target;
}

/**
 * Duración en segundos: `video.duration` si es finita; si no (por ejemplo, Infinity mientras no se
 * conoce), la `durationMs` de la DB (§18.4); 0 si no hay ninguna.
 */
export function effectiveDuration(videoDuration: number, dbDurationMs: number | null): number {
  if (Number.isFinite(videoDuration) && videoDuration > 0) return videoDuration;
  return dbDurationMs !== null && dbDurationMs > 0 ? dbDurationMs / 1000 : 0;
}

/** Posición de la barra (0–1000) para un tiempo. */
export function toBarValue(time: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return clamp(Math.round((time / duration) * BAR_RESOLUTION), 0, BAR_RESOLUTION);
}

/** Tiempo (s) de una posición de la barra. */
export function fromBarValue(value: number, duration: number): number {
  return clamp((value / BAR_RESOLUTION) * duration, 0, duration);
}

export interface BufferedSegment {
  /** Porcentaje del ancho de la barra donde empieza. */
  left: number;
  /** Porcentaje del ancho de la barra que ocupa. */
  width: number;
}

/** Los rangos cargados (`video.buffered`) como segmentos en porcentaje, ya fusionados y acotados. */
export function bufferedSegments(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  duration: number,
): BufferedSegment[] {
  if (!(duration > 0)) return [];
  const sorted = ranges
    .map((r) => ({ start: clamp(r.start, 0, duration), end: clamp(r.end, 0, duration) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.map((r) => ({
    left: (r.start / duration) * 100,
    width: ((r.end - r.start) / duration) * 100,
  }));
}

// Códigos de MediaError.
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

export const VIDEO_ERROR_MESSAGE = 'No se puede reproducir este vídeo.';
export const VIDEO_DAMAGED_MESSAGE = 'No se puede reproducir este vídeo: el archivo está dañado.';

/**
 * Mensaje del evento `error` del <video> (§16.6). El renderer no puede leer `X-Galeria-Error`
 * (la CSP no deja `connect-src vault:`, nota 154): un corte de lectura o de descifrado a mitad
 * (`MEDIA_ERR_NETWORK`/`MEDIA_ERR_DECODE`) es el caso `INTEGRITY` y dice "archivo dañado"; el resto
 * (formato no admitido, abortado) dice el mensaje genérico.
 */
export function videoErrorMessage(code: number | null | undefined): string {
  return code === MEDIA_ERR_NETWORK || code === MEDIA_ERR_DECODE
    ? VIDEO_DAMAGED_MESSAGE
    : VIDEO_ERROR_MESSAGE;
}

export interface ControlsState {
  playing: boolean;
  /** Hubo movimiento o una tecla hace menos de CONTROLS_HIDE_MS. */
  recentActivity: boolean;
  /** El foco está dentro de los controles. */
  focusWithin: boolean;
  /** El puntero está sobre los controles. */
  hovering: boolean;
  /** El menú de velocidad está abierto. */
  menuOpen: boolean;
  error: boolean;
}

/** Los controles se ven en pausa, con error, con el foco dentro, con el puntero encima o recientes. */
export function controlsVisible(s: ControlsState): boolean {
  return !s.playing || s.error || s.recentActivity || s.focusWithin || s.hovering || s.menuOpen;
}
