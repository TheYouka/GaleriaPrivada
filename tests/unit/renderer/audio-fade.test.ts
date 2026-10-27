// fadeTo (docs/DESIGN.md §17.8) con un AudioParam falso que aplica las reglas de la especificación:
// solo cancelAndHoldAtTime / setValueAtTime / linearRampToValueAtTime, nunca setValueCurveAtTime,
// y ningún valor o tiempo que la Web Audio real rechazaría.
import { describe, expect, it } from 'vitest';
import { FADE_STEPS, fadeTo } from '../../../src/renderer/src/screens/presentation/audio-graph';
import { FakeAudioContext, FakeAudioParam } from './helpers/fake-audio';

function setup(initial = 1) {
  const ctx = new FakeAudioContext();
  const param = new FakeAudioParam(ctx, initial);
  return { ctx, param };
}

function ramps(param: FakeAudioParam) {
  return param.calls.filter((c) => c.method === 'linearRampToValueAtTime');
}

describe('fadeTo', () => {
  it('empieza con cancelAndHoldAtTime y programa 32 rampas lineales', () => {
    const { ctx, param } = setup(0);
    fadeTo(ctx, param, 0.7, 1500);
    expect(param.calls[0]).toEqual({ method: 'cancelAndHoldAtTime', args: [ctx.currentTime] });
    expect(ramps(param)).toHaveLength(FADE_STEPS);
    expect(FADE_STEPS).toBe(32);
  });

  it('solo usa los tres métodos permitidos y nunca setValueCurveAtTime', () => {
    const { ctx, param } = setup(1);
    for (const [target, ms] of [
      [0, 1500],
      [0.7, 300],
      [0.7, 0],
      [0.3, 100],
    ] as const) {
      fadeTo(ctx, param, target, ms);
      ctx.advance(0.05);
    }
    const used = param.methodsCalled();
    expect(used.has('setValueCurveAtTime')).toBe(false);
    for (const m of used) {
      expect(['cancelAndHoldAtTime', 'setValueAtTime', 'linearRampToValueAtTime']).toContain(m);
    }
    expect(param.errors).toEqual([]);
  });

  it('los tiempos de las rampas son estrictamente crecientes y acaban en t0 + ms', () => {
    const { ctx, param } = setup(0);
    fadeTo(ctx, param, 1, 1500);
    const times = ramps(param).map((c) => c.args[1]);
    for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1]);
    expect(times[0]).toBeGreaterThan(ctx.currentTime);
    expect(times.at(-1)).toBeCloseTo(ctx.currentTime + 1.5, 9);
  });

  it('subida: valores monótonos crecientes que terminan exactamente en target', () => {
    const { ctx, param } = setup(0.1);
    fadeTo(ctx, param, 0.7, 1000);
    const values = ramps(param).map((c) => c.args[0]);
    for (let i = 1; i < values.length; i += 1)
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    expect(values.at(-1)).toBe(0.7);
    expect(values[0]).toBeGreaterThan(0.1);
  });

  it('bajada: valores monótonos decrecientes que terminan exactamente en target', () => {
    const { ctx, param } = setup(0.8);
    fadeTo(ctx, param, 0, 1500);
    const values = ramps(param).map((c) => c.args[0]);
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    expect(values.at(-1)).toBe(0);
    expect(values[0]).toBeLessThan(0.8);
  });

  it('el valor del parámetro sigue la curva y llega a target', () => {
    const { ctx, param } = setup(0);
    fadeTo(ctx, param, 1, 1000);
    ctx.advance(0.5);
    // Curva de potencia constante (seno): a mitad de camino ya pasó del 0,7.
    expect(param.value).toBeGreaterThan(0.65);
    expect(param.value).toBeLessThan(0.75);
    ctx.advance(0.6);
    expect(param.value).toBe(1);
  });

  it('ms = 0 (o menor de 1 ms) es un salto: sin rampas', () => {
    for (const ms of [0, -10, 0.5]) {
      const { ctx, param } = setup(1);
      fadeTo(ctx, param, 0.2, ms);
      expect(ramps(param)).toHaveLength(0);
      expect(param.value).toBe(0.2);
    }
  });

  it('si ya está en target no programa rampas', () => {
    const { ctx, param } = setup(0.5);
    fadeTo(ctx, param, 0.5, 1500);
    expect(ramps(param)).toHaveLength(0);
  });

  it('valores inválidos no llegan a la API: NaN/Infinity se ignoran o saltan, sin errores', () => {
    const { ctx, param } = setup(0.4);
    fadeTo(ctx, param, Number.NaN, 1000);
    fadeTo(ctx, param, Number.POSITIVE_INFINITY, 1000);
    expect(param.calls).toEqual([]);
    fadeTo(ctx, param, 1, Number.NaN);
    fadeTo(ctx, param, 0.2, Number.POSITIVE_INFINITY);
    expect(ramps(param)).toHaveLength(0);
    expect(param.errors).toEqual([]);
    expect(param.value).toBe(0.2);
  });

  it('un target fuera de [0, 1] se limita (una ganancia negativa o enorme no se programa)', () => {
    const { ctx, param } = setup(0.5);
    fadeTo(ctx, param, -3, 1000);
    expect(Math.min(...ramps(param).map((c) => c.args[0]))).toBeGreaterThanOrEqual(0);
    ctx.advance(2);
    expect(param.value).toBe(0);
    fadeTo(ctx, param, 9, 1000);
    expect(Math.max(...ramps(param).map((c) => c.args[0]))).toBeLessThanOrEqual(1);
  });

  it('un reloj no válido no programa nada', () => {
    const { ctx, param } = setup(1);
    ctx.currentTime = Number.NaN;
    fadeTo(ctx, param, 0, 1000);
    expect(param.calls).toEqual([]);
  });

  it('un segundo fadeTo a mitad de otro empieza con cancelAndHoldAtTime y parte del valor actual', () => {
    const { ctx, param } = setup(0);
    fadeTo(ctx, param, 1, 1000);
    ctx.advance(0.4);
    const heldValue = param.value;
    expect(heldValue).toBeGreaterThan(0);
    expect(heldValue).toBeLessThan(1);
    const before = param.calls.length;
    fadeTo(ctx, param, 0, 500);
    expect(param.calls[before].method).toBe('cancelAndHoldAtTime');
    expect(param.calls[before].args).toEqual([ctx.currentTime]);
    // Continuidad: sin saltos, sale del valor que tenía.
    expect(param.value).toBeCloseTo(heldValue, 9);
    const first = ramps(param).slice(FADE_STEPS)[0].args[0];
    expect(first).toBeLessThan(heldValue);
    // Las rampas del primer fundido que quedaban por delante ya no cuentan.
    ctx.advance(0.6);
    expect(param.value).toBe(0);
    expect(param.errors).toEqual([]);
  });

  it('muchos cambios de volumen seguidos en mitad de un fundido no lanzan nada', () => {
    const { ctx, param } = setup(0);
    fadeTo(ctx, param, 0.7, 1500);
    for (let i = 0; i < 50; i += 1) {
      ctx.advance(0.013);
      fadeTo(ctx, param, (i % 10) / 10, 100);
    }
    expect(param.errors).toEqual([]);
    expect(param.methodsCalled().has('setValueCurveAtTime')).toBe(false);
  });

  it('el fake rechaza como la especificación (comprobación del propio fake)', () => {
    const { ctx, param } = setup(1);
    expect(() => param.linearRampToValueAtTime(Number.NaN, 2)).toThrow(TypeError);
    expect(() => param.setValueAtTime(0, -1)).toThrow(RangeError);
    expect(() => param.setValueCurveAtTime()).toThrow(/NotSupportedError/);
    expect(param.errors).toHaveLength(3);
    expect(ctx.currentTime).toBe(1);
  });
});
