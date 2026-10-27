// Planificador de la presentación (docs/DESIGN.md §17.4–§17.6) con reloj, temporizadores y RNG
// falsos. El «anfitrión» de los tests responde a `prepare` con `loaded`, `failed` o nada.
import { describe, expect, it } from 'vitest';
import {
  PresentationScheduler,
  READY_TIMEOUT_MS,
  type SchedulerEvent,
  type SchedulerSettings,
  type SlideSpec,
} from '../../../src/renderer/src/screens/presentation/scheduler';
import { FakeClock } from './helpers/fake-clock';

type Reply = 'load' | 'fail' | 'never';

const photo: SlideSpec = { kind: 'photo' };
const video: SlideSpec = { kind: 'video' };

interface Options {
  settings?: Partial<SchedulerSettings>;
  reply?: (index: number) => Reply;
  rng?: () => number;
}

function setup(slides: SlideSpec[], opts: Options = {}) {
  const clock = new FakeClock();
  const events: SchedulerEvent[] = [];
  const scheduler = new PresentationScheduler(
    slides,
    { transition: 'fade', transitionMs: 500, slideMs: 2000, ...opts.settings },
    { timers: clock, rng: opts.rng ?? (() => 0) },
  );
  const reply = opts.reply ?? ((): Reply => 'load');
  scheduler.subscribe((e) => {
    events.push(e);
    if (e.type !== 'prepare') return;
    // Respuesta síncrona dentro del propio aviso: el planificador tiene que aguantar la reentrada.
    const r = reply(e.index);
    if (r === 'load') scheduler.loaded(e.index);
    else if (r === 'fail') scheduler.failed(e.index);
  });
  const ofType = <T extends SchedulerEvent['type']>(type: T) =>
    events.filter((e): e is Extract<SchedulerEvent, { type: T }> => e.type === type);
  return {
    clock,
    events,
    scheduler,
    transitions: () => ofType('transition').map((e) => e.to),
    showings: () => ofType('showing').map((e) => e.index),
    prepares: () => ofType('prepare').map((e) => e.index),
    ofType,
  };
}

describe('scheduler: foto, vídeo y temporización', () => {
  it('una foto se muestra slideMs desde que termina de entrar', () => {
    const t = setup([photo, photo]);
    t.scheduler.start();
    expect(t.scheduler.snapshot()).toMatchObject({ index: 0, phase: 'entering' });
    t.clock.advance(499);
    expect(t.showings()).toEqual([]);
    t.clock.advance(1);
    expect(t.showings()).toEqual([0]);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 0, phase: 'showing' });
    // slideMs - 1: sigue; slideMs: empieza la entrada de la siguiente.
    t.clock.advance(1999);
    expect(t.transitions()).toEqual([0]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1]);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 1, phase: 'entering', leavingIndex: 0 });
    t.clock.advance(500);
    expect(t.ofType('left').map((e) => e.index)).toEqual([0]);
    expect(t.scheduler.snapshot()).toMatchObject({
      index: 1,
      phase: 'showing',
      leavingIndex: null,
    });
  });

  it('una foto con duración propia usa la suya', () => {
    const t = setup([{ kind: 'photo', durationMs: 1000 }, photo]);
    t.scheduler.start();
    t.clock.advance(500 + 999);
    expect(t.transitions()).toEqual([0]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1]);
  });

  it('un vídeo se muestra hasta `ended`, sea cual sea el tiempo', () => {
    const t = setup([video, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    expect(t.showings()).toEqual([0]);
    t.clock.advance(10 * 60_000);
    expect(t.transitions()).toEqual([0]);
    t.scheduler.ended(0);
    expect(t.transitions()).toEqual([0, 1]);
  });

  it('ended de otra diapositiva, o de una foto, no avanza', () => {
    const t = setup([photo, video, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.ended(0);
    t.scheduler.ended(1);
    t.scheduler.ended(2);
    expect(t.transitions()).toEqual([0]);
  });

  it('fotos y vídeos alternan en la misma secuencia', () => {
    const t = setup([photo, video, photo, video], { settings: { loop: true } });
    t.scheduler.start();
    for (let step = 0; step < 6; step += 1) {
      t.clock.advance(500); // termina la entrada
      const index = t.scheduler.snapshot().index as number;
      if (index === 1 || index === 3) t.scheduler.ended(index);
      else t.clock.advance(2000);
    }
    expect(t.transitions().slice(0, 6)).toEqual([0, 1, 2, 3, 0, 1]);
    expect(
      t
        .ofType('transition')
        .map((e) => e.toKind)
        .slice(0, 4),
    ).toEqual(['photo', 'video', 'photo', 'video']);
  });

  it('la transición lleva el tipo de la saliente y de la entrante', () => {
    const t = setup([video, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.ended(0);
    const second = t.ofType('transition')[1];
    expect(second).toMatchObject({ from: 0, to: 1, fromKind: 'video', toKind: 'photo' });
    expect(t.ofType('transition')[0]).toMatchObject({ from: null, fromKind: null });
  });

  it('con `none` (o 0 ms) no hay entrada: showing llega en el mismo instante', () => {
    for (const settings of [{ transition: 'none' as const }, { transitionMs: 0 }]) {
      const t = setup([photo, photo], { settings });
      t.scheduler.start();
      expect(t.showings()).toEqual([0]);
      t.clock.advance(2000);
      expect(t.transitions()).toEqual([0, 1]);
      expect(t.showings()).toEqual([0, 1]);
    }
  });
});

describe('scheduler: precarga', () => {
  it('prepara la 0 al empezar y la i+1 en cuanto la i está en showing', () => {
    const t = setup([photo, photo, photo], { settings: { loop: false } });
    t.scheduler.start();
    // prepare(0) → transition → (entrada) → showing(0) → prepare(1)
    expect(t.events.map((e) => e.type)).toEqual(['prepare', 'transition']);
    t.clock.advance(500);
    expect(t.events.map((e) => e.type)).toEqual(['prepare', 'transition', 'showing', 'prepare']);
    expect(t.prepares()).toEqual([0, 1]);
  });

  it('con bucle, desde la última se prepara la 0; sin bucle, no se prepara nada', () => {
    const looped = setup([photo, photo], { settings: { loop: true } });
    looped.scheduler.start();
    looped.clock.advance(500 + 2000 + 500);
    expect(looped.prepares()).toEqual([0, 1, 0]);

    const once = setup([photo, photo], { settings: { loop: false } });
    once.scheduler.start();
    once.clock.advance(500 + 2000 + 500);
    expect(once.prepares()).toEqual([0, 1]);
  });

  it('activar el bucle sobre la última prepara la 0 al momento', () => {
    const t = setup([photo, photo], { settings: { loop: false } });
    t.scheduler.start();
    t.clock.advance(500 + 2000 + 500);
    expect(t.prepares()).toEqual([0, 1]);
    t.scheduler.updateSettings({ loop: true });
    expect(t.prepares()).toEqual([0, 1, 0]);
  });

  it('no repite `prepare` de una diapositiva ya pedida', () => {
    const t = setup([photo, photo, photo], { settings: { loop: true } });
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.next();
    const twice = t.prepares().filter((i) => i === 1);
    expect(twice).toHaveLength(1);
  });

  it('con la siguiente sin cargar, la actual se mantiene y al llegar `loaded` cambia al momento', () => {
    let answer: Reply = 'load';
    const t = setup([photo, photo], { reply: (i) => (i === 1 ? answer : 'load') });
    answer = 'never';
    t.scheduler.start();
    t.clock.advance(500 + 2000);
    // El tiempo de la foto se agotó pero la 1 no está lista: se espera, sin transición.
    expect(t.transitions()).toEqual([0]);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 0, phase: 'showing', pendingIndex: 1 });
    t.clock.advance(7000);
    expect(t.transitions()).toEqual([0]);
    t.scheduler.loaded(1);
    expect(t.transitions()).toEqual([0, 1]);
  });
});

describe('scheduler: bucle y final', () => {
  it('con bucle (por defecto) tras la última sigue la primera', () => {
    const t = setup([photo, photo, photo], { settings: {} });
    t.scheduler.start();
    t.clock.advance(500 + 3 * (2000 + 500) + 2 * (2000 + 500));
    expect(t.transitions()).toEqual([0, 1, 2, 0, 1, 2]);
    expect(t.ofType('finished')).toHaveLength(0);
  });

  it('el bucle está activo por defecto', () => {
    const clock = new FakeClock();
    const s = new PresentationScheduler([photo, photo], {}, { timers: clock, rng: () => 0 });
    expect(s.getSettings().loop).toBe(true);
  });

  it('sin bucle, al acabar la última aparece el final y nada más avanza', () => {
    const t = setup([photo, photo], { settings: { loop: false } });
    t.scheduler.start();
    t.clock.advance(500 + 2000 + 500 + 2000);
    expect(t.ofType('finished')).toHaveLength(1);
    expect(t.scheduler.snapshot().phase).toBe('finished');
    t.clock.advance(60_000);
    expect(t.transitions()).toEqual([0, 1]);
    expect(t.scheduler.next()).toBe(false);
    expect(t.scheduler.prev()).toBe(false);
  });

  it('sin bucle, una última diapositiva de vídeo acaba con su `ended`', () => {
    const t = setup([photo, video], { settings: { loop: false } });
    t.scheduler.start();
    t.clock.advance(500 + 2000 + 500);
    expect(t.ofType('finished')).toHaveLength(0);
    t.scheduler.ended(1);
    expect(t.ofType('finished')).toHaveLength(1);
  });

  it('«Volver a empezar» reinicia desde la 0', () => {
    const t = setup([photo, photo], { settings: { loop: false } });
    t.scheduler.start();
    t.clock.advance(500 + 2000 + 500 + 2000);
    expect(t.scheduler.snapshot().phase).toBe('finished');
    t.scheduler.restart();
    expect(t.transitions()).toEqual([0, 1, 0]);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 0, phase: 'entering' });
    t.clock.advance(500 + 2000 + 500);
    expect(t.transitions()).toEqual([0, 1, 0, 1]);
  });

  it('una sola diapositiva en bucle: la foto reinicia su tiempo y el vídeo se repite', () => {
    const p = setup([photo]);
    p.scheduler.start();
    p.clock.advance(500 + 2000 * 3);
    expect(p.transitions()).toEqual([0]);
    expect(p.ofType('finished')).toHaveLength(0);

    const v = setup([video]);
    v.scheduler.start();
    v.clock.advance(500);
    v.scheduler.ended(0);
    expect(v.ofType('replay').map((e) => e.index)).toEqual([0]);
    expect(v.transitions()).toEqual([0]);
    expect(v.scheduler.next()).toBe(false);
  });

  it('una sola diapositiva sin bucle: termina', () => {
    const t = setup([photo], { settings: { loop: false } });
    t.scheduler.start();
    t.clock.advance(500 + 2000);
    expect(t.ofType('finished')).toHaveLength(1);
  });
});

describe('scheduler: pausa y reanudación', () => {
  it('congela el tiempo que queda de una foto y lo conserva al reanudar', () => {
    const t = setup([photo, photo]);
    t.scheduler.start();
    t.clock.advance(500 + 1200);
    t.scheduler.pause();
    expect(t.ofType('paused')).toHaveLength(1);
    expect(t.scheduler.snapshot().paused).toBe(true);
    t.clock.advance(60_000);
    expect(t.transitions()).toEqual([0]);
    t.scheduler.resume();
    expect(t.ofType('resumed')).toHaveLength(1);
    t.clock.advance(799);
    expect(t.transitions()).toEqual([0]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1]);
  });

  it('pausar a mitad de la entrada congela también la transición', () => {
    const t = setup([photo, photo]);
    t.scheduler.start();
    t.clock.advance(200);
    t.scheduler.pause();
    t.clock.advance(10_000);
    expect(t.showings()).toEqual([]);
    t.scheduler.resume();
    t.clock.advance(299);
    expect(t.showings()).toEqual([]);
    t.clock.advance(1);
    expect(t.showings()).toEqual([0]);
  });

  it('pausar dos veces o reanudar sin pausa no hace nada', () => {
    const t = setup([photo, photo]);
    t.scheduler.start();
    t.scheduler.resume();
    t.scheduler.pause();
    t.scheduler.pause();
    expect(t.ofType('paused')).toHaveLength(1);
    expect(t.ofType('resumed')).toHaveLength(0);
  });

  it('pausa durante la espera de 8 s: el plazo también se conserva', () => {
    const t = setup([photo, photo], { reply: (i) => (i === 1 ? 'never' : 'load') });
    t.scheduler.start();
    t.clock.advance(500 + 2000 + 3000);
    t.scheduler.pause();
    t.clock.advance(60_000);
    expect(t.ofType('skipped')).toHaveLength(0);
    t.scheduler.resume();
    t.clock.advance(READY_TIMEOUT_MS - 3000 - 1);
    expect(t.ofType('skipped')).toHaveLength(0);
    t.clock.advance(1);
    expect(t.ofType('skipped').map((e) => e.index)).toEqual([1]);
  });

  it('un vídeo que termina mientras está en pausa avanza al reanudar', () => {
    const t = setup([video, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.pause();
    t.scheduler.ended(0);
    expect(t.transitions()).toEqual([0]);
    t.scheduler.resume();
    expect(t.transitions()).toEqual([0, 1]);
  });

  it('`loaded` de la siguiente en pausa no empieza la transición hasta reanudar', () => {
    let release = false;
    const t = setup([photo, photo], { reply: (i) => (i === 1 && !release ? 'never' : 'load') });
    t.scheduler.start();
    t.clock.advance(500 + 2000);
    t.scheduler.pause();
    t.scheduler.loaded(1);
    expect(t.transitions()).toEqual([0]);
    t.scheduler.resume();
    release = true;
    expect(t.transitions()).toEqual([0, 1]);
  });

  it('togglePause alterna', () => {
    const t = setup([photo, photo]);
    t.scheduler.start();
    t.scheduler.togglePause();
    expect(t.scheduler.snapshot().paused).toBe(true);
    t.scheduler.togglePause();
    expect(t.scheduler.snapshot().paused).toBe(false);
  });
});

describe('scheduler: siguiente y anterior manuales', () => {
  it('siguiente cancela el temporizador y empieza la transición de inmediato', () => {
    const t = setup([photo, photo, photo]);
    t.scheduler.start();
    t.clock.advance(500 + 100);
    expect(t.scheduler.next()).toBe(true);
    expect(t.transitions()).toEqual([0, 1]);
    expect(t.ofType('transition')[1].manual).toBe(true);
    // El temporizador de la 0 no dispara un segundo salto.
    t.clock.advance(500);
    expect(t.transitions()).toEqual([0, 1]);
    // La 1 se muestra slideMs desde que termina de entrar.
    t.clock.advance(1999);
    expect(t.transitions()).toEqual([0, 1]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1, 2]);
  });

  it('anterior vuelve a la diapositiva previa y la transición va hacia atrás', () => {
    const t = setup([photo, photo, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.next();
    t.clock.advance(500);
    expect(t.scheduler.prev()).toBe(true);
    const last = t.ofType('transition').at(-1);
    expect(last).toMatchObject({ from: 1, to: 0, direction: 'back' });
  });

  it('en los bordes sin bucle no hace nada: anterior en la 0 y siguiente en la última', () => {
    const t = setup([photo, photo], { settings: { loop: false } });
    t.scheduler.start();
    t.clock.advance(500);
    expect(t.scheduler.prev()).toBe(false);
    expect(t.transitions()).toEqual([0]);
    t.scheduler.next();
    t.clock.advance(500);
    expect(t.scheduler.next()).toBe(false);
    expect(t.transitions()).toEqual([0, 1]);
    // Y el tiempo de la última sigue corriendo: acaba normalmente.
    t.clock.advance(2000);
    expect(t.ofType('finished')).toHaveLength(1);
  });

  it('en los bordes con bucle da la vuelta', () => {
    const t = setup([photo, photo, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    expect(t.scheduler.prev()).toBe(true);
    expect(t.transitions()).toEqual([0, 2]);
    t.clock.advance(500);
    expect(t.scheduler.next()).toBe(true);
    expect(t.transitions()).toEqual([0, 2, 0]);
  });

  it('antes de que cargue la primera, siguiente y anterior no hacen nada', () => {
    const t = setup([photo, photo], { reply: () => 'never' });
    t.scheduler.start();
    expect(t.scheduler.next()).toBe(false);
    expect(t.scheduler.prev()).toBe(false);
  });

  it('pulsar siguiente dos veces seguidas con la destino sin cargar avanza dos', () => {
    const t = setup([photo, photo, photo, photo], {
      reply: (i) => (i === 1 || i === 2 ? 'never' : 'load'),
    });
    t.scheduler.start();
    t.clock.advance(500);
    expect(t.scheduler.next()).toBe(true);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 0, pendingIndex: 1 });
    expect(t.scheduler.next()).toBe(true);
    expect(t.scheduler.snapshot()).toMatchObject({ pendingIndex: 2 });
    t.scheduler.loaded(2);
    expect(t.transitions()).toEqual([0, 2]);
  });

  it('anterior desde una espera cancela la espera', () => {
    const t = setup([photo, photo, photo], { reply: (i) => (i === 1 ? 'never' : 'load') });
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.next();
    expect(t.scheduler.snapshot().pendingIndex).toBe(1);
    expect(t.scheduler.prev()).toBe(true);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 0, pendingIndex: null });
    // Sin dejar un temporizador de 8 s vivo: pasados 8 s no se omite la 1.
    t.clock.advance(READY_TIMEOUT_MS);
    expect(t.ofType('skipped')).toHaveLength(0);
  });

  it('navegar en mitad de una transición corta la capa saliente', () => {
    const t = setup([photo, photo, photo]);
    t.scheduler.start();
    t.clock.advance(500 + 2000); // empieza la entrada de la 1 (saliente: 0)
    t.clock.advance(100);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 1, leavingIndex: 0 });
    t.scheduler.next();
    expect(t.ofType('left')).toEqual([{ type: 'left', index: 0, dropped: true }]);
    expect(t.ofType('transition').at(-1)).toMatchObject({ from: 1, to: 2 });
    expect(t.scheduler.snapshot()).toMatchObject({ index: 2, leavingIndex: 1 });
  });

  it('en pausa, navegar a mano hace la transición pero deja el tiempo de la foto congelado', () => {
    const t = setup([photo, photo, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.pause();
    t.scheduler.next();
    t.clock.advance(500);
    expect(t.showings()).toEqual([0, 1]);
    t.clock.advance(60_000);
    expect(t.transitions()).toEqual([0, 1]);
    t.scheduler.resume();
    t.clock.advance(1999);
    expect(t.transitions()).toEqual([0, 1]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1, 2]);
  });
});

describe('scheduler: diapositivas que no cargan', () => {
  it('una no lista a tiempo se omite a los 8 s y se pasa a la siguiente', () => {
    const t = setup([photo, photo, photo], { reply: (i) => (i === 1 ? 'never' : 'load') });
    t.scheduler.start();
    t.clock.advance(500 + 2000);
    expect(t.scheduler.snapshot().pendingIndex).toBe(1);
    t.clock.advance(READY_TIMEOUT_MS - 1);
    expect(t.transitions()).toEqual([0]);
    t.clock.advance(1);
    expect(t.ofType('skipped').map((e) => e.index)).toEqual([1]);
    expect(t.transitions()).toEqual([0, 2]);
  });

  it('`failed` de la esperada la omite al momento, sin esperar los 8 s', () => {
    const t = setup([photo, photo, photo], { reply: (i) => (i === 1 ? 'fail' : 'load') });
    t.scheduler.start();
    t.clock.advance(500 + 2000);
    expect(t.ofType('skipped').map((e) => e.index)).toEqual([1]);
    expect(t.transitions()).toEqual([0, 2]);
  });

  it('una omitida no se vuelve a esperar en las vueltas siguientes', () => {
    const t = setup([photo, photo, photo], { reply: (i) => (i === 1 ? 'fail' : 'load') });
    t.scheduler.start();
    t.clock.advance(500 + 2000 + 500 + 2000 + 500);
    expect(t.transitions()).toEqual([0, 2, 0]);
    expect(t.ofType('skipped')).toHaveLength(1);
  });

  it('`failed` de la actual (error al reproducir) pasa a la siguiente', () => {
    const t = setup([video, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.failed(0);
    expect(t.transitions()).toEqual([0, 1]);
  });

  it('si fallan todas, avisa y se detiene', () => {
    const t = setup([photo, photo, photo], { reply: () => 'fail' });
    t.scheduler.start();
    expect(t.ofType('failed-all')).toHaveLength(1);
    expect(t.scheduler.snapshot().phase).toBe('failed');
    expect(t.transitions()).toEqual([]);
  });

  it('si falla la primera, empieza por la siguiente', () => {
    const t = setup([photo, photo], { reply: (i) => (i === 0 ? 'fail' : 'load') });
    t.scheduler.start();
    expect(t.transitions()).toEqual([1]);
  });

  it('sin diapositivas, start avisa de que no hay nada que reproducir', () => {
    const t = setup([]);
    t.scheduler.start();
    expect(t.ofType('failed-all')).toHaveLength(1);
  });

  it('una carga tardía de una omitida la recupera', () => {
    const t = setup([photo, photo, photo], { reply: (i) => (i === 1 ? 'fail' : 'load') });
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.loaded(1);
    t.clock.advance(2000);
    expect(t.transitions()).toEqual([0, 1]);
  });
});

describe('scheduler: ajustes en vivo', () => {
  it('la transición y la duración se aplican desde la diapositiva siguiente', () => {
    const t = setup([photo, photo, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    t.scheduler.updateSettings({ slideMs: 4000, transition: 'zoom', transitionMs: 1000 });
    // La 0 sigue con su temporizador de 2000 ms.
    t.clock.advance(1999);
    expect(t.transitions()).toEqual([0]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1]);
    expect(t.ofType('transition')[1].plan).toMatchObject({ type: 'zoom', durationMs: 1000 });
    t.clock.advance(1000 + 3999);
    expect(t.transitions()).toEqual([0, 1]);
    t.clock.advance(1);
    expect(t.transitions()).toEqual([0, 1, 2]);
  });
});

describe('scheduler: elección aleatoria de la transición', () => {
  function sequence(values: number[]) {
    let calls = 0;
    const rng = () => values[calls++ % values.length];
    return { rng, calls: () => calls };
  }

  it('se sortea UNA vez, cuando empieza la transición (no al precargar ni al cambiar ajustes)', () => {
    const seq = sequence([0.5]);
    const t = setup([photo, photo, photo], {
      settings: { transition: 'random', randomPool: ['fade', 'slide'] },
      rng: seq.rng,
    });
    expect(seq.calls()).toBe(0);
    t.scheduler.start();
    // La primera transición consumió una llamada; prepare(0) y la entrada no más.
    expect(seq.calls()).toBe(1);
    t.clock.advance(500); // showing(0) → prepare(1)
    expect(t.prepares()).toEqual([0, 1]);
    expect(seq.calls()).toBe(1);
    t.scheduler.updateSettings({ slideMs: 3000 });
    expect(seq.calls()).toBe(1);
    t.clock.advance(2000);
    expect(seq.calls()).toBe(2);
  });

  it('una navegación pendiente (sin cargar) no sortea hasta que la transición empieza', () => {
    const seq = sequence([0]);
    const t = setup([photo, photo], {
      settings: { transition: 'random' },
      rng: seq.rng,
      reply: (i) => (i === 1 ? 'never' : 'load'),
    });
    t.scheduler.start();
    t.clock.advance(500);
    const before = seq.calls();
    t.scheduler.next();
    expect(seq.calls()).toBe(before);
    t.scheduler.loaded(1);
    expect(seq.calls()).toBe(before + 1);
  });

  it('nunca repite la anterior si el grupo tiene más de un tipo', () => {
    // RNG fijo a 0: sin la regla saldría siempre el primero del grupo.
    const t = setup([photo, photo, photo, photo], {
      settings: { transition: 'random', randomPool: ['fade', 'slide', 'zoom'], loop: true },
      rng: () => 0,
    });
    t.scheduler.start();
    t.clock.advance(500 + 6 * 2500);
    const picked = t.ofType('transition').map((e) => e.plan.picked);
    expect(picked.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < picked.length; i += 1) expect(picked[i]).not.toBe(picked[i - 1]);
  });

  it('con un solo tipo en el grupo lo repite', () => {
    const t = setup([photo, photo, photo], {
      settings: { transition: 'random', randomPool: ['zoom'] },
    });
    t.scheduler.start();
    t.clock.advance(500 + 2 * 2500);
    expect(t.ofType('transition').map((e) => e.plan.type)).toEqual(['zoom', 'zoom', 'zoom']);
  });

  it('con Ken Burns en una foto se consumen tres llamadas (sorteo + dirección + módulo)', () => {
    const seq = sequence([0.9, 0.1, 0.1]);
    const t = setup([photo], {
      settings: { transition: 'random', randomPool: ['fade', 'kenburns'] },
      rng: seq.rng,
    });
    t.scheduler.start();
    // 0,9 de 2 candidatos → `kenburns`; luego dirección y módulo.
    expect(t.ofType('transition')[0].plan.type).toBe('kenburns');
    expect(seq.calls()).toBe(3);
  });
});

describe('scheduler: reentrada y limpieza', () => {
  it('un oyente que responde `loaded` de forma síncrona no ve estados a medias', () => {
    const t = setup([photo, video, photo]);
    t.scheduler.start();
    t.clock.advance(500);
    expect(t.events.map((e) => e.type).slice(0, 4)).toEqual([
      'prepare',
      'transition',
      'showing',
      'prepare',
    ]);
  });

  it('destroy detiene los temporizadores', () => {
    const t = setup([photo, photo]);
    t.scheduler.start();
    t.scheduler.destroy();
    expect(t.clock.pending).toBe(0);
    t.clock.advance(60_000);
    expect(t.transitions()).toEqual([0]);
  });

  it('unsubscribe deja de avisar', () => {
    const clock = new FakeClock();
    const s = new PresentationScheduler([photo], {}, { timers: clock, rng: () => 0 });
    const seen: string[] = [];
    const off = s.subscribe((e) => seen.push(e.type));
    off();
    s.start();
    expect(seen).toEqual([]);
  });
});
