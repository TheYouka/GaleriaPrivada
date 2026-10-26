// Modelo de edición no destructiva (docs/DESIGN.md §16.3). Puro y sin dependencias: lo usan main
// (edits-render.ts, edits:save, la regeneración de miniaturas) y el renderer (EditedImage, Editor).
//
// Estado canónico: EditState = { q: 0..3, flip, crop: {x, y, w, h} }. La orientación es
// T = F^flip ∘ R^q (primero se rota q cuartos de vuelta en sentido horario y después, si flip, se
// voltea en horizontal); `crop` está normalizado en el marco ya orientado. La orientación EXIF se
// aplica siempre antes (W×H son las dimensiones tras EXIF).
//
// foldEdits(ops) parte de la identidad y aplica cada operación con la tabla de §16.3:
//   rotate q' → q ← flip ? (q − q') mod 4 : (q + q') mod 4; recorte, por cada cuarto horario,
//               (1−y−h, x, h, w)   (R ∘ F = F ∘ R⁻¹)
//   flipH     → flip ← !flip; recorte (1−x−w, y, w, h)
//   flipV     → rotate 2 y después flipH; recorte (x, 1−y−h, w, h)
//   crop c    → recorte (x + cx·w, y + cy·h, cw·w, ch·h)
import { CROP_MIN_SIZE, CROP_TOLERANCE, EDIT_OPS_MAX } from './constants';
import type { EditOp } from './types';

export type Quarter = 0 | 1 | 2 | 3;

/** Rectángulo normalizado [0, 1] en el marco orientado. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditState {
  q: Quarter;
  flip: boolean;
  crop: CropRect;
}

export const FULL_CROP: Readonly<CropRect> = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

export function identityState(): EditState {
  return { q: 0, flip: false, crop: { ...FULL_CROP } };
}

const mod4 = (n: number): Quarter => (((n % 4) + 4) % 4) as Quarter;

/** Un cuarto de vuelta horario de la vista: el recorte (x, y, w, h) pasa a (1−y−h, x, h, w). */
function rotateCrop(c: CropRect): CropRect {
  return { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
}

/** Aplica una operación al estado (tabla de §16.3). No modifica `state`. */
export function applyEdit(state: EditState, op: EditOp): EditState {
  switch (op.t) {
    case 'rotate': {
      let crop = state.crop;
      for (let i = 0; i < op.q; i += 1) crop = rotateCrop(crop);
      return { q: mod4(state.flip ? state.q - op.q : state.q + op.q), flip: state.flip, crop };
    }
    case 'flipH': {
      const c = state.crop;
      return { q: state.q, flip: !state.flip, crop: { x: 1 - c.x - c.w, y: c.y, w: c.w, h: c.h } };
    }
    case 'flipV': {
      // Equivale a rotate 2 y después flipH (±2 es lo mismo módulo 4); el recorte se calcula
      // directamente, (x, 1−y−h, w, h), para no acumular deriva de coma flotante.
      const c = state.crop;
      return {
        q: mod4(state.q + 2),
        flip: !state.flip,
        crop: { x: c.x, y: 1 - c.y - c.h, w: c.w, h: c.h },
      };
    }
    case 'crop': {
      const c = state.crop;
      return {
        q: state.q,
        flip: state.flip,
        crop: { x: c.x + op.x * c.w, y: c.y + op.y * c.h, w: op.w * c.w, h: op.h * c.h },
      };
    }
  }
}

/** Estado canónico de una lista de operaciones, en orden. */
export function foldEdits(ops: readonly EditOp[]): EditState {
  let state = identityState();
  for (const op of ops) state = applyEdit(state, op);
  return state;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= CROP_TOLERANCE;

/** ¿El recorte es la imagen entera (con la tolerancia de §10.3)? */
export function isFullCrop(c: CropRect): boolean {
  return near(c.x, 0) && near(c.y, 0) && near(c.w, 1) && near(c.h, 1);
}

/** ¿Dos estados dan la misma imagen (recorte con la tolerancia de §10.3)? */
export function sameEditState(a: EditState, b: EditState): boolean {
  return (
    a.q === b.q &&
    a.flip === b.flip &&
    near(a.crop.x, b.crop.x) &&
    near(a.crop.y, b.crop.y) &&
    near(a.crop.w, b.crop.w) &&
    near(a.crop.h, b.crop.h)
  );
}

/** ¿El estado no cambia nada respecto al original (tras EXIF)? */
export function isIdentity(state: EditState): boolean {
  return state.q === 0 && !state.flip && isFullCrop(state.crop);
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Recorte saneado: dentro de [0, 1] y con x + w ≤ 1, y + h ≤ 1 (deriva de coma flotante). */
function clampCrop(c: CropRect): CropRect {
  const x = clamp01(c.x);
  const y = clamp01(c.y);
  return { x, y, w: Math.min(clamp01(c.w), 1 - x), h: Math.min(clamp01(c.h), 1 - y) };
}

/**
 * Forma canónica (§16.4): como mucho 3 operaciones, `rotate q`, `flipH` y `crop`, en ese orden.
 * foldEdits(canonicalOps(s)) da el mismo estado que `s` (salvo la deriva de coma flotante que
 * absorbe el saneado del recorte).
 */
export function canonicalOps(state: EditState): EditOp[] {
  const ops: EditOp[] = [];
  if (state.q !== 0) ops.push({ t: 'rotate', q: state.q });
  if (state.flip) ops.push({ t: 'flipH' });
  if (!isFullCrop(state.crop)) ops.push({ t: 'crop', ...clampCrop(state.crop) });
  return ops;
}

/** "Guardar" (§16.4): si la lista supera EDIT_OPS_MAX operaciones, se colapsa a su forma canónica. */
export function opsForSave(ops: readonly EditOp[]): EditOp[] {
  return ops.length > EDIT_OPS_MAX ? canonicalOps(foldEdits(ops)) : [...ops];
}

const unit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Las reglas de `ops` de §10.3 para una operación: `crop` con valores finitos en [0, 1],
 * w, h ≥ 0,01, x + w ≤ 1 e y + h ≤ 1 (tolerancia 1e-9). Sin claves extra.
 */
export function isEditOp(value: unknown): value is EditOp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  switch (v.t) {
    case 'rotate':
      return keys === 'q,t' && (v.q === 1 || v.q === 2 || v.q === 3);
    case 'flipH':
    case 'flipV':
      return keys === 't';
    case 'crop':
      return (
        keys === 'h,t,w,x,y' &&
        unit(v.x) &&
        unit(v.y) &&
        unit(v.w) &&
        unit(v.h) &&
        v.w >= CROP_MIN_SIZE &&
        v.h >= CROP_MIN_SIZE &&
        v.x + v.w <= 1 + CROP_TOLERANCE &&
        v.y + v.h <= 1 + CROP_TOLERANCE
      );
    default:
      return false;
  }
}

/** Dimensiones del marco orientado: (W', H') = q impar ? (H, W) : (W, H). */
export function orientedSize(
  state: Pick<EditState, 'q'>,
  width: number,
  height: number,
): { width: number; height: number } {
  return state.q % 2 === 1 ? { width: height, height: width } : { width, height };
}

/** Región del recorte en píxeles del marco orientado de `width × height` (W' × H'). */
export interface PixelRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Región en píxeles (§16.3): left = round(x·W'), top = round(y·H'), width = max(1, round(w·W')),
 * height = max(1, round(h·H')), acotada para que quede dentro del marco (el redondeo de x y de w
 * por separado podría salirse un píxel).
 */
export function cropRegion(crop: CropRect, frameWidth: number, frameHeight: number): PixelRegion {
  const axis = (start: number, size: number, total: number): [number, number] => {
    const a = Math.min(Math.max(0, Math.round(start * total)), total - 1);
    const len = Math.min(Math.max(1, Math.round(size * total)), total - a);
    return [a, len];
  };
  const [left, width] = axis(crop.x, crop.w, frameWidth);
  const [top, height] = axis(crop.y, crop.h, frameHeight);
  return { left, top, width, height };
}

/** Parámetros para sharp (§16.3). */
export interface SharpEditParams {
  /** `.flop()` (antes de la rotación en sharp). */
  flop: boolean;
  /** `.rotate(angle)`, con q2 = flip ? (4 − q) mod 4 : q, porque F ∘ R^q = R^(−q) ∘ F. */
  angle: 0 | 90 | 180 | 270;
}

export function sharpParams(state: EditState): SharpEditParams {
  const q2 = state.flip ? mod4(4 - state.q) : state.q;
  return { flop: state.flip, angle: (q2 * 90) as SharpEditParams['angle'] };
}
