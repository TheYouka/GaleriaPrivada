// Matemática pura del rectángulo de recorte del editor (docs/DESIGN.md §16.4). Todo está en
// coordenadas normalizadas [0, 1] de la vista actual, igual que la operación `crop` (§10.1). Si hay
// una proporción fijada, `k = ancho/alto` en esas mismas unidades normalizadas (`ratioK`).
import { CROP_MIN_SIZE } from '@shared/constants';
import type { CropRect } from '@shared/edits';
import type { Size } from './zoom-math';

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const CROP_HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Nombre accesible de cada asa (§16.4). */
export const HANDLE_LABELS: Readonly<Record<CropHandle, string>> = {
  nw: 'Esquina superior izquierda del recorte',
  n: 'Borde superior del recorte',
  ne: 'Esquina superior derecha del recorte',
  e: 'Borde derecho del recorte',
  se: 'Esquina inferior derecha del recorte',
  s: 'Borde inferior del recorte',
  sw: 'Esquina inferior izquierda del recorte',
  w: 'Borde izquierdo del recorte',
};

/** Posición de cada asa sobre el rectángulo (0, 0.5 o 1 en cada eje). */
export const HANDLE_POSITION: Readonly<Record<CropHandle, readonly [number, number]>> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

/** Tamaño mínimo del rectángulo por eje (normalizado en la vista actual). */
export interface CropLimits {
  minW: number;
  minH: number;
}

/**
 * Límites para un recorte nuevo sobre una vista que ya mide `view.w × view.h` del marco: además de
 * `w, h ≥ 0,01` por operación (§10.3), el recorte acumulado tiene que ser ≥ 1 % del marco, o la
 * forma canónica de una lista de más de 64 operaciones no pasaría la validación (PLAN.md, nota 140).
 */
export function cropLimits(view: Pick<CropRect, 'w' | 'h'>): CropLimits {
  return {
    minW: Math.min(1, CROP_MIN_SIZE / Math.max(view.w, CROP_MIN_SIZE)),
    minH: Math.min(1, CROP_MIN_SIZE / Math.max(view.h, CROP_MIN_SIZE)),
  };
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), Math.max(lo, hi));

/** Proporciones de §16.4. `ratio` es ancho/alto en píxeles; "original" usa la de la vista. */
export interface CropRatio {
  id: string;
  label: string;
  /** null = libre; 'original' = la proporción de la vista actual. */
  ratio: number | 'original' | null;
}

export const CROP_RATIOS: readonly CropRatio[] = [
  { id: 'free', label: 'Libre', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '3:4', label: '3:4 vertical', ratio: 3 / 4 },
  { id: '2:3', label: '2:3 vertical', ratio: 2 / 3 },
  { id: '9:16', label: '9:16 vertical', ratio: 9 / 16 },
];

/** `k = ancho/alto` en unidades normalizadas para una proporción en píxeles de la vista `frame`. */
export function ratioK(ratio: CropRatio['ratio'], frame: Size): number | null {
  if (ratio === null || frame.w <= 0 || frame.h <= 0) return null;
  const px = ratio === 'original' ? frame.w / frame.h : ratio;
  return (px * frame.h) / frame.w;
}

/** Deja el rectángulo dentro de [0, 1] y con al menos el tamaño mínimo. */
export function clampRect(rect: CropRect, limits: CropLimits): CropRect {
  const w = clamp(rect.w, limits.minW, 1);
  const h = clamp(rect.h, limits.minH, 1);
  return { x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h), w, h };
}

/** Mueve el rectángulo sin cambiar su tamaño. */
export function moveRect(rect: CropRect, dx: number, dy: number): CropRect {
  return {
    x: clamp(rect.x + dx, 0, 1 - rect.w),
    y: clamp(rect.y + dy, 0, 1 - rect.h),
    w: rect.w,
    h: rect.h,
  };
}

/**
 * Ajusta el rectángulo a la proporción `k` sin salirse de él (conserva el centro): el mayor
 * rectángulo de esa proporción que cabe en el actual.
 */
export function fitRatio(rect: CropRect, k: number, limits: CropLimits): CropRect {
  let w = rect.w;
  let h = rect.h;
  if (w / h > k) w = h * k;
  else h = w / k;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  if (w < limits.minW) {
    w = limits.minW;
    h = w / k;
  }
  if (h < limits.minH) {
    h = limits.minH;
    w = h * k;
  }
  w = Math.min(w, 1, k);
  h = w / k;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

/**
 * Mueve el asa `handle` un desplazamiento (`dx`, `dy`) normalizado. Sin `k` los bordes son
 * independientes; con `k` el rectángulo conserva su proporción: una esquina deja fija la opuesta y un
 * borde deja fijo el contrario y se centra en el otro eje.
 */
export function resizeRect(
  rect: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  limits: CropLimits,
  k: number | null = null,
): CropRect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  const right0 = rect.x + rect.w;
  const bottom0 = rect.y + rect.h;

  if (k === null) {
    let left = rect.x;
    let right = right0;
    let top = rect.y;
    let bottom = bottom0;
    if (west) left = clamp(left + dx, 0, right - limits.minW);
    if (east) right = clamp(right + dx, left + limits.minW, 1);
    if (north) top = clamp(top + dy, 0, bottom - limits.minH);
    if (south) bottom = clamp(bottom + dy, top + limits.minH, 1);
    // El eje que no se toca conserva sus valores exactos (sin deriva de coma flotante).
    return {
      x: left,
      y: top,
      w: west || east ? right - left : rect.w,
      h: north || south ? bottom - top : rect.h,
    };
  }

  const wMin = Math.max(limits.minW, k * limits.minH);
  const isCorner = (west || east) && (north || south);
  if (isCorner) {
    const sx = east ? 1 : -1;
    const sy = south ? 1 : -1;
    const ax = east ? rect.x : right0;
    const ay = south ? rect.y : bottom0;
    const wantW = rect.w + sx * dx;
    const wantH = rect.h + sy * dy;
    const maxW = Math.min(sx > 0 ? 1 - ax : ax, k * (sy > 0 ? 1 - ay : ay));
    const w = clamp(Math.max(wantW, k * wantH), wMin, maxW);
    const h = w / k;
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  }
  if (west || east) {
    const sx = east ? 1 : -1;
    const ax = east ? rect.x : right0;
    const maxW = Math.min(sx > 0 ? 1 - ax : ax, k);
    const w = clamp(rect.w + sx * dx, wMin, maxW);
    const h = w / k;
    const cy = rect.y + rect.h / 2;
    return { x: sx > 0 ? ax : ax - w, y: clamp(cy - h / 2, 0, 1 - h), w, h };
  }
  const sy = south ? 1 : -1;
  const ay = south ? rect.y : bottom0;
  const hMin = Math.max(limits.minH, limits.minW / k);
  const maxH = Math.min(sy > 0 ? 1 - ay : ay, 1 / k);
  const h = clamp(rect.h + sy * dy, hMin, maxH);
  const w = h * k;
  const cx = rect.x + rect.w / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: sy > 0 ? ay : ay - h, w, h };
}

/** Desplazamiento de una flecha: `step` (0,01 o 0,1 con Mayús) por eje, o null si no es una flecha. */
export function arrowDelta(key: string, step: number): { dx: number; dy: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return null;
  }
}
