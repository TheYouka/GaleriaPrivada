// Animador del escenario de la presentación (docs/DESIGN.md §17.3; PLAN.md nota 191): cada
// `animate()` de Motion lleva `reduceMotion: false` (ni <MotionConfig> ni el sistema deciden por el
// usuario), un corte no anima las capas pero Ken Burns sí, y la pausa congela todo. `motion` se
// sustituye por un doble que anota las llamadas.
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  el: unknown;
  keyframes: Record<string, unknown>;
  options: Record<string, unknown>;
  controls: { stop: () => void; pause: () => void; play: () => void; then: unknown };
}

const calls: Call[] = [];

vi.mock('motion', () => ({
  animate: (el: unknown, keyframes: Record<string, unknown>, options: Record<string, unknown>) => {
    const controls = {
      stop: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      then: (ok: () => void) => {
        void ok;
      },
    };
    calls.push({ el, keyframes, options, controls });
    return controls;
  },
}));

const { StageAnimator } =
  await import('../../../src/renderer/src/screens/presentation/stage-animator');
const { TransitionPicker } =
  await import('../../../src/renderer/src/screens/presentation/transitions');

type El = { style: Record<string, string> };
const el = (): El => ({ style: {} });

function layers() {
  return {
    a: { layer: el(), content: el() },
    b: { layer: el(), content: el() },
  };
}

function plan(setting: 'fade' | 'slide' | 'none', kenBurns: boolean, slideKind = 'photo') {
  return new TransitionPicker(() => 0.2).next({
    setting,
    randomPool: ['fade'],
    transitionMs: 800,
    slideMs: 3000,
    slideKind: slideKind as 'photo' | 'video',
    direction: 'forward',
    kenBurns,
  });
}

function register(animator: InstanceType<typeof StageAnimator>) {
  const l = layers();
  animator.register(0, l.a as never);
  animator.register(1, l.b as never);
  return l;
}

beforeEach(() => {
  calls.length = 0;
});

describe('StageAnimator', () => {
  it('fundido con Ken Burns: tres animaciones y todas con reduceMotion: false', () => {
    const animator = new StageAnimator();
    const l = register(animator);
    animator.transition({ from: 0, to: 1, plan: plan('fade', true) });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.options.reduceMotion, JSON.stringify(c.keyframes)).toBe(false);
    // La entrante y la saliente animan la capa; Ken Burns anima el contenido.
    expect(calls.map((c) => c.el)).toEqual([l.b.layer, l.a.layer, l.b.content]);
    expect(calls[2].keyframes).toHaveProperty('transform');
    expect(calls[2].options.ease).toBe('linear');
    expect(animator.last).toEqual({ type: 'fade', durationMs: 800 });
  });

  it('deslizar: opacity y transform de las dos capas', () => {
    const animator = new StageAnimator();
    register(animator);
    animator.transition({ from: 0, to: 1, plan: plan('slide', false) });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(Object.keys(c.keyframes).sort()).toEqual(['opacity', 'transform']);
      expect(c.options.reduceMotion).toBe(false);
      expect(c.options.duration).toBeCloseTo(0.8);
    }
  });

  it('corte con Ken Burns: las capas cambian de golpe y solo el contenido se anima', () => {
    const animator = new StageAnimator();
    const l = register(animator);
    const p = plan('none', true);
    animator.transition({ from: 0, to: 1, plan: p });
    expect(l.b.layer.style.opacity).toBe('1');
    expect(l.a.layer.style.opacity).toBe('0');
    expect(calls).toHaveLength(1);
    expect(calls[0].el).toBe(l.b.content);
    expect(calls[0].options.reduceMotion).toBe(false);
    expect(l.b.content.style.transform).toBe(p.kenBurns?.fromTransform);
  });

  it('corte sin Ken Burns, o un vídeo: ninguna animación', () => {
    const animator = new StageAnimator();
    register(animator);
    animator.transition({ from: 0, to: 1, plan: plan('none', false) });
    animator.transition({ from: 1, to: 0, plan: plan('fade', true, 'video') });
    expect(calls).toHaveLength(2); // el fundido del vídeo (entrante y saliente), sin Ken Burns
    expect(calls.every((c) => 'opacity' in c.keyframes)).toBe(true);
  });

  it('setPaused pausa y reanuda todos los controles en curso', () => {
    const animator = new StageAnimator();
    register(animator);
    animator.transition({ from: 0, to: 1, plan: plan('fade', true) });
    animator.setPaused(true);
    for (const c of calls) expect(c.controls.pause).toHaveBeenCalledTimes(1);
    animator.setPaused(false);
    for (const c of calls) expect(c.controls.play).toHaveBeenCalledTimes(1);
  });

  it('stop detiene las animaciones de esa capa', () => {
    const animator = new StageAnimator();
    register(animator);
    animator.transition({ from: 0, to: 1, plan: plan('fade', true) });
    animator.stop(1);
    // La entrante (capa y contenido) se detienen; la saliente (capa 0) sigue.
    expect(calls[0].controls.stop).toHaveBeenCalled();
    expect(calls[2].controls.stop).toHaveBeenCalled();
    expect(calls[1].controls.stop).not.toHaveBeenCalled();
  });
});
