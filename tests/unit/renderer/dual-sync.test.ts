// Sincronización de la reproducción dual (docs/PLAN.md 5.2, docs/DESIGN.md §18.1): cada rama del
// controlador de deriva y el regreso a la velocidad normal, con elementos de vídeo falsos y un reloj
// falso (sin DOM).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adjustedRate,
  DRIFT_ADJUST_MIN_S,
  DRIFT_JUMP_S,
  DRIFT_SETTLE_S,
  DRIFT_TICK_MS,
  driftAction,
  masterSide,
  slaveSeekTime,
  SyncController,
  timelineDuration,
  type SyncMedia,
} from '@renderer/screens/dual/sync';
import { FakeClock } from './helpers/fake-clock';

class FakeMedia implements SyncMedia {
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  readyState = 4;
  plays = 0;
  pauses = 0;

  constructor(public duration: number) {}

  get ended(): boolean {
    return this.duration > 0 && this.currentTime >= this.duration;
  }

  play(): Promise<void> {
    this.paused = false;
    this.plays += 1;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.pauses += 1;
  }

  /** Pasa `ms` de reloj: avanza `playbackRate` veces más deprisa si suena. */
  run(ms: number): void {
    if (this.paused || this.ended) return;
    this.currentTime = Math.min(this.duration, this.currentTime + (ms / 1000) * this.playbackRate);
  }
}

interface Rig {
  clock: FakeClock;
  left: FakeMedia;
  right: FakeMedia;
  ctl: SyncController;
  playingChanges: boolean[];
  /** Avanza `ms` de reloj de pared (los vídeos y el reloj falso). */
  step(ms: number): void;
  /** Avanza `ticks` períodos de deriva. */
  ticks(n: number): void;
}

function rig(dLeft: number, dRight: number): Rig {
  const clock = new FakeClock();
  const left = new FakeMedia(dLeft);
  const right = new FakeMedia(dRight);
  const playingChanges: boolean[] = [];
  const ctl = new SyncController(left, right, {
    timers: clock,
    onPlayingChange: (p) => playingChanges.push(p),
  });
  return {
    clock,
    left,
    right,
    ctl,
    playingChanges,
    step: (ms) => {
      left.run(ms);
      right.run(ms);
      clock.advance(ms);
    },
    ticks: (n) => {
      for (let i = 0; i < n; i += 1) {
        left.run(DRIFT_TICK_MS);
        right.run(DRIFT_TICK_MS);
        clock.advance(DRIFT_TICK_MS);
      }
    },
  };
}

describe('driftAction (rama a rama)', () => {
  it('una deriva que no es un número no hace nada', () => {
    expect(driftAction(Number.NaN, 1, false)).toEqual({ kind: 'none' });
    expect(driftAction(Number.POSITIVE_INFINITY, 1, true)).toEqual({ kind: 'none' });
  });

  it('|deriva| > 0,5 s → salto (en los dos sentidos, con y sin ajuste en marcha)', () => {
    expect(driftAction(0.6, 1, false)).toEqual({ kind: 'jump' });
    expect(driftAction(-0.6, 1, false)).toEqual({ kind: 'jump' });
    expect(driftAction(2, 1, true)).toEqual({ kind: 'jump' });
    expect(driftAction(DRIFT_JUMP_S + 0.001, 1, false)).toEqual({ kind: 'jump' });
  });

  it('0,04 < |deriva| ≤ 0,5 s → ajuste de ±5 % (el adelantado va más despacio)', () => {
    expect(driftAction(0.3, 1, false)).toEqual({ kind: 'adjust', rate: 0.95 });
    expect(driftAction(-0.3, 1, false)).toEqual({ kind: 'adjust', rate: 1.05 });
    // 0,5 s exactos todavía es ajuste, no salto.
    expect(driftAction(DRIFT_JUMP_S, 1, false)).toEqual({ kind: 'adjust', rate: 0.95 });
    expect(driftAction(-DRIFT_JUMP_S, 1, false)).toEqual({ kind: 'adjust', rate: 1.05 });
    expect(driftAction(DRIFT_ADJUST_MIN_S + 0.001, 1, false).kind).toBe('adjust');
    // Parte de la velocidad elegida, no de 1×.
    expect(driftAction(0.3, 2, false)).toEqual({ kind: 'adjust', rate: 1.9 });
    expect(driftAction(-0.3, 0.5, true)).toEqual({ kind: 'adjust', rate: 0.525 });
  });

  it('|deriva| ≤ 0,04 s sin ajuste en marcha → nada', () => {
    expect(driftAction(DRIFT_ADJUST_MIN_S, 1, false)).toEqual({ kind: 'none' });
    expect(driftAction(-DRIFT_ADJUST_MIN_S, 1, false)).toEqual({ kind: 'none' });
    expect(driftAction(0.03, 1, false)).toEqual({ kind: 'none' });
    expect(driftAction(0, 1, false)).toEqual({ kind: 'none' });
  });

  it('con el ajuste en marcha: entre 0,02 y 0,04 s sigue ajustando; por debajo de 0,02 s vuelve a rate', () => {
    expect(driftAction(0.03, 1, true)).toEqual({ kind: 'adjust', rate: 0.95 });
    expect(driftAction(-0.03, 1, true)).toEqual({ kind: 'adjust', rate: 1.05 });
    expect(driftAction(DRIFT_ADJUST_MIN_S, 1, true).kind).toBe('adjust');
    expect(driftAction(DRIFT_SETTLE_S, 1, true).kind).toBe('adjust');
    expect(driftAction(DRIFT_SETTLE_S - 0.001, 1, true)).toEqual({ kind: 'restore' });
    expect(driftAction(-0.005, 1, true)).toEqual({ kind: 'restore' });
    expect(driftAction(0, 1, true)).toEqual({ kind: 'restore' });
  });

  it('adjustedRate: rate · (1 − signo(deriva) · 0,05)', () => {
    expect(adjustedRate(1, 0.1)).toBeCloseTo(0.95, 10);
    expect(adjustedRate(1, -0.1)).toBeCloseTo(1.05, 10);
    expect(adjustedRate(1.5, 0.1)).toBeCloseTo(1.425, 10);
    expect(adjustedRate(1, 0)).toBe(1);
  });
});

describe('funciones puras de la línea de tiempo', () => {
  it('el maestro es el más largo; con empate (o sin duraciones), el izquierdo', () => {
    expect(masterSide(20, 12)).toBe('left');
    expect(masterSide(12, 20)).toBe('right');
    expect(masterSide(10, 10)).toBe('left');
    expect(masterSide(0, 0)).toBe('left');
  });

  it('el esclavo busca a min(t, dEsclavo); sin su duración, a t', () => {
    expect(slaveSeekTime(5, 12)).toBe(5);
    expect(slaveSeekTime(15, 12)).toBe(12);
    expect(slaveSeekTime(15, 0)).toBe(15);
    expect(slaveSeekTime(15, Number.NaN)).toBe(15);
  });

  it('la línea de tiempo común mide max(dL, dR)', () => {
    expect(timelineDuration(20, 12)).toBe(20);
    expect(timelineDuration(12, 20)).toBe(20);
    expect(timelineDuration(0, 0)).toBe(0);
  });
});

describe('SyncController', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig(20, 12);
  });

  it('reproducir arranca los dos y avisa; pausar los para, cancela el tic y devuelve la velocidad', () => {
    r.ctl.play();
    expect(r.left.paused).toBe(false);
    expect(r.right.paused).toBe(false);
    expect(r.ctl.playing).toBe(true);
    expect(r.playingChanges).toEqual([true]);
    expect(r.clock.pending).toBe(1);

    r.right.playbackRate = 0.95;
    r.ctl.pause();
    expect(r.left.paused).toBe(true);
    expect(r.right.paused).toBe(true);
    expect(r.right.playbackRate).toBe(1);
    expect(r.ctl.playing).toBe(false);
    expect(r.playingChanges).toEqual([true, false]);
    expect(r.clock.pending).toBe(0);
  });

  it('pausar y reproducir enseguida no duplica el temporizador de deriva', () => {
    r.ctl.play();
    r.ctl.pause();
    r.ctl.play();
    expect(r.clock.pending).toBe(1);
    r.ctl.toggle(); // pausa
    expect(r.ctl.playing).toBe(false);
    r.ctl.toggle(); // reproduce
    expect(r.ctl.playing).toBe(true);
    expect(r.clock.pending).toBe(1);
  });

  it('buscar: maestro en t y esclavo en min(t, dEsclavo); pasado el final del esclavo, queda pausado en su último fotograma', () => {
    r.ctl.play();
    r.ctl.seek(5);
    expect(r.left.currentTime).toBe(5);
    expect(r.right.currentTime).toBe(5);
    expect(r.right.paused).toBe(false);

    r.ctl.seek(15);
    expect(r.left.currentTime).toBe(15);
    expect(r.right.currentTime).toBe(12);
    expect(r.right.paused).toBe(true);
    expect(r.left.paused).toBe(false);

    // Al volver a un punto donde el esclavo tiene vídeo, sigue reproduciéndose con el maestro.
    r.ctl.seek(3);
    expect(r.right.currentTime).toBe(3);
    expect(r.right.paused).toBe(false);
  });

  it('buscar se acota a [0, duración] y seekBy suma al tiempo del maestro', () => {
    r.ctl.seek(-5);
    expect(r.left.currentTime).toBe(0);
    r.ctl.seek(99);
    expect(r.left.currentTime).toBe(20);
    expect(r.right.currentTime).toBe(12);
    r.ctl.seek(10);
    r.ctl.seekBy(10);
    expect(r.ctl.time).toBe(20);
    r.ctl.seekBy(-10);
    expect(r.ctl.time).toBe(10);
    r.ctl.seekBy(-100);
    expect(r.ctl.time).toBe(0);
  });

  it('buscar en pausa no reproduce nada', () => {
    r.ctl.seek(8);
    expect(r.left.paused).toBe(true);
    expect(r.right.paused).toBe(true);
    expect(r.left.plays + r.right.plays).toBe(0);
  });

  it('si el derecho es el más largo, él es el maestro', () => {
    const q = rig(12, 20);
    expect(q.ctl.masterSide).toBe('right');
    expect(q.ctl.duration).toBe(20);
    q.ctl.seek(15);
    expect(q.right.currentTime).toBe(15);
    expect(q.left.currentTime).toBe(12);
    expect(q.ctl.time).toBe(15);
    // Deriva: el esclavo (izquierdo) es el que se corrige.
    q.ctl.seek(2);
    q.ctl.play();
    q.left.currentTime = 2.3;
    q.ticks(1);
    expect(q.left.playbackRate).toBeCloseTo(0.95, 10);
    expect(q.right.playbackRate).toBe(1);
  });

  it('reproducir al final empieza de nuevo desde 0', () => {
    r.ctl.seek(20);
    r.ctl.play();
    expect(r.left.currentTime).toBe(0);
    expect(r.right.currentTime).toBe(0);
    expect(r.left.paused).toBe(false);
  });

  describe('corrección de deriva cada 250 ms', () => {
    beforeEach(() => {
      r.ctl.play();
      r.ticks(1); // sin deriva: nada que corregir
    });

    it('sin deriva (o ≤ 0,04 s) no toca la velocidad ni el tiempo', () => {
      expect(r.right.playbackRate).toBe(1);
      r.right.currentTime = r.left.currentTime + 0.03;
      const before = r.right.currentTime;
      r.ticks(1);
      expect(r.right.playbackRate).toBe(1);
      expect(r.right.currentTime).toBeCloseTo(before + 0.25, 6);
    });

    it('|deriva| > 0,5 s: el esclavo salta al tiempo del maestro', () => {
      r.right.currentTime = r.left.currentTime + 2;
      r.ticks(1);
      expect(Math.abs(r.right.currentTime - r.left.currentTime)).toBeLessThan(0.001);
      expect(r.right.playbackRate).toBe(1);
      // También hacia atrás.
      r.right.currentTime = r.left.currentTime - 3;
      r.ticks(1);
      expect(Math.abs(r.right.currentTime - r.left.currentTime)).toBeLessThan(0.001);
    });

    it('un salto con la velocidad ajustada la devuelve a la normal', () => {
      r.right.currentTime = r.left.currentTime + 0.3;
      r.ticks(1);
      expect(r.right.playbackRate).toBeCloseTo(0.95, 10);
      r.right.currentTime = r.left.currentTime + 1;
      r.ticks(1);
      expect(r.right.playbackRate).toBe(1);
    });

    it('esclavo adelantado: va un 5 % más despacio hasta alcanzar < 0,02 s y entonces vuelve a 1×', () => {
      r.right.currentTime = r.left.currentTime + 0.3;
      r.ticks(1);
      expect(r.right.playbackRate).toBeCloseTo(0.95, 10);
      const rates = new Set<number>();
      let n = 0;
      while (r.right.playbackRate !== 1 && n < 80) {
        r.ticks(1);
        rates.add(r.right.playbackRate);
        n += 1;
      }
      expect(r.right.playbackRate).toBe(1);
      expect(Math.abs(r.right.currentTime - r.left.currentTime)).toBeLessThan(DRIFT_SETTLE_S);
      // El ajuste solo usó la velocidad ajustada y la normal.
      for (const v of rates) expect([0.95, 1]).toContain(Number(v.toFixed(2)));
      // Y se queda en 1×: sin ajuste en marcha, la deriva residual no lo reactiva.
      r.ticks(4);
      expect(r.right.playbackRate).toBe(1);
    });

    it('esclavo retrasado: va un 5 % más deprisa hasta alcanzar al maestro', () => {
      r.right.currentTime = r.left.currentTime - 0.3;
      r.ticks(1);
      expect(r.right.playbackRate).toBeCloseTo(1.05, 10);
      let n = 0;
      while (r.right.playbackRate !== 1 && n < 80) {
        r.ticks(1);
        n += 1;
      }
      expect(r.right.playbackRate).toBe(1);
      expect(Math.abs(r.right.currentTime - r.left.currentTime)).toBeLessThan(DRIFT_SETTLE_S);
    });

    it('con otra velocidad: el ajuste parte de ella y al terminar vuelve a ella', () => {
      r.ctl.setRate(1.5);
      expect(r.left.playbackRate).toBe(1.5);
      expect(r.right.playbackRate).toBe(1.5);
      r.right.currentTime = r.left.currentTime + 0.2;
      r.ticks(1);
      expect(r.right.playbackRate).toBeCloseTo(1.425, 10);
      expect(r.left.playbackRate).toBe(1.5);
      let n = 0;
      while (r.right.playbackRate !== 1.5 && n < 200) {
        r.ticks(1);
        n += 1;
      }
      expect(r.right.playbackRate).toBe(1.5);
    });

    it('cambiar la velocidad durante un ajuste lo cancela', () => {
      r.right.currentTime = r.left.currentTime + 0.3;
      r.ticks(1);
      expect(r.right.playbackRate).toBeCloseTo(0.95, 10);
      r.ctl.setRate(2);
      expect(r.right.playbackRate).toBe(2);
      expect(r.left.playbackRate).toBe(2);
    });

    it('buscar durante un ajuste devuelve la velocidad normal', () => {
      r.right.currentTime = r.left.currentTime + 0.3;
      r.ticks(1);
      r.ctl.seek(4);
      expect(r.right.playbackRate).toBe(1);
    });

    it('no corrige un esclavo que ya llegó a su final', () => {
      r.ctl.seek(15);
      expect(r.right.currentTime).toBe(12);
      r.ticks(2);
      expect(r.right.currentTime).toBe(12);
      expect(r.right.playbackRate).toBe(1);
      expect(r.right.paused).toBe(true);
    });

    it('si cambia el maestro (las duraciones se conocen tarde), se restablecen las velocidades', () => {
      const q = rig(0, 0);
      q.ctl.play();
      q.ticks(1);
      q.left.duration = 10;
      q.right.duration = 12; // ahora el derecho es el maestro
      q.left.playbackRate = 0.95; // quedó de un ajuste anterior
      q.ticks(1);
      expect(q.left.playbackRate).toBe(1);
    });
  });

  describe('pausa cruzada con waiting / canplay', () => {
    beforeEach(() => {
      r.ctl.play();
    });

    it('si uno emite waiting, el otro se pausa; con canplay y los dos listos, se reanudan', () => {
      r.ctl.handleWaiting('left');
      expect(r.right.paused).toBe(true);
      expect(r.left.paused).toBe(false); // el que espera sigue por su cuenta
      expect(r.ctl.playing).toBe(true); // el estado del conjunto no cambia
      r.ctl.handleCanPlay();
      expect(r.right.paused).toBe(false);
      expect(r.left.paused).toBe(false);
    });

    it('espera a que los DOS puedan seguir', () => {
      r.right.readyState = 2;
      r.ctl.handleWaiting('left');
      expect(r.right.paused).toBe(true);
      r.ctl.handleCanPlay(); // el derecho aún no está listo
      expect(r.right.paused).toBe(true);
      r.right.readyState = 4;
      r.ctl.handleCanPlay();
      expect(r.right.paused).toBe(false);
    });

    it('si el esclavo es el que espera, se pausa el maestro', () => {
      r.ctl.handleWaiting('right');
      expect(r.left.paused).toBe(true);
      r.ctl.handleCanPlay();
      expect(r.left.paused).toBe(false);
    });

    it('mientras está en pausa cruzada no se corrige la deriva', () => {
      r.ticks(1);
      r.ctl.handleWaiting('left');
      r.right.currentTime = r.left.currentTime + 2;
      const before = r.right.currentTime;
      r.ticks(2);
      expect(r.right.currentTime).toBe(before);
    });

    it('canplay sin pausa cruzada, o con el conjunto en pausa, no arranca nada', () => {
      r.ctl.handleCanPlay();
      expect(r.right.plays).toBe(1); // solo el play() inicial
      r.ctl.pause();
      r.ctl.handleWaiting('left');
      r.ctl.handleCanPlay();
      expect(r.left.paused).toBe(true);
      expect(r.right.paused).toBe(true);
    });

    it('waiting de un esclavo que ya terminó se ignora', () => {
      r.ctl.seek(15); // el derecho (12 s) queda en su último fotograma
      r.ctl.handleWaiting('right');
      expect(r.left.paused).toBe(false);
    });
  });

  describe('final del maestro', () => {
    it('con bucle, los dos vuelven a 0 y siguen sonando', () => {
      r.ctl.setLoop(true);
      r.ctl.play();
      r.ctl.seek(19.9);
      r.left.currentTime = 20; // el maestro terminó
      r.left.paused = true; // el navegador lo pausa al terminar
      r.ctl.handleEnded('left');
      expect(r.left.currentTime).toBe(0);
      expect(r.right.currentTime).toBe(0);
      expect(r.left.paused).toBe(false);
      expect(r.right.paused).toBe(false);
      expect(r.ctl.playing).toBe(true);
    });

    it('sin bucle, se pausan los dos y el conjunto deja de sonar', () => {
      r.ctl.play();
      r.left.currentTime = 20;
      r.ctl.handleEnded('left');
      expect(r.left.paused).toBe(true);
      expect(r.right.paused).toBe(true);
      expect(r.ctl.playing).toBe(false);
      expect(r.playingChanges).toEqual([true, false]);
      expect(r.clock.pending).toBe(0);
    });

    it('el final del esclavo no hace nada: se queda en su último fotograma mientras el maestro sigue', () => {
      r.ctl.setLoop(true);
      r.ctl.play();
      r.right.currentTime = 12;
      r.right.paused = true;
      r.ctl.handleEnded('right');
      expect(r.ctl.playing).toBe(true);
      expect(r.left.paused).toBe(false);
      expect(r.left.currentTime).toBe(0);
    });

    it('un ended con el conjunto en pausa se ignora', () => {
      r.ctl.setLoop(true);
      r.ctl.handleEnded('left');
      expect(r.left.plays).toBe(0);
    });

    it('con la misma duración, el bucle lo manda el izquierdo', () => {
      const q = rig(10, 10);
      q.ctl.setLoop(true);
      q.ctl.play();
      q.ctl.handleEnded('right'); // el derecho no manda
      expect(q.left.currentTime).toBe(0);
      q.left.currentTime = 9.9;
      q.right.currentTime = 9.9;
      q.ctl.handleEnded('left');
      expect(q.right.currentTime).toBe(0);
    });
  });

  it('dispose: devuelve la velocidad normal y deja de corregir', () => {
    r.ctl.play();
    r.right.currentTime = r.left.currentTime + 0.3;
    r.ticks(1);
    expect(r.right.playbackRate).toBeCloseTo(0.95, 10);
    r.ctl.dispose();
    expect(r.right.playbackRate).toBe(1);
    expect(r.clock.pending).toBe(0);
    const at = r.left.currentTime;
    r.ctl.seek(3);
    r.ctl.play();
    expect(r.left.currentTime).toBe(at); // desechado: ya no actúa
  });

  it('un play() rechazado (política de autoplay) no rompe el controlador', async () => {
    r.left.play = () => Promise.reject(new Error('NotAllowedError'));
    r.ctl.play();
    await Promise.resolve();
    expect(r.ctl.playing).toBe(true);
  });
});
