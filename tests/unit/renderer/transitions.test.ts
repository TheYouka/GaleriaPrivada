// Transiciones de la presentación (docs/DESIGN.md §17.3): descripción pura y elección con RNG
// inyectado.
import { describe, expect, it } from 'vitest';
import {
  KEN_BURNS_DIRECTIONS,
  REDUCED_MOTION_MS,
  TransitionPicker,
  describeLayers,
  effectiveTransition,
  kenBurnsPlan,
  pickFromPool,
  type PickRequest,
} from '../../../src/renderer/src/screens/presentation/transitions';

const base: PickRequest = {
  setting: 'fade',
  randomPool: ['fade', 'slide', 'zoom', 'kenburns'],
  transitionMs: 700,
  slideMs: 5000,
  slideKind: 'photo',
  direction: 'forward',
  reducedMotion: false,
  kenBurns: true,
};

/** RNG determinista (LCG) para barridos largos. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('describeLayers', () => {
  it('fade: opacidad 0→1 y 1→0', () => {
    const l = describeLayers('fade', 'forward');
    expect(l.incoming).toEqual({
      from: { opacity: 0, transform: 'none' },
      to: { opacity: 1, transform: 'none' },
    });
    expect(l.outgoing?.from.opacity).toBe(1);
    expect(l.outgoing?.to.opacity).toBe(0);
  });

  it('slide hacia delante entra desde la derecha y sale por la izquierda; hacia atrás, al revés', () => {
    const fwd = describeLayers('slide', 'forward');
    expect(fwd.incoming?.from.transform).toBe('translateX(100%)');
    expect(fwd.outgoing?.to.transform).toBe('translateX(-100%)');
    const back = describeLayers('slide', 'back');
    expect(back.incoming?.from.transform).toBe('translateX(-100%)');
    expect(back.outgoing?.to.transform).toBe('translateX(100%)');
  });

  it('zoom: entra a 1,08→1 con fundido y sale 1→0,96 con fundido', () => {
    const l = describeLayers('zoom', 'forward');
    expect(l.incoming).toEqual({
      from: { opacity: 0, transform: 'scale(1.08)' },
      to: { opacity: 1, transform: 'scale(1)' },
    });
    expect(l.outgoing).toEqual({
      from: { opacity: 1, transform: 'scale(1)' },
      to: { opacity: 0, transform: 'scale(0.96)' },
    });
  });

  it('kenburns se funde como fade; none es un corte', () => {
    expect(describeLayers('kenburns', 'forward')).toEqual(describeLayers('fade', 'forward'));
    expect(describeLayers('none', 'forward')).toEqual({ incoming: null, outgoing: null });
  });

  it('solo se animan opacity y transform', () => {
    for (const t of ['fade', 'slide', 'zoom', 'kenburns'] as const) {
      const l = describeLayers(t, 'forward');
      for (const layer of [l.incoming, l.outgoing]) {
        expect(Object.keys(layer?.from ?? {}).sort()).toEqual(['opacity', 'transform']);
        expect(Object.keys(layer?.to ?? {}).sort()).toEqual(['opacity', 'transform']);
      }
    }
  });
});

describe('effectiveTransition', () => {
  const o = {
    slideKind: 'photo' as const,
    transitionMs: 700,
    reducedMotion: false,
    kenBurns: true,
  };

  it('0 ms equivale a none', () => {
    expect(effectiveTransition('slide', { ...o, transitionMs: 0 })).toEqual({
      type: 'none',
      durationMs: 0,
    });
  });

  it('un valor no finito o negativo equivale a none; por encima de 3000 se limita', () => {
    expect(effectiveTransition('fade', { ...o, transitionMs: Number.NaN }).type).toBe('none');
    expect(effectiveTransition('fade', { ...o, transitionMs: -5 }).type).toBe('none');
    expect(effectiveTransition('fade', { ...o, transitionMs: 99_999 }).durationMs).toBe(3000);
  });

  it('los vídeos con kenburns usan fade, con la misma duración', () => {
    expect(effectiveTransition('kenburns', { ...o, slideKind: 'video' })).toEqual({
      type: 'fade',
      durationMs: 700,
    });
  });

  it('con las animaciones apagadas, kenburns se queda en el fundido pero slide y zoom siguen', () => {
    expect(effectiveTransition('kenburns', { ...o, kenBurns: false }).type).toBe('fade');
    expect(effectiveTransition('slide', { ...o, kenBurns: false }).type).toBe('slide');
  });

  it('con movimiento reducido todo es un fundido de 150 ms; none sigue siendo un corte', () => {
    for (const t of ['fade', 'slide', 'zoom', 'kenburns'] as const) {
      expect(effectiveTransition(t, { ...o, reducedMotion: true })).toEqual({
        type: 'fade',
        durationMs: REDUCED_MOTION_MS,
      });
    }
    expect(effectiveTransition('none', { ...o, reducedMotion: true }).type).toBe('none');
  });
});

describe('pickFromPool (RNG inyectado)', () => {
  const pool = ['fade', 'slide', 'zoom', 'kenburns'] as const;

  it('elige por el RNG, sin repetir la anterior', () => {
    expect(pickFromPool(pool, null, () => 0)).toBe('fade');
    expect(pickFromPool(pool, null, () => 0.99)).toBe('kenburns');
    // Excluida `fade`, el 0 es `slide`.
    expect(pickFromPool(pool, 'fade', () => 0)).toBe('slide');
    expect(pickFromPool(pool, 'kenburns', () => 0.99)).toBe('zoom');
  });

  it('un RNG que devuelve 1 (o algo raro) no se sale del grupo', () => {
    expect(pickFromPool(pool, null, () => 1)).toBe('kenburns');
    expect(pickFromPool(pool, null, () => Number.NaN)).toBe('fade');
    expect(pickFromPool(pool, null, () => -1)).toBe('fade');
  });

  it('con un solo tipo lo devuelve aunque sea el anterior', () => {
    expect(pickFromPool(['zoom'], 'zoom', () => 0.5)).toBe('zoom');
  });

  it('la anterior que no está en el grupo no excluye nada', () => {
    expect(pickFromPool(['slide', 'zoom'], 'fade', () => 0)).toBe('slide');
    expect(pickFromPool(['slide', 'zoom'], 'none', () => 0.6)).toBe('zoom');
  });

  it('los duplicados del grupo no sesgan ni rompen la regla', () => {
    expect(pickFromPool(['fade', 'fade', 'slide'], 'fade', () => 0)).toBe('slide');
  });

  it('un grupo vacío cae en fade', () => {
    expect(pickFromPool([], null, () => 0.3)).toBe('fade');
  });

  it('barrido largo: nunca dos iguales seguidas y salen todos los tipos', () => {
    const rng = lcg(1234);
    let previous: ReturnType<typeof pickFromPool> | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const next = pickFromPool(pool, previous, rng);
      expect(next).not.toBe(previous);
      seen.add(next);
      previous = next;
    }
    expect([...seen].sort()).toEqual([...pool].sort());
  });
});

describe('kenBurnsPlan', () => {
  it('zoom-in 1 → 1,12 o zoom-out 1,12 → 1, durante D + slideMs + D', () => {
    const zin = kenBurnsPlan(() => 0.5, true, 700, 5000);
    expect([zin.scaleFrom, zin.scaleTo]).toEqual([1, 1.12]);
    expect(zin.durationMs).toBe(700 + 5000 + 700);
    const zout = kenBurnsPlan(() => 0.5, false, 700, 5000);
    expect([zout.scaleFrom, zout.scaleTo]).toEqual([1.12, 1]);
  });

  it('el desplazamiento mide 3–5 % en una de 8 direcciones', () => {
    const dirs = new Set<string>();
    const rng = lcg(7);
    for (let i = 0; i < 400; i += 1) {
      const p = kenBurnsPlan(rng, true, 700, 5000);
      const dx = Math.sign(p.toX);
      const dy = Math.sign(p.toY);
      dirs.add(`${dx},${dy}`);
      for (const axis of [p.toX, p.toY]) {
        if (axis !== 0) {
          expect(Math.abs(axis)).toBeGreaterThanOrEqual(3);
          expect(Math.abs(axis)).toBeLessThanOrEqual(5);
        }
      }
    }
    expect(dirs.size).toBe(8);
    expect(KEN_BURNS_DIRECTIONS).toHaveLength(8);
  });

  it('consume exactamente dos llamadas al RNG', () => {
    let calls = 0;
    kenBurnsPlan(() => (calls += 1) / 10, true, 700, 5000);
    expect(calls).toBe(2);
  });

  it('el CSS no lleva «-0%»', () => {
    const p = kenBurnsPlan(() => 0, true, 700, 5000); // dirección N, módulo 3
    expect(p.fromTransform).not.toContain('-0%');
    expect(p.fromTransform).toBe('translate(0%, 0%) scale(1)');
  });
});

describe('TransitionPicker', () => {
  it('fade fijo no gasta el RNG', () => {
    let calls = 0;
    const picker = new TransitionPicker(() => (calls += 1));
    const plan = picker.next(base);
    expect(calls).toBe(0);
    expect(plan).toMatchObject({
      requested: 'fade',
      type: 'fade',
      durationMs: 700,
      kenBurns: null,
    });
    expect(plan.easing).toEqual([0.4, 0, 0.2, 1]);
  });

  it('none: corte instantáneo, sin capas', () => {
    const plan = new TransitionPicker(() => 0).next({ ...base, setting: 'none' });
    expect(plan).toMatchObject({ type: 'none', durationMs: 0, incoming: null, outgoing: null });
    expect(plan.easing).toBeNull();
  });

  it('random: un sorteo por plan, y el plan dice qué salió y qué se anima', () => {
    let calls = 0;
    const picker = new TransitionPicker(() => {
      calls += 1;
      return 0;
    });
    const plan = picker.next({ ...base, setting: 'random' });
    expect(calls).toBe(1);
    expect(plan).toMatchObject({ requested: 'random', picked: 'fade', type: 'fade' });
  });

  it('random con kenburns en un vídeo: el sorteo cuenta, pero se anima un fundido', () => {
    const picker = new TransitionPicker(() => 0.99);
    const plan = picker.next({
      ...base,
      setting: 'random',
      slideKind: 'video',
    });
    expect(plan.picked).toBe('kenburns');
    expect(plan.type).toBe('fade');
    expect(plan.kenBurns).toBeNull();
  });

  it('random nunca repite el sorteo anterior, también tras una transición fija', () => {
    const picker = new TransitionPicker(() => 0);
    picker.next({ ...base, setting: 'fade' });
    // La anterior fue `fade`: con el RNG a 0, el primer candidato restante es `slide`.
    expect(picker.next({ ...base, setting: 'random' }).picked).toBe('slide');
    expect(picker.next({ ...base, setting: 'random' }).picked).toBe('fade');
    expect(picker.next({ ...base, setting: 'random' }).picked).toBe('slide');
  });

  it('Ken Burns en fotos alterna zoom-in y zoom-out', () => {
    const picker = new TransitionPicker(() => 0.2);
    const kinds = [1, 2, 3, 4].map(
      () => picker.next({ ...base, setting: 'kenburns' }).kenBurns?.zoomIn,
    );
    expect(kinds).toEqual([true, false, true, false]);
  });

  it('un vídeo con kenburns no gasta el turno de alternancia ni el RNG', () => {
    let calls = 0;
    const picker = new TransitionPicker(() => {
      calls += 1;
      return 0.2;
    });
    picker.next({ ...base, setting: 'kenburns' });
    const callsAfterPhoto = calls;
    picker.next({ ...base, setting: 'kenburns', slideKind: 'video' });
    expect(calls).toBe(callsAfterPhoto);
    expect(picker.next({ ...base, setting: 'kenburns' }).kenBurns?.zoomIn).toBe(false);
  });

  it('Ken Burns dura D + slideMs + D con la duración efectiva', () => {
    const plan = new TransitionPicker(() => 0.2).next({
      ...base,
      setting: 'kenburns',
      transitionMs: 1000,
      slideMs: 3000,
    });
    expect(plan.kenBurns?.durationMs).toBe(5000);
  });

  it('movimiento reducido: fundido de 150 ms sin Ken Burns', () => {
    const plan = new TransitionPicker(() => 0).next({
      ...base,
      setting: 'kenburns',
      reducedMotion: true,
    });
    expect(plan).toMatchObject({ type: 'fade', durationMs: 150, kenBurns: null });
  });
});
