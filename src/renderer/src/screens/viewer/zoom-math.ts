// Matemática pura del visor (docs/DESIGN.md §16.1 y §16.2): zoom y desplazamiento, ajuste "contain",
// proporción de una foto editada y el punto de partida de la animación FLIP. Sin React ni DOM.
//
// Modelo del zoom: el contenido (la "caja" de `box` px) está centrado en la vista (`viewport` px) y se
// pinta con `transform: translate(x, y) scale(s)` y `transform-origin` en su centro. Por eso un
// punto de la vista se expresa respecto al centro de la vista (`anchor`), y un punto del contenido
// `u` (respecto a su centro) queda en la pantalla en `p = t + s·u`.
import { orientedSize, type EditState } from '@shared/edits';

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** Rueda: `s ← s · 1.1^(−deltaY/100)` (§16.2). */
export const WHEEL_BASE = 1.1;
/** `+` y `−` (§16.2). */
export const KEY_ZOOM_FACTOR = 1.25;
/** El doble clic alterna entre 1 (ajustar) y 2. */
export const DOUBLE_CLICK_SCALE = 2;
/** Con `s > 1`, las flechas desplazan un 10 % de la vista (§16.2). */
export const PAN_STEP = 0.1;

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Escala y desplazamiento (px) del contenido respecto a su posición centrada. */
export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const FIT: Readonly<ZoomState> = Object.freeze({ scale: 1, x: 0, y: 0 });

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Escala tras un paso de la rueda (o del pellizco, que llega como ctrl+rueda). */
export function wheelScale(scale: number, deltaY: number): number {
  return clampScale(scale * WHEEL_BASE ** (-deltaY / 100));
}

/** Desplazamiento máximo por eje (≥ 0): el contenido ampliado nunca deja hueco en los bordes. */
export function maxPan(scale: number, box: Size, viewport: Size): Point {
  return {
    x: Math.max(0, (box.w * scale - viewport.w) / 2),
    y: Math.max(0, (box.h * scale - viewport.h) / 2),
  };
}

const clampAxis = (value: number, max: number): number => Math.min(max, Math.max(-max, value));

/** Limita el desplazamiento para que no aparezca hueco más allá de los bordes (§16.2). */
export function clampPan(state: ZoomState, box: Size, viewport: Size): ZoomState {
  const scale = clampScale(state.scale);
  const max = maxPan(scale, box, viewport);
  // `+ 0` evita -0 cuando el máximo es 0.
  return { scale, x: clampAxis(state.x, max.x) + 0, y: clampAxis(state.y, max.y) + 0 };
}

/**
 * Cambia la escala dejando quieto el punto de la vista bajo `anchor` (respecto al centro de la
 * vista): u = (p − t)/s → t' = p − (s'/s)·(p − t). Después limita el desplazamiento.
 */
export function zoomAt(
  state: ZoomState,
  nextScale: number,
  anchor: Point,
  box: Size,
  viewport: Size,
): ZoomState {
  const scale = clampScale(nextScale);
  const ratio = scale / state.scale;
  return clampPan(
    {
      scale,
      x: anchor.x - ratio * (anchor.x - state.x),
      y: anchor.y - ratio * (anchor.y - state.y),
    },
    box,
    viewport,
  );
}

/** Doble clic: de ajustar (1) a 2 centrado en el punto, y de cualquier ampliación a ajustar. */
export function toggleZoom(state: ZoomState, anchor: Point, box: Size, viewport: Size): ZoomState {
  if (state.scale > MIN_SCALE) return { ...FIT };
  return zoomAt(state, DOUBLE_CLICK_SCALE, anchor, box, viewport);
}

/** Desplaza (px) y limita. */
export function panBy(
  state: ZoomState,
  dx: number,
  dy: number,
  box: Size,
  viewport: Size,
): ZoomState {
  return clampPan({ ...state, x: state.x + dx, y: state.y + dy }, box, viewport);
}

/** La caja "contain" de proporción `aspect` (ancho/alto) dentro de `available`. */
export function fitContain(aspect: number, available: Size): Size {
  if (!(aspect > 0) || !Number.isFinite(aspect) || available.w <= 0 || available.h <= 0) {
    return { w: 0, h: 0 };
  }
  const w = Math.min(available.w, available.h * aspect);
  return { w, h: w / aspect };
}

/**
 * Proporción ancho/alto de una foto con sus ediciones (§16.3): el marco orientado mide (W', H') y el
 * recorte se queda con (w·W') × (h·H'). `width` × `height` son las dimensiones tras EXIF.
 */
export function editedAspect(state: EditState, width: number, height: number): number {
  const frame = orientedSize(state, width, height);
  return (state.crop.w * frame.width) / (state.crop.h * frame.height);
}

export interface FlipStart {
  /** Desplazamiento del centro de la caja final al centro del mosaico. */
  x: number;
  y: number;
  /** Escala "cover": la caja final cubre el mosaico. */
  scale: number;
  /** `clip-path` que deja visible solo lo que muestra el mosaico (imita `object-fit: cover`). */
  clipPath: string;
}

/** Estado final del FLIP: la caja "contain" entera, sin recorte. */
export const FLIP_END_CLIP = 'inset(0px 0px 0px 0px round 0px)';

/**
 * Punto de partida (o de llegada, al cerrar) de la animación FLIP (§16.1): `box` es el rect final
 * "contain" y `tile` el del mosaico. El elemento se anima de `{x, y, scale, clipPath}` a la
 * identidad con `transform-origin` en su centro.
 */
export function flipStart(box: Rect, tile: Rect, tileRadius = 0): FlipStart {
  const scale = Math.max(tile.width / box.width, tile.height / box.height);
  // Parte visible en coordenadas locales (antes de escalar): lo que ocupa el mosaico entre `scale`.
  const insetX = Math.max(0, (box.width - tile.width / scale) / 2);
  const insetY = Math.max(0, (box.height - tile.height / scale) / 2);
  const r = Math.max(0, tileRadius) / scale;
  return {
    x: tile.left + tile.width / 2 - (box.left + box.width / 2),
    y: tile.top + tile.height / 2 - (box.top + box.height / 2),
    scale,
    clipPath: `inset(${insetY}px ${insetX}px ${insetY}px ${insetX}px round ${r}px)`,
  };
}

/** ¿Los dos rects se solapan (el mosaico sigue a la vista dentro de la rejilla)? */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/** `cubic-bezier(a, b, c, d)` de un token de movimiento → los cuatro puntos (o el respaldo). */
export function parseCubicBezier(
  value: string,
  fallback: readonly [number, number, number, number] = [0.3, 0, 0, 1],
): [number, number, number, number] {
  const m =
    /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(
      value.trim(),
    );
  if (!m) return [...fallback];
  const nums = [m[1], m[2], m[3], m[4]].map(Number);
  return nums.every(Number.isFinite)
    ? [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number]
    : [...fallback];
}
