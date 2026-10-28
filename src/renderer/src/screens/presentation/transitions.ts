// Transiciones de la presentación (docs/DESIGN.md §17.3). Puro: describe qué animar (opacidad y
// transform de dos capas A/B); el componente lo pasa a Motion `animate()`. Sin React ni DOM.
//
// Momento de la elección aleatoria (PLAN.md nota 172): el planificador pide UN plan por transición,
// justo cuando esa transición empieza (no al precargar ni al cambiar ajustes). Con `random` se
// consume exactamente una llamada al RNG para elegir del grupo (aunque solo quede un candidato) y,
// en cada foto con «Animaciones» activado, dos más (dirección y desplazamiento de Ken Burns).
//
// Ken Burns lo gobierna solo «Animaciones» (PLAN.md nota 191): vale con cualquier transición, también
// con el corte, y nunca en un vídeo. La presentación NO mira `prefers-reduced-motion`: el tipo y la
// duración de la transición y las animaciones son una elección explícita del usuario.
import type { MediaKind, TransitionKind } from '@shared/types';

export type TransitionSetting = TransitionKind | 'random' | 'none';
/** Tipo ya resuelto (sin `random`). */
export type ConcreteTransition = TransitionKind | 'none';
export type Direction = 'forward' | 'back';
/** Número en [0, 1) como `Math.random`. */
export type Rng = () => number;

export const MAX_TRANSITION_MS = 3000;
export const KEN_BURNS_MAX_SCALE = 1.12;
const DEFAULT_POOL: readonly TransitionKind[] = ['fade'];

/** `cubic-bezier(x1, y1, x2, y2)`. */
export type Bezier = readonly [number, number, number, number];

export const EASINGS: Readonly<Record<TransitionKind, Bezier>> = {
  fade: [0.4, 0, 0.2, 1],
  slide: [0.2, 0, 0, 1],
  zoom: [0, 0, 0.2, 1],
  kenburns: [0.4, 0, 0.2, 1],
};

export interface LayerFrame {
  opacity: number;
  transform: string;
}

export interface LayerAnimation {
  from: LayerFrame;
  to: LayerFrame;
}

export interface KenBurnsPlan {
  zoomIn: boolean;
  /** Escala inicial y final (1 → 1,12 o 1,12 → 1). */
  scaleFrom: number;
  scaleTo: number;
  /** Desplazamiento en % de la capa (3–5 % en una de 8 direcciones). */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromTransform: string;
  toTransform: string;
  /** D + slideMs + D, lineal. */
  durationMs: number;
}

export interface TransitionPlan {
  /** Lo que pidieron los ajustes (`random` incluido). */
  requested: TransitionSetting;
  /** Lo que salió del ajuste o del sorteo, antes de los cambios (duración 0, Ken Burns). */
  picked: ConcreteTransition;
  /** Lo que se anima de verdad. */
  type: ConcreteTransition;
  /** 0 = corte instantáneo (`none`). */
  durationMs: number;
  easing: Bezier | null;
  /** `null` = corte. */
  incoming: LayerAnimation | null;
  outgoing: LayerAnimation | null;
  kenBurns: KenBurnsPlan | null;
}

/** Un elemento del grupo aleatorio, sin repetir el anterior si hay más de uno (§17.3). */
export function pickFromPool(
  pool: readonly TransitionKind[],
  previous: ConcreteTransition | null,
  rng: Rng,
): TransitionKind {
  const unique = [...new Set(pool)];
  const base = unique.length > 0 ? unique : [...DEFAULT_POOL];
  const withoutPrevious = base.filter((k) => k !== previous);
  const candidates = withoutPrevious.length > 0 ? withoutPrevious : base;
  return candidates[randomIndex(rng, candidates.length)];
}

function randomIndex(rng: Rng, length: number): number {
  const r = rng();
  const i = Number.isFinite(r) ? Math.floor(r * length) : 0;
  return Math.min(length - 1, Math.max(0, i));
}

export interface EffectiveOptions {
  transitionMs: number;
}

/**
 * Tipo y duración reales: 0 ms = `none`; `kenburns` se anima como `fade` (el movimiento de las fotos
 * ya no depende del tipo, nota 191).
 */
export function effectiveTransition(
  picked: ConcreteTransition,
  o: EffectiveOptions,
): { type: ConcreteTransition; durationMs: number } {
  const ms = Number.isFinite(o.transitionMs)
    ? Math.min(MAX_TRANSITION_MS, Math.max(0, o.transitionMs))
    : 0;
  if (picked === 'none' || ms <= 0) return { type: 'none', durationMs: 0 };
  if (picked === 'kenburns') return { type: 'fade', durationMs: ms };
  return { type: picked, durationMs: ms };
}

const IDENTITY = 'none';

/** Fotogramas de entrada y salida de un tipo (sin sorteos). `back` invierte el deslizamiento. */
export function describeLayers(
  type: ConcreteTransition,
  direction: Direction,
): { incoming: LayerAnimation | null; outgoing: LayerAnimation | null } {
  switch (type) {
    case 'none':
      return { incoming: null, outgoing: null };
    case 'fade':
    case 'kenburns':
      return {
        incoming: {
          from: { opacity: 0, transform: IDENTITY },
          to: { opacity: 1, transform: IDENTITY },
        },
        outgoing: {
          from: { opacity: 1, transform: IDENTITY },
          to: { opacity: 0, transform: IDENTITY },
        },
      };
    case 'slide': {
      const enter = direction === 'forward' ? '100%' : '-100%';
      const leave = direction === 'forward' ? '-100%' : '100%';
      return {
        incoming: {
          from: { opacity: 1, transform: `translateX(${enter})` },
          to: { opacity: 1, transform: 'translateX(0%)' },
        },
        outgoing: {
          from: { opacity: 1, transform: 'translateX(0%)' },
          to: { opacity: 1, transform: `translateX(${leave})` },
        },
      };
    }
    case 'zoom':
      return {
        incoming: {
          from: { opacity: 0, transform: 'scale(1.08)' },
          to: { opacity: 1, transform: 'scale(1)' },
        },
        outgoing: {
          from: { opacity: 1, transform: 'scale(1)' },
          to: { opacity: 0, transform: 'scale(0.96)' },
        },
      };
  }
}

/** Las 8 direcciones del desplazamiento de Ken Burns (N, NE, E, SE, S, SO, O, NO). */
export const KEN_BURNS_DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function pct(n: number): string {
  // Evita «-0%» y colas de coma flotante en el CSS.
  return `${Math.round(n * 1000) / 1000 + 0}%`;
}

function kbTransform(scale: number, x: number, y: number): string {
  return `translate(${pct(x)}, ${pct(y)}) scale(${scale})`;
}

/**
 * Ken Burns de una foto: zoom-in 1 → 1,12 o zoom-out 1,12 → 1 (el llamador alterna) con un
 * desplazamiento del 3–5 % en una de 8 direcciones. Consume 2 llamadas al RNG: dirección y módulo.
 */
export function kenBurnsPlan(
  rng: Rng,
  zoomIn: boolean,
  transitionMs: number,
  slideMs: number,
): KenBurnsPlan {
  const [dx, dy] = KEN_BURNS_DIRECTIONS[randomIndex(rng, KEN_BURNS_DIRECTIONS.length)];
  const r = rng();
  const magnitude = 3 + 2 * (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0);
  const x = dx * magnitude;
  const y = dy * magnitude;
  const small = 1;
  const big = KEN_BURNS_MAX_SCALE;
  const scaleFrom = zoomIn ? small : big;
  const scaleTo = zoomIn ? big : small;
  // Zoom-in: del centro hacia el desplazamiento; zoom-out: del desplazamiento al centro.
  const fromX = zoomIn ? 0 : x;
  const fromY = zoomIn ? 0 : y;
  const toX = zoomIn ? x : 0;
  const toY = zoomIn ? y : 0;
  return {
    zoomIn,
    scaleFrom,
    scaleTo,
    fromX,
    fromY,
    toX,
    toY,
    fromTransform: kbTransform(scaleFrom, fromX, fromY),
    toTransform: kbTransform(scaleTo, toX, toY),
    durationMs: transitionMs + Math.max(0, slideMs) + transitionMs,
  };
}

export interface PickRequest {
  setting: TransitionSetting;
  randomPool: readonly TransitionKind[];
  transitionMs: number;
  /** Cuánto se muestra la diapositiva entrante (solo cuenta para Ken Burns). */
  slideMs: number;
  slideKind: MediaKind;
  direction: Direction;
  /** «Animaciones»: Ken Burns en las fotos, con cualquier transición. */
  kenBurns: boolean;
}

/** Elige y describe la transición de cada diapositiva. Guarda la anterior y alterna Ken Burns. */
export class TransitionPicker {
  private previous: ConcreteTransition | null = null;
  private kenBurnsCount = 0;

  constructor(private readonly rng: Rng) {}

  next(req: PickRequest): TransitionPlan {
    const picked: ConcreteTransition =
      req.setting === 'random'
        ? pickFromPool(req.randomPool, this.previous, this.rng)
        : req.setting;
    const eff = effectiveTransition(picked, req);
    const layers = describeLayers(eff.type, req.direction);
    let kenBurns: KenBurnsPlan | null = null;
    if (req.kenBurns && req.slideKind === 'photo') {
      kenBurns = kenBurnsPlan(this.rng, this.kenBurnsCount % 2 === 0, eff.durationMs, req.slideMs);
      this.kenBurnsCount += 1;
    }
    this.previous = picked;
    return {
      requested: req.setting,
      picked,
      type: eff.type,
      durationMs: eff.durationMs,
      easing: eff.type === 'none' ? null : EASINGS[eff.type],
      incoming: layers.incoming,
      outgoing: layers.outgoing,
      kenBurns,
    };
  }
}
