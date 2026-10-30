// Motor de las ondas del tema "Ondas" (docs/DESIGN.md §15.7), sin React ni DOM para poder probarlo:
//   - canvas 2D (no WebGL), como mucho 30 fps con un acumulador de tiempo en rAF;
//   - backing store a la mitad de resolución y DPR 1, escalado por CSS;
//   - 3 cintas, cada una suma de 2 senos;
//   - con `paused` se cancela el rAF (FrameLoop.stop) y no se programa ningún fotograma;
//   - con movimiento reducido se dibuja un único fotograma estático (t = 0);
//   - el color sigue al mes (tabla propia de 12 colores) y el brillo a la hora (0,75–1,0);
//   - presupuesto de ≤ 3 ms por fotograma: si el dibujo se pasa, se reduce el detalle de las cintas.
import { composite, luminance, parseColor, toHex } from '../contrast';

export const WAVES_MAX_FPS = 30;
/** Backing store = tamaño CSS × este factor (DPR 1). */
export const WAVES_RESOLUTION_SCALE = 0.5;
/** Presupuesto de dibujo por fotograma (ms, §15.7). */
export const WAVES_FRAME_BUDGET_MS = 3;
/** Brillo mínimo (de madrugada) y máximo (hacia las 13:00) del color de fondo. */
export const WAVES_MIN_BRIGHTNESS = 0.75;
export const WAVES_MAX_BRIGHTNESS = 1;

export interface WavesColors {
  top: string;
  bottom: string;
}

/**
 * Color de las ondas por mes (enero = 0), propio del proyecto. Todos son oscuros y de luminancia
 * parecida: con las tres cintas solapadas, el más claro sigue dando ≥ 4,5:1 con el texto atenuado
 * (lo mide `theme-contrast.test.ts` con los extremos de `wavesExtremes()`).
 */
export const WAVES_MONTH_COLORS: readonly Readonly<WavesColors>[] = Object.freeze([
  { top: '#0A1A33', bottom: '#163460' }, // enero: azul medianoche
  { top: '#17133A', bottom: '#34286E' }, // febrero: índigo
  { top: '#0A2630', bottom: '#0E3846' }, // marzo: turquesa
  { top: '#0C2616', bottom: '#153A22' }, // abril: verde
  { top: '#14260C', bottom: '#263816' }, // mayo: verde oliva
  { top: '#0A2A22', bottom: '#0C4034' }, // junio: verde azulado
  { top: '#2A1408', bottom: '#522C12' }, // julio: ámbar oscuro
  { top: '#2E1608', bottom: '#4F2A0E' }, // agosto: cobre
  { top: '#2E0F1C', bottom: '#5A1F36' }, // septiembre: granate
  { top: '#2A0E14', bottom: '#58202A' }, // octubre: vino
  { top: '#240F33', bottom: '#4A2268' }, // noviembre: violeta
  { top: '#0B1B38', bottom: '#20316A' }, // diciembre: azul real
]);

/** Paleta base (enero): la de los tokens del tema (`bg`) y la de los tests sin fecha. */
export const WAVES_PALETTE = Object.freeze({
  top: '#0A1A33',
  bottom: '#163460',
  ribbon: '#FFFFFF',
  /** Opacidad de cada cinta; como mucho se solapan las tres. */
  ribbonAlpha: 0.07,
  ribbons: 3,
});

/** Brillo (0,75–1,0) a una hora (0–24, con decimales): máximo hacia las 13:00, mínimo a la 01:00. */
export function hourBrightness(hour: number): number {
  const day = 0.5 + 0.5 * Math.cos(((hour - 13) / 24) * Math.PI * 2);
  return WAVES_MIN_BRIGHTNESS + (WAVES_MAX_BRIGHTNESS - WAVES_MIN_BRIGHTNESS) * day;
}

function scaleColor(color: string, factor: number): string {
  const c = parseColor(color);
  return toHex({ r: c.r * factor, g: c.g * factor, b: c.b * factor, a: 1 });
}

/** Colores de las ondas para una fecha (hora local): mes → color, hora → brillo. */
export function wavesColorsAt(date: Date): WavesColors {
  const month = WAVES_MONTH_COLORS[date.getMonth()] ?? WAVES_MONTH_COLORS[0];
  const factor = hourBrightness(date.getHours() + date.getMinutes() / 60);
  return {
    top: scaleColor((month as WavesColors).top, factor),
    bottom: scaleColor((month as WavesColors).bottom, factor),
  };
}

function withRibbons(color: string): string {
  let c = parseColor(color);
  const ribbon = { ...parseColor(WAVES_PALETTE.ribbon), a: WAVES_PALETTE.ribbonAlpha };
  for (let i = 0; i < WAVES_PALETTE.ribbons; i += 1) c = composite(ribbon, c);
  return toHex(c);
}

/**
 * Colores extremos que pueden pintar las ondas en cualquier mes y a cualquier hora: el más oscuro
 * (arriba, sin cintas, con el brillo mínimo) y el más claro (abajo, con las tres cintas solapadas y
 * el brillo máximo). El test de contraste los usa como `bgExtremes`.
 */
export function wavesExtremes(): readonly [string, string] {
  const darkest = WAVES_MONTH_COLORS.map((m) => scaleColor(m.top, WAVES_MIN_BRIGHTNESS)).reduce(
    (a, b) => (luminance(parseColor(b)) < luminance(parseColor(a)) ? b : a),
  );
  const brightest = WAVES_MONTH_COLORS.map((m) => withRibbons(m.bottom)).reduce((a, b) =>
    luminance(parseColor(b)) > luminance(parseColor(a)) ? b : a,
  );
  return [darkest, brightest];
}

/**
 * Presupuesto de dibujo: promedia el coste de los últimos fotogramas y, si pasa de
 * `WAVES_FRAME_BUDGET_MS`, duplica el paso del polígono de las cintas (menos vértices; hasta ×8);
 * si baja a menos de la mitad, lo recupera. Un nivel por ventana de `window` fotogramas.
 */
export class FrameBudget {
  private samples = 0;
  private total = 0;
  private level = 0;

  constructor(
    private readonly budgetMs: number = WAVES_FRAME_BUDGET_MS,
    private readonly window: number = 30,
  ) {}

  /** Multiplicador del paso de las cintas (1, 2, 4 u 8). */
  get stepScale(): number {
    return 2 ** this.level;
  }

  record(ms: number): void {
    this.samples += 1;
    this.total += ms;
    if (this.samples < this.window) return;
    const mean = this.total / this.samples;
    if (mean > this.budgetMs && this.level < 3) this.level += 1;
    else if (mean < this.budgetMs / 2 && this.level > 0) this.level -= 1;
    this.samples = 0;
    this.total = 0;
  }
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

/** Un fotograma completo en el instante `t` (ms), con los colores y el detalle dados. */
export function drawWaves(
  ctx: WavesContext,
  width: number,
  height: number,
  t: number,
  colors: WavesColors = WAVES_PALETTE,
  stepScale = 1,
): void {
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, colors.top);
  bg.addColorStop(1, colors.bottom);
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const step = Math.max(2, Math.round(width / 160)) * stepScale;
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
