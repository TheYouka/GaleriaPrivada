// Motor de las ondas del tema "Ondas" (docs/DESIGN.md §15.7), sin React ni DOM para poder probarlo:
//   - canvas 2D (no WebGL), como mucho 30 fps con un acumulador de tiempo en rAF;
//   - backing store a la mitad de resolución y DPR 1, escalado por CSS;
//   - 3 cintas, cada una suma de 2 senos;
//   - con `paused` se cancela el rAF (FrameLoop.stop) y no se programa ningún fotograma;
//   - con movimiento reducido se dibuja un único fotograma estático (t = 0).
// Stub de F1: color fijo. F6 añade la tabla de 12 colores por mes y el brillo por hora.
import { composite, parseColor, toHex } from '../contrast';

export const WAVES_MAX_FPS = 30;
/** Backing store = tamaño CSS × este factor (DPR 1). */
export const WAVES_RESOLUTION_SCALE = 0.5;

export const WAVES_PALETTE = Object.freeze({
  top: '#0A1A33',
  bottom: '#163460',
  ribbon: '#FFFFFF',
  /** Opacidad de cada cinta; como mucho se solapan las tres. */
  ribbonAlpha: 0.07,
  ribbons: 3,
});

/**
 * Colores extremos que pueden pintar las ondas: el más oscuro (arriba, sin cintas) y el más claro
 * (abajo, con las tres cintas solapadas). El test de contraste los usa como `bgExtremes`.
 */
export function wavesExtremes(): readonly [string, string] {
  let brightest = parseColor(WAVES_PALETTE.bottom);
  const ribbon = { ...parseColor(WAVES_PALETTE.ribbon), a: WAVES_PALETTE.ribbonAlpha };
  for (let i = 0; i < WAVES_PALETTE.ribbons; i += 1) brightest = composite(ribbon, brightest);
  return [WAVES_PALETTE.top, toHex(brightest)];
}

/** Tamaño del backing store para un canvas de `cssWidth` × `cssHeight`. */
export function backingSize(
  cssWidth: number,
  cssHeight: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(cssWidth * WAVES_RESOLUTION_SCALE)),
    height: Math.max(1, Math.round(cssHeight * WAVES_RESOLUTION_SCALE)),
  };
}

interface Ribbon {
  base: number;
  thickness: number;
  a1: number;
  k1: number;
  w1: number;
  p1: number;
  a2: number;
  k2: number;
  w2: number;
  p2: number;
}

const RIBBONS: readonly Ribbon[] = [
  {
    base: 0.56,
    thickness: 0.09,
    a1: 0.07,
    k1: 1.1,
    w1: 0.00021,
    p1: 0,
    a2: 0.02,
    k2: 2.7,
    w2: 0.00043,
    p2: 1.3,
  },
  {
    base: 0.62,
    thickness: 0.06,
    a1: 0.05,
    k1: 1.6,
    w1: -0.00017,
    p1: 2.1,
    a2: 0.025,
    k2: 3.3,
    w2: 0.00031,
    p2: 0.4,
  },
  {
    base: 0.69,
    thickness: 0.11,
    a1: 0.06,
    k1: 0.8,
    w1: 0.00013,
    p1: 4.2,
    a2: 0.018,
    k2: 2.2,
    w2: -0.00027,
    p2: 2.6,
  },
];

/** Subconjunto de CanvasRenderingContext2D que usa el dibujo. */
export type WavesContext = Pick<
  CanvasRenderingContext2D,
  | 'createLinearGradient'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
  | 'fillStyle'
  | 'globalAlpha'
>;

/** Un fotograma completo en el instante `t` (ms). */
export function drawWaves(ctx: WavesContext, width: number, height: number, t: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, WAVES_PALETTE.top);
  bg.addColorStop(1, WAVES_PALETTE.bottom);
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const step = Math.max(2, Math.round(width / 160));
  const tau = Math.PI * 2;
  ctx.fillStyle = WAVES_PALETTE.ribbon;
  ctx.globalAlpha = WAVES_PALETTE.ribbonAlpha;
  for (const r of RIBBONS) {
    const top = (x: number): number => {
      const u = x / width;
      return (
        height *
        (r.base +
          r.a1 * Math.sin(r.k1 * tau * u + r.w1 * t + r.p1) +
          r.a2 * Math.sin(r.k2 * tau * u + r.w2 * t + r.p2))
      );
    };
    const thick = (x: number): number => {
      const u = x / width;
      return height * r.thickness * (0.6 + 0.4 * Math.sin(r.k2 * tau * u - r.w1 * t + r.p1));
    };
    ctx.beginPath();
    ctx.moveTo(0, top(0));
    for (let x = step; x <= width + step; x += step) ctx.lineTo(x, top(x));
    for (let x = width + step; x >= 0; x -= step) ctx.lineTo(x, top(x) + thick(x));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** requestAnimationFrame/cancelAnimationFrame (inyectables en los tests). */
export interface FrameScheduler {
  request(cb: (time: number) => void): number;
  cancel(handle: number): void;
}

/**
 * Bucle de fotogramas con tope de fps. `start()` programa un rAF; cada rAF programa el siguiente y
 * dibuja solo cuando el tiempo acumulado llega al intervalo (1000 / fps). `stop()` cancela el rAF
 * pendiente: sin bucle no hay ningún fotograma programado.
 */
export class FrameLoop {
  private handle: number | null = null;
  private prev: number | null = null;
  private acc = 0;
  private readonly interval: number;

  constructor(
    private readonly scheduler: FrameScheduler,
    private readonly draw: (time: number) => void,
    fps: number = WAVES_MAX_FPS,
  ) {
    this.interval = 1000 / fps;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.prev = null;
    this.acc = 0;
    this.handle = this.scheduler.request(this.tick);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.cancel(this.handle);
    this.handle = null;
  }

  private readonly tick = (time: number): void => {
    this.handle = this.scheduler.request(this.tick);
    if (this.prev === null) {
      this.prev = time;
      this.draw(time);
      return;
    }
    // Acumulador: tolera 0,5 ms de fluctuación del rAF; la deuda (acc negativo) se arrastra, así que
    // la media nunca pasa de `fps`. Tras una pausa larga no se dibujan fotogramas atrasados.
    this.acc = Math.min(this.acc + (time - this.prev), this.interval);
    this.prev = time;
    if (this.acc + 0.5 >= this.interval) {
      this.acc -= this.interval;
      this.draw(time);
    }
  };
}
