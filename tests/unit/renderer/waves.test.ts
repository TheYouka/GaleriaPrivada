// Ondas ligeras (§15.7): como mucho 30 fps, sin fotogramas programados en pausa, media resolución y
// pausa con la ventana oculta o minimizada.
import { describe, expect, it } from 'vitest';
import { isBackgroundPaused } from '@renderer/themes/background-paused';
import { AA_TEXT, contrastRatio, parseColor, luminance } from '@renderer/themes/contrast';
import {
  backingSize,
  drawWaves,
  FrameBudget,
  FrameLoop,
  hourBrightness,
  WAVES_FRAME_BUDGET_MS,
  WAVES_MAX_FPS,
  WAVES_MIN_BRIGHTNESS,
  WAVES_MONTH_COLORS,
  wavesColorsAt,
  wavesExtremes,
  type FrameScheduler,
  type WavesContext,
} from '@renderer/themes/backgrounds/waves';
import { PS3_TOKENS } from '@renderer/themes/tokens/ps3';

/** rAF falso: guarda el callback pendiente; `advance` lo ejecuta con el reloj indicado. */
class FakeScheduler implements FrameScheduler {
  pending = new Map<number, (t: number) => void>();
  requests = 0;
  cancels = 0;
  private next = 1;

  request(cb: (t: number) => void): number {
    this.requests += 1;
    const id = this.next++;
    this.pending.set(id, cb);
    return id;
  }

  cancel(handle: number): void {
    this.cancels += 1;
    this.pending.delete(handle);
  }

  /** Un "vsync" en el instante t: ejecuta los callbacks pendientes. */
  frame(t: number): void {
    const cbs = [...this.pending.values()];
    this.pending.clear();
    for (const cb of cbs) cb(t);
  }
}

function runFor(hz: number, ms: number, jitter = 0): { draws: number[]; scheduler: FakeScheduler } {
  const scheduler = new FakeScheduler();
  const draws: number[] = [];
  const loop = new FrameLoop(scheduler, (t) => draws.push(t));
  loop.start();
  const period = 1000 / hz;
  for (let i = 0, t = 0; t <= ms; i += 1, t = i * period + (i % 2 ? jitter : -jitter)) {
    scheduler.frame(t);
  }
  return { draws, scheduler };
}

describe('FrameLoop', () => {
  it.each([60, 120, 144, 240])('a %i Hz no pasa de 30 fps de media', (hz) => {
    const { draws } = runFor(hz, 10_000);
    expect(draws.length).toBeLessThanOrEqual(WAVES_MAX_FPS * 10 + 1);
    expect(draws.length).toBeGreaterThanOrEqual(hz >= 60 ? 280 : 0);
  });

  it('a 60 Hz con fluctuación del rAF sigue dibujando a ~30 fps (no cae a 20)', () => {
    const { draws } = runFor(60, 10_000, 0.3);
    expect(draws.length).toBeGreaterThanOrEqual(295);
    expect(draws.length).toBeLessThanOrEqual(301);
  });

  it('a 30 Hz o menos dibuja en cada fotograma', () => {
    // 0 ms … 1000 ms inclusive (el margen evita el redondeo de i × 1000 / 30).
    expect(runFor(30, 1001).draws.length).toBe(31);
    expect(runFor(20, 1001).draws.length).toBe(21);
  });

  it('sin start() no programa ningún fotograma', () => {
    const scheduler = new FakeScheduler();
    const loop = new FrameLoop(scheduler, () => undefined);
    expect(loop.running).toBe(false);
    expect(scheduler.requests).toBe(0);
  });

  it('stop() cancela el rAF pendiente y no vuelve a dibujar', () => {
    const scheduler = new FakeScheduler();
    let draws = 0;
    const loop = new FrameLoop(scheduler, () => (draws += 1));
    loop.start();
    scheduler.frame(0);
    scheduler.frame(34);
    expect(draws).toBe(2);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(scheduler.cancels).toBe(1);
    expect(scheduler.pending.size).toBe(0);
    const requests = scheduler.requests;
    scheduler.frame(100);
    scheduler.frame(200);
    expect(draws).toBe(2);
    expect(scheduler.requests).toBe(requests);
    // start() dos veces no duplica el bucle.
    loop.start();
    loop.start();
    expect(scheduler.pending.size).toBe(1);
  });

  it('tras una pausa larga no dibuja fotogramas atrasados en ráfaga', () => {
    const scheduler = new FakeScheduler();
    const draws: number[] = [];
    const loop = new FrameLoop(scheduler, (t) => draws.push(t));
    loop.start();
    scheduler.frame(0);
    scheduler.frame(5000);
    scheduler.frame(5016);
    scheduler.frame(5033);
    expect(draws).toEqual([0, 5000, 5033]);
  });
});

describe('fondo de ondas', () => {
  it('backing store a la mitad de resolución', () => {
    expect(backingSize(1280, 768)).toEqual({ width: 640, height: 384 });
    expect(backingSize(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it('el dibujo es determinista para un mismo instante (fotograma estático)', () => {
    const calls: string[] = [];
    const ctx = {
      globalAlpha: 1,
      fillStyle: '' as unknown,
      createLinearGradient: () => ({
        addColorStop: (o: number, c: string) => calls.push(`stop ${o} ${c}`),
      }),
      fillRect: (...a: number[]) => calls.push(`rect ${a.join(',')}`),
      beginPath: () => calls.push('begin'),
      moveTo: (x: number, y: number) => calls.push(`m ${x} ${y.toFixed(3)}`),
      lineTo: (x: number, y: number) => calls.push(`l ${x} ${y.toFixed(3)}`),
      closePath: () => calls.push('close'),
      fill: () => calls.push('fill'),
    } as unknown as WavesContext;
    drawWaves(ctx, 640, 384, 0);
    const first = [...calls];
    calls.length = 0;
    drawWaves(ctx, 640, 384, 0);
    expect(calls).toEqual(first);
    expect(first.filter((c) => c === 'fill')).toHaveLength(3);
    calls.length = 0;
    drawWaves(ctx, 640, 384, 1000);
    expect(calls).not.toEqual(first);
  });
});

describe('color por mes y brillo por hora (§15.7)', () => {
  it('hay 12 colores propios, todos distintos', () => {
    expect(WAVES_MONTH_COLORS).toHaveLength(12);
    expect(new Set(WAVES_MONTH_COLORS.map((m) => m.bottom)).size).toBe(12);
  });

  it('el brillo va de 0,75 (madrugada) a 1,0 (hacia las 13:00)', () => {
    expect(hourBrightness(13)).toBeCloseTo(1, 6);
    expect(hourBrightness(1)).toBeCloseTo(WAVES_MIN_BRIGHTNESS, 6);
    for (let h = 0; h < 24; h += 0.25) {
      expect(hourBrightness(h)).toBeGreaterThanOrEqual(WAVES_MIN_BRIGHTNESS - 1e-9);
      expect(hourBrightness(h)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('wavesColorsAt toma el color del mes local y lo oscurece según la hora', () => {
    const noon = wavesColorsAt(new Date(2026, 0, 15, 13, 0));
    expect(noon).toEqual(WAVES_MONTH_COLORS[0]);
    const night = wavesColorsAt(new Date(2026, 0, 15, 1, 0));
    expect(luminance(parseColor(night.bottom))).toBeLessThan(luminance(parseColor(noon.bottom)));
    // Otro mes, otro color.
    expect(wavesColorsAt(new Date(2026, 8, 15, 13, 0))).toEqual(WAVES_MONTH_COLORS[8]);
    for (let month = 0; month < 12; month += 1) {
      expect(wavesColorsAt(new Date(2026, month, 15, 13, 0))).toEqual(WAVES_MONTH_COLORS[month]);
    }
  });

  it('en cualquier mes y hora el texto atenuado cumple AA sobre el color más claro posible', () => {
    const [darkest, brightest] = wavesExtremes();
    const muted = PS3_TOKENS.dark['text-muted'];
    expect(contrastRatio(muted, brightest)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(luminance(parseColor(darkest))).toBeLessThanOrEqual(
      Math.min(...WAVES_MONTH_COLORS.map((m) => luminance(parseColor(m.top)))),
    );
    for (const m of WAVES_MONTH_COLORS) {
      expect(contrastRatio(muted, m.bottom)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('FrameBudget (≤ 3 ms por fotograma)', () => {
  it('si el dibujo se pasa del presupuesto, reduce el detalle (hasta ×8) y lo recupera', () => {
    const budget = new FrameBudget(WAVES_FRAME_BUDGET_MS, 10);
    expect(budget.stepScale).toBe(1);
    for (let i = 0; i < 10; i += 1) budget.record(WAVES_FRAME_BUDGET_MS + 1);
    expect(budget.stepScale).toBe(2);
    for (let i = 0; i < 100; i += 1) budget.record(10);
    expect(budget.stepScale).toBe(8);
    for (let i = 0; i < 100; i += 1) budget.record(0.2);
    expect(budget.stepScale).toBe(1);
  });

  it('dentro del presupuesto no cambia nada', () => {
    const budget = new FrameBudget(WAVES_FRAME_BUDGET_MS, 10);
    for (let i = 0; i < 100; i += 1) budget.record(WAVES_FRAME_BUDGET_MS * 0.8);
    expect(budget.stepScale).toBe(1);
  });
});

describe('isBackgroundPaused (§15.7)', () => {
  const visible = {
    documentHidden: false,
    minimized: false,
    visible: true,
    presentationActive: false,
    videoPlaying: false,
  };

  it('solo anima con la ventana visible y sin presentación ni vídeo', () => {
    expect(isBackgroundPaused(visible)).toBe(false);
    expect(isBackgroundPaused({ ...visible, documentHidden: true })).toBe(true);
    expect(isBackgroundPaused({ ...visible, minimized: true })).toBe(true);
    expect(isBackgroundPaused({ ...visible, visible: false })).toBe(true);
    expect(isBackgroundPaused({ ...visible, presentationActive: true })).toBe(true);
    expect(isBackgroundPaused({ ...visible, videoPlaying: true })).toBe(true);
  });
});
