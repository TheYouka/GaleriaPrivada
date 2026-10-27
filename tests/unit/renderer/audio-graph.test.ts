// Grafo de audio de la presentación (docs/DESIGN.md §17.8) con Web Audio falso: los cuatro modos,
// los fundidos con cancel-and-hold, el cambio de modo en mitad de un fundido y la conexión con el
// planificador. Ningún test usa OfflineAudioContext (Node no tiene Web Audio).
import { describe, expect, it } from 'vitest';
import type { AudioMode } from '../../../src/shared/types';
import {
  PresentationAudio,
  bindAudio,
  type AudioSettings,
  type PresentationAudioHooks,
} from '../../../src/renderer/src/screens/presentation/audio-graph';
import {
  PresentationScheduler,
  type SlideSpec,
} from '../../../src/renderer/src/screens/presentation/scheduler';
import { FakeAudioContext, FakeAudioParam, FakeMediaElement } from './helpers/fake-audio';
import { FakeClock } from './helpers/fake-clock';

const SETTINGS: AudioSettings = {
  audioMode: 'video',
  musicEnabled: true,
  musicVolume: 0.7,
  videoVolume: 1,
  musicFadeMs: 1500,
};

function setup(overrides: Partial<AudioSettings> = {}, hooks: PresentationAudioHooks = {}) {
  const ctx = new FakeAudioContext();
  const clock = new FakeClock();
  const music = new FakeMediaElement();
  const videos = [new FakeMediaElement(), new FakeMediaElement(), new FakeMediaElement()];
  const audio = new PresentationAudio(
    ctx,
    music,
    videos,
    { ...SETTINGS, ...overrides },
    clock,
    hooks,
  );
  /** Avanza los dos relojes a la vez, en pasos de 10 ms. */
  let elapsedMs = 0;
  const elapse = (ms: number): void => {
    for (let left = ms; left > 0; left -= 10) {
      const step = Math.min(10, left);
      elapsedMs += step;
      // Tiempo exacto (sin acumular coma flotante) y 1 ns de margen: las rampas acaban en t0 + ms.
      ctx.currentTime = 1 + elapsedMs / 1000 + 1e-9;
      clock.advance(step);
    }
  };
  const params = (): FakeAudioParam[] => ctx.gains.map((g) => g.gain);
  const musicGain = (): number => audio.musicGainValue;
  const videoGain = (slot: number): number => audio.videoGainValue(slot);
  const photoIn = (d = 500): void =>
    audio.onTransition({
      fromKind: null,
      fromSlot: null,
      toKind: 'photo',
      toSlot: null,
      durationMs: d,
    });
  const videoIn = (
    slot: number,
    from: 'photo' | 'video' | null = 'photo',
    fromSlot: number | null = null,
    d = 500,
  ): void =>
    audio.onTransition({ fromKind: from, fromSlot, toKind: 'video', toSlot: slot, durationMs: d });
  const photoFromVideo = (fromSlot: number, d = 500): void =>
    audio.onTransition({
      fromKind: 'video',
      fromSlot,
      toKind: 'photo',
      toSlot: null,
      durationMs: d,
    });
  return {
    ctx,
    clock,
    music,
    videos,
    audio,
    elapse,
    params,
    musicGain,
    videoGain,
    photoIn,
    videoIn,
    photoFromVideo,
  };
}

function expectCleanParams(params: FakeAudioParam[]): void {
  for (const p of params) {
    expect(p.errors).toEqual([]);
    expect(p.methodsCalled().has('setValueCurveAtTime')).toBe(false);
  }
}

describe('PresentationAudio: construcción', () => {
  it('conecta cada elemento una sola vez y todo termina en master → destino', () => {
    const t = setup();
    expect(t.ctx.sources).toHaveLength(4); // música + pool de 3 vídeos
    expect(new Set(t.ctx.sources.map((s) => s.element)).size).toBe(4);
    expect(t.audio.master.connect).toBeDefined();
    const masterGain = t.ctx.gains[0];
    expect(masterGain.connections).toEqual([t.ctx.destination]);
    for (const g of t.ctx.gains.slice(1)) expect(g.connections).toEqual([masterGain]);
  });

  it('arranca en silencio (música y vídeos a 0, master a 1)', () => {
    const t = setup();
    expect(t.musicGain()).toBe(0);
    expect([0, 1, 2].map(t.videoGain)).toEqual([0, 0, 0]);
    expect(t.audio.master.gain.value).toBe(1);
  });
});

describe('modo `video` (por defecto)', () => {
  it('inicio: la música sube de 0 a musicVolume en musicFadeMs', () => {
    const t = setup();
    t.photoIn();
    expect(t.music.playCalls).toBe(1);
    t.elapse(750);
    expect(t.musicGain()).toBeGreaterThan(0.4);
    expect(t.musicGain()).toBeLessThan(0.7);
    t.elapse(751);
    expect(t.musicGain()).toBe(0.7);
  });

  it('en un vídeo: la música baja a 0 y se pausa al terminar el fundido; el vídeo sube al empezar', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.videoIn(0);
    // La música baja desde que empieza la transición de entrada y se pausa después, no antes.
    t.elapse(1000);
    expect(t.musicGain()).toBeLessThan(0.7);
    expect(t.music.paused).toBe(false);
    t.elapse(500);
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
    // El audio del vídeo espera a que empiece a reproducirse.
    expect(t.videoGain(0)).toBe(0);
    t.audio.onShowing();
    t.elapse(150);
    expect(t.videoGain(0)).toBeGreaterThan(0.5);
    t.elapse(160);
    expect(t.videoGain(0)).toBe(1);
  });

  it('al salir del vídeo: el vídeo baja en min(300, D) y la música se reanuda donde se quedó', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.videoIn(0);
    t.elapse(2000);
    t.audio.onShowing();
    t.elapse(400);
    const playsBefore = t.music.playCalls;
    t.photoFromVideo(0, 200); // D = 200 < 300
    expect(t.music.playCalls).toBe(playsBefore + 1);
    expect(t.music.paused).toBe(false);
    t.elapse(100);
    expect(t.videoGain(0)).toBeGreaterThan(0);
    expect(t.videoGain(0)).toBeLessThan(1);
    t.elapse(110);
    expect(t.videoGain(0)).toBe(0);
    t.elapse(1500);
    expect(t.musicGain()).toBe(0.7);
  });

  it('con D grande el vídeo baja en 300 ms', () => {
    const t = setup();
    t.videoIn(0, null);
    t.audio.onShowing();
    t.elapse(400);
    expect(t.videoGain(0)).toBe(1);
    t.photoFromVideo(0, 700);
    t.elapse(310);
    expect(t.videoGain(0)).toBe(0);
  });

  it('D = 0 (corte): el audio del vídeo cae de golpe', () => {
    const t = setup();
    t.videoIn(0, null);
    t.audio.onShowing();
    t.elapse(400);
    t.photoFromVideo(0, 0);
    expect(t.videoGain(0)).toBe(0);
  });

  it('dos vídeos seguidos: la música sigue apagada y cada uno usa su hueco del pool', () => {
    const t = setup();
    t.videoIn(0, null);
    t.audio.onShowing();
    t.elapse(2000);
    t.videoIn(1, 'video', 0);
    t.elapse(400);
    expect(t.videoGain(0)).toBe(0);
    t.audio.onShowing();
    t.elapse(400);
    expect(t.videoGain(1)).toBe(1);
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
  });
});

describe('modo `music`', () => {
  it('en los vídeos sigue sonando la música y el vídeo está a 0', () => {
    const t = setup({ audioMode: 'music' });
    t.photoIn();
    t.elapse(1600);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(2000);
    expect(t.musicGain()).toBe(0.7);
    expect(t.music.paused).toBe(false);
    expect(t.videoGain(0)).toBe(0);
  });
});

describe('modo `both`', () => {
  it('en los vídeos suenan la música y el vídeo', () => {
    const t = setup({ audioMode: 'both' });
    t.photoIn();
    t.elapse(1600);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(2000);
    expect(t.musicGain()).toBe(0.7);
    expect(t.videoGain(0)).toBe(1);
  });
});

describe('modo `mute` y todo en silencio', () => {
  it('«Silencio en los vídeos» con música: suena en las fotos y se apaga en los vídeos', () => {
    const t = setup({ audioMode: 'mute' });
    t.photoIn();
    t.elapse(1600);
    expect(t.musicGain()).toBe(0.7);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(2000);
    expect(t.musicGain()).toBe(0);
    expect(t.videoGain(0)).toBe(0);
    expect(t.music.paused).toBe(true);
  });

  it('(4) mute + música de fondo apagada: ninguna ganancia sube en toda la secuencia', () => {
    const t = setup({ audioMode: 'mute', musicEnabled: false });
    t.photoIn();
    t.elapse(2000);
    expect(t.musicGain()).toBe(0);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(2000);
    expect(t.videoGain(0)).toBe(0);
    t.photoFromVideo(0);
    t.elapse(2000);
    expect(t.musicGain()).toBe(0);
    expect(t.music.playCalls).toBe(0);
    for (const g of t.params()) {
      const rampValues = g.calls.filter((c) => c.method === 'linearRampToValueAtTime');
      expect(rampValues.every((c) => c.args[0] === 0)).toBe(true);
    }
  });

  it('(1) con la música de fondo apagada, el modo por defecto deja solo el audio del vídeo', () => {
    const t = setup({ audioMode: 'video', musicEnabled: false });
    t.photoIn();
    t.elapse(2000);
    expect(t.musicGain()).toBe(0);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(2000);
    expect(t.videoGain(0)).toBe(1);
    expect(t.musicGain()).toBe(0);
  });
});

describe('cambios de modo en vivo, incluso en mitad de un fundido', () => {
  it('de `video` a `music` durante el fundido de bajada: la música vuelve a subir sin saltos y no se pausa', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(600);
    const mid = t.musicGain();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.7);
    t.audio.setAudioMode('music');
    // Continuidad: arranca desde el valor que tenía, sin salto.
    expect(t.musicGain()).toBeCloseTo(mid, 9);
    t.elapse(1600);
    expect(t.musicGain()).toBe(0.7);
    // El temporizador de pausa del fundido anterior quedó cancelado.
    expect(t.music.paused).toBe(false);
    t.elapse(400);
    expect(t.videoGain(0)).toBe(0);
    expectCleanParams(t.params());
  });

  it('de `both` a `mute` con el audio del vídeo subiendo: el vídeo baja desde donde estaba', () => {
    const t = setup({ audioMode: 'both' });
    t.videoIn(0, null);
    t.audio.onShowing();
    t.elapse(100);
    const mid = t.videoGain(0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    t.audio.setAudioMode('mute');
    expect(t.videoGain(0)).toBeCloseTo(mid, 9);
    t.elapse(310);
    expect(t.videoGain(0)).toBe(0);
    t.elapse(1600);
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
    expectCleanParams(t.params());
  });

  it('de `mute` a `video` en un vídeo ya en marcha: el audio del vídeo sube', () => {
    const t = setup({ audioMode: 'mute' });
    t.videoIn(0, null);
    t.audio.onShowing();
    t.elapse(2000);
    expect(t.videoGain(0)).toBe(0);
    t.audio.setAudioMode('video');
    t.elapse(310);
    expect(t.videoGain(0)).toBe(1);
  });

  it('muchos cambios de modo seguidos no producen ningún error de Web Audio', () => {
    const t = setup();
    t.photoIn();
    t.elapse(400);
    t.videoIn(0);
    t.audio.onShowing();
    const modes: AudioMode[] = ['video', 'music', 'both', 'mute'];
    for (let i = 0; i < 60; i += 1) {
      t.elapse(37);
      t.audio.setAudioMode(modes[i % 4]);
      if (i % 5 === 0) t.audio.setMusicEnabled(i % 2 === 0);
    }
    t.elapse(5000);
    expectCleanParams(t.params());
  });

  it('«Música de fondo» apagada en una foto la desvanece y la pausa; encendida la reanuda', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.audio.setMusicEnabled(false);
    t.elapse(1600);
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
    t.audio.setMusicEnabled(true);
    t.elapse(1600);
    expect(t.musicGain()).toBe(0.7);
    expect(t.music.paused).toBe(false);
  });
});

describe('volumen del usuario (§17.8)', () => {
  it('si esa ganancia está sonando, hace un fundido de 100 ms', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.audio.setMusicVolume(0.2);
    t.elapse(50);
    expect(t.musicGain()).toBeGreaterThan(0.2);
    expect(t.musicGain()).toBeLessThan(0.7);
    t.elapse(60);
    expect(t.musicGain()).toBe(0.2);
  });

  it('si no suena (música durante un vídeo en modo `video`), solo se guarda para el siguiente fundido', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.videoIn(0);
    t.elapse(2000);
    const callsBefore = t.ctx.gains[1].gain.calls.length;
    t.audio.setMusicVolume(0.3);
    expect(t.ctx.gains[1].gain.calls.length).toBe(callsBefore);
    expect(t.musicGain()).toBe(0);
    t.photoFromVideo(0);
    t.elapse(1600);
    expect(t.musicGain()).toBe(0.3);
  });

  it('el volumen del vídeo solo se mueve con el vídeo sonando', () => {
    const t = setup();
    t.videoIn(0, null);
    // Aún no empezó a reproducirse: se guarda.
    t.audio.setVideoVolume(0.5);
    t.audio.onShowing();
    t.elapse(400);
    expect(t.videoGain(0)).toBe(0.5);
    t.audio.setVideoVolume(0.2);
    t.elapse(110);
    expect(t.videoGain(0)).toBe(0.2);
  });

  it('cambiar el volumen de la música en mitad de un fundido de vídeo no lanza nada', () => {
    const t = setup({ audioMode: 'both' });
    t.photoIn();
    t.elapse(300);
    t.videoIn(0);
    t.audio.onShowing();
    t.elapse(80);
    for (const v of [0.1, 0.9, 0.5, 0.3, 1, 0]) {
      t.audio.setMusicVolume(v);
      t.audio.setVideoVolume(v);
      t.elapse(23);
    }
    t.elapse(3000);
    expectCleanParams(t.params());
    expect(t.musicGain()).toBe(0);
  });

  it('un volumen no finito se ignora', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.audio.setMusicVolume(Number.NaN);
    t.audio.setVideoVolume(Number.POSITIVE_INFINITY);
    t.elapse(200);
    expect(t.musicGain()).toBe(0.7);
    expect(t.audio.settings.videoVolume).toBe(1);
    expectCleanParams(t.params());
  });
});

describe('pausa, final y salida', () => {
  it('pausar pausa la música; reanudar la reanuda solo si debe sonar', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.audio.setPaused(true);
    expect(t.music.paused).toBe(true);
    expect(t.audio.shouldPlayMusic).toBe(false);
    t.audio.setPaused(false);
    expect(t.music.paused).toBe(false);

    const u = setup();
    u.videoIn(0, null);
    u.elapse(2000);
    u.audio.setPaused(true);
    u.audio.setPaused(false);
    expect(u.music.playCalls).toBe(0);
  });

  it('una diapositiva que entra en pausa no arranca la música hasta reanudar', () => {
    const t = setup();
    t.audio.setPaused(true);
    t.photoIn();
    expect(t.music.playCalls).toBe(0);
    t.audio.setPaused(false);
    expect(t.music.playCalls).toBe(1);
  });

  it('el final sin bucle desvanece la música en musicFadeMs y la pausa', () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    t.audio.onFinished();
    t.elapse(1400);
    expect(t.music.paused).toBe(false);
    t.elapse(110);
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
  });

  it('salir: master baja a 0 en 300 ms y luego se cierra el contexto', async () => {
    const t = setup();
    t.photoIn();
    t.elapse(1600);
    const done = t.audio.stop();
    t.elapse(150);
    expect(t.audio.master.gain.value).toBeGreaterThan(0);
    expect(t.audio.master.gain.value).toBeLessThan(1);
    expect(t.ctx.closed).toBe(false);
    t.elapse(160);
    await done;
    expect(t.audio.master.gain.value).toBe(0);
    expect(t.ctx.closed).toBe(true);
    expect(t.music.paused).toBe(true);
    // Después de cerrar, nada más toca los parámetros.
    const calls = t.params().reduce((n, p) => n + p.calls.length, 0);
    t.audio.setAudioMode('both');
    t.audio.setMusicVolume(0.1);
    t.photoIn();
    expect(t.params().reduce((n, p) => n + p.calls.length, 0)).toBe(calls);
  });

  it('si play() de la música se rechaza (autoplay, pista dañada) lo avisa y sigue', async () => {
    const errors: unknown[] = [];
    const t = setup({}, { onMusicPlayRejected: (e: unknown) => errors.push(e) });
    t.music.play = () => Promise.reject(new Error('NotAllowedError'));
    t.photoIn();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});

describe('conexión con el planificador', () => {
  function integrated(overrides: Partial<AudioSettings> = {}) {
    const t = setup(overrides);
    const slides: SlideSpec[] = [{ kind: 'photo' }, { kind: 'video' }, { kind: 'photo' }];
    const scheduler = new PresentationScheduler(
      slides,
      { transition: 'fade', transitionMs: 500, slideMs: 2000, loop: true },
      { timers: t.clock, rng: () => 0 },
    );
    scheduler.subscribe((e) => {
      if (e.type === 'prepare') scheduler.loaded(e.index);
    });
    // El video i usa el hueco 0 del pool (una sola diapositiva de vídeo).
    bindAudio(scheduler, t.audio, (i) => (slides[i].kind === 'video' ? 0 : null));
    return { ...t, scheduler };
  }

  it('por defecto: suena en la foto, la música baja en el vídeo y vuelve al terminar', () => {
    const t = integrated();
    t.scheduler.start();
    t.elapse(2100); // foto 0 mostrada: música ya en 0,7
    expect(t.musicGain()).toBe(0.7);
    t.elapse(2000); // la foto acaba a 2500 ms: entra el vídeo y la música baja
    t.elapse(1600);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 1, phase: 'showing' });
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
    expect(t.videoGain(0)).toBe(1);
    t.scheduler.ended(1);
    t.elapse(1700);
    expect(t.scheduler.snapshot()).toMatchObject({ index: 2 });
    expect(t.videoGain(0)).toBe(0);
    expect(t.musicGain()).toBe(0.7);
    expect(t.music.paused).toBe(false);
    expectCleanParams(t.params());
  });

  it('pausar y reanudar el planificador pausa y reanuda la música', () => {
    const t = integrated();
    t.scheduler.start();
    t.elapse(1000);
    t.scheduler.pause();
    expect(t.music.paused).toBe(true);
    t.scheduler.resume();
    expect(t.music.paused).toBe(false);
  });

  it('sin bucle, el final desvanece la música', () => {
    const t = setup();
    const scheduler = new PresentationScheduler(
      [{ kind: 'photo' }],
      { transition: 'fade', transitionMs: 500, slideMs: 2000, loop: false },
      { timers: t.clock, rng: () => 0 },
    );
    scheduler.subscribe((e) => {
      if (e.type === 'prepare') scheduler.loaded(e.index);
    });
    bindAudio(scheduler, t.audio, () => null);
    scheduler.start();
    t.elapse(2000);
    expect(t.musicGain()).toBe(0.7);
    t.elapse(600); // fin de la foto (2500 ms): empieza el fundido
    t.elapse(1600);
    expect(scheduler.snapshot().phase).toBe('finished');
    expect(t.musicGain()).toBe(0);
    expect(t.music.paused).toBe(true);
  });

  it('desconectar deja de reaccionar', () => {
    const t = setup();
    const scheduler = new PresentationScheduler([{ kind: 'photo' }], {}, { timers: t.clock });
    scheduler.subscribe((e) => {
      if (e.type === 'prepare') scheduler.loaded(e.index);
    });
    const off = bindAudio(scheduler, t.audio, () => null);
    off();
    scheduler.start();
    expect(t.music.playCalls).toBe(0);
  });
});
