// Audio de la presentación (docs/DESIGN.md §17.8): decisión por diapositiva (`audioPlan`), fundidos
// (`fadeTo`) y el grafo de Web Audio con sus ganancias. Sin React ni DOM: el AudioContext, los
// elementos y los temporizadores se inyectan (los tests usan un AudioParam falso; Node no tiene
// Web Audio).
//
// Reglas del diseño que este archivo hace cumplir:
// - Todo cambio de ganancia pasa por `fadeTo` (cancelAndHoldAtTime + rampas lineales). Los tipos
//   `AudioParamLike` ni siquiera declaran `setValueCurveAtTime`: usarlo no compila.
// - Los valores inválidos (NaN, infinitos, negativos) nunca llegan a una rampa: un
//   `linearRampToValueAtTime(NaN, …)` lanzaría y rompería el control.
import type { AudioMode, MediaKind } from '@shared/types';
import type { PresentationScheduler, Timers } from './scheduler';

export const FADE_STEPS = 32;
/** Por debajo de 1 ms un fundido es un salto: los tiempos de las rampas no serían crecientes. */
export const MIN_FADE_MS = 1;
/** Sube/baja el audio de un vídeo (§17.8). */
export const VIDEO_FADE_MS = 300;
/** Cambio de volumen del usuario (§17.8). */
export const USER_VOLUME_FADE_MS = 100;
/** Salir: `master` baja a 0 y luego `ctx.close()`. */
export const MASTER_FADE_MS = 300;

// ---- Tipos mínimos de Web Audio (los reales los cumplen) ----

export interface AudioParamLike {
  readonly value: number;
  cancelAndHoldAtTime(cancelTime: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
}

export interface GainNodeLike {
  readonly gain: AudioParamLike;
  connect(destination: unknown): unknown;
}

export interface MediaElementLike {
  play(): Promise<void> | void;
  pause(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): GainNodeLike;
  createMediaElementSource(element: MediaElementLike): { connect(destination: unknown): unknown };
  close(): Promise<void>;
}

// ---- Fundidos ----

/**
 * Lleva `p` a `target` en `ms` con una curva de potencia constante aproximada por 32 rampas
 * lineales (§17.8). Empieza con `cancelAndHoldAtTime`, así que corta limpiamente un fundido en
 * curso. Un `target` inválido se ignora; un `ms` inválido o menor de 1 es un salto.
 */
export function fadeTo(
  ctx: { readonly currentTime: number },
  p: AudioParamLike,
  target: number,
  ms: number,
): void {
  if (!Number.isFinite(target)) return;
  const t0 = ctx.currentTime;
  if (!Number.isFinite(t0) || t0 < 0) return;
  const to = Math.min(1, Math.max(0, target));
  p.cancelAndHoldAtTime(t0);
  const from = p.value;
  if (!Number.isFinite(from) || !Number.isFinite(ms) || ms < MIN_FADE_MS || from === to) {
    p.setValueAtTime(to, t0);
    return;
  }
  const up = to > from;
  for (let k = 1; k <= FADE_STEPS; k += 1) {
    const u = k / FADE_STEPS;
    let g: number;
    if (k === FADE_STEPS) g = to;
    else if (up) g = from + (to - from) * Math.sin((u * Math.PI) / 2);
    else g = to + (from - to) * Math.cos((u * Math.PI) / 2);
    p.linearRampToValueAtTime(g, t0 + (u * ms) / 1000);
  }
}

// ---- Decisión de audio por diapositiva ----

export interface AudioPlan {
  /** `silent` = se desvanece a 0 y se pausa el elemento; `sound` = se reanuda y sube. */
  music: 'sound' | 'silent';
  /** El audio del propio vídeo (solo cuenta en una diapositiva de vídeo). */
  videoAudio: 'sound' | 'silent';
}

/**
 * Tabla de §17.8. `mode` es lo que suena DURANTE los vídeos; en las fotos suena la música si
 * `musicEnabled`. Con `musicEnabled = false` la música está en silencio siempre.
 */
export function audioPlan(mode: AudioMode, kind: MediaKind, musicEnabled = true): AudioPlan {
  const music = (on: boolean): 'sound' | 'silent' => (on && musicEnabled ? 'sound' : 'silent');
  if (kind === 'photo') return { music: music(true), videoAudio: 'silent' };
  switch (mode) {
    case 'video':
      return { music: 'silent', videoAudio: 'sound' };
    case 'music':
      return { music: music(true), videoAudio: 'silent' };
    case 'both':
      return { music: music(true), videoAudio: 'sound' };
    case 'mute':
      return { music: 'silent', videoAudio: 'silent' };
  }
}

/** Las dos piezas que el usuario ve juntas: «Silenciar vídeos» y qué pasa con la música (D16). */
export interface VideoAudioChoice {
  /** false = «Silencio en los vídeos». */
  videoAudio: boolean;
  /** La música sigue sonando durante los vídeos. */
  musicDuringVideo: boolean;
}

export function choiceOfMode(mode: AudioMode): VideoAudioChoice {
  return {
    videoAudio: mode === 'video' || mode === 'both',
    musicDuringVideo: mode === 'music' || mode === 'both',
  };
}

export function modeOfChoice(c: VideoAudioChoice): AudioMode {
  if (c.videoAudio) return c.musicDuringVideo ? 'both' : 'video';
  return c.musicDuringVideo ? 'music' : 'mute';
}

/**
 * Sin AudioContext (§17.8): el vídeo suena directamente desde su elemento. `muted` según el modo
 * y `volume = videoVolume`; no hay música.
 */
export function directVideoElementState(
  mode: AudioMode,
  videoVolume: number,
): { muted: boolean; volume: number } {
  const v = Number.isFinite(videoVolume) ? Math.min(1, Math.max(0, videoVolume)) : 1;
  return { muted: !choiceOfMode(mode).videoAudio, volume: v };
}

// ---- Grafo ----

export interface AudioSettings {
  audioMode: AudioMode;
  musicEnabled: boolean;
  musicVolume: number;
  videoVolume: number;
  musicFadeMs: number;
}

export interface AudioTransitionInfo {
  fromKind: MediaKind | null;
  /** Hueco del pool de vídeos de la saliente (null si no es un vídeo). */
  fromSlot: number | null;
  toKind: MediaKind;
  toSlot: number | null;
  /** Duración D de la transición (0 = corte). */
  durationMs: number;
}

export interface PresentationAudioHooks {
  /** `play()` de la música fue rechazado (autoplay, pista dañada…). */
  onMusicPlayRejected?: (error: unknown) => void;
}

function clamp01(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * AudioContext({ latencyHint: 'playback' }) con un <audio> de música y el pool de <video>, cada
 * uno conectado UNA vez: elemento → MediaElementSource → ganancia → master → destino.
 */
export class PresentationAudio {
  readonly master: GainNodeLike;
  readonly musicGain: GainNodeLike;
  readonly videoGains: readonly GainNodeLike[];

  private readonly s: AudioSettings;
  private slide: { kind: MediaKind; slot: number | null; showing: boolean } | null = null;
  private musicWanted = false;
  private paused = false;
  private closed = false;
  private musicPauseTimer: unknown = null;

  constructor(
    private readonly ctx: AudioContextLike,
    private readonly musicEl: MediaElementLike,
    videoEls: readonly MediaElementLike[],
    settings: AudioSettings,
    private readonly timers: Timers,
    private readonly hooks: PresentationAudioHooks = {},
  ) {
    this.s = {
      audioMode: settings.audioMode,
      musicEnabled: settings.musicEnabled,
      musicVolume: clamp01(settings.musicVolume, 0.7),
      videoVolume: clamp01(settings.videoVolume, 1),
      musicFadeMs: Math.min(
        5000,
        Math.max(0, Number.isFinite(settings.musicFadeMs) ? settings.musicFadeMs : 0),
      ),
    };
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.musicGain = ctx.createGain();
    ctx.createMediaElementSource(musicEl).connect(this.musicGain);
    this.musicGain.connect(this.master);
    this.videoGains = videoEls.map((el) => {
      const gain = ctx.createGain();
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.master);
      return gain;
    });
    // Todo arranca en silencio (master a 1); la música sube con la primera diapositiva.
    fadeTo(ctx, this.master.gain, 1, 0);
    fadeTo(ctx, this.musicGain.gain, 0, 0);
    for (const g of this.videoGains) fadeTo(ctx, g.gain, 0, 0);
  }

  get settings(): Readonly<AudioSettings> {
    return this.s;
  }

  /** ¿Debe sonar la música ahora? (para que el anfitrión la reanude al cambiar de pista). */
  get shouldPlayMusic(): boolean {
    return this.musicWanted && !this.paused && !this.closed;
  }

  /** Ganancia real de la música (`data-music-gain`, solo sin empaquetar). */
  get musicGainValue(): number {
    return this.musicGain.gain.value;
  }

  videoGainValue(slot: number): number {
    return this.videoGains[slot]?.gain.value ?? 0;
  }

  // ---- Eventos de la presentación ----

  /** Empieza la entrada de una diapositiva (el audio del vídeo espera a `onShowing`). */
  onTransition(info: AudioTransitionInfo): void {
    if (this.closed) return;
    if (info.fromKind === 'video' && info.fromSlot !== null) {
      this.fadeVideo(info.fromSlot, 0, Math.min(VIDEO_FADE_MS, Math.max(0, info.durationMs)));
    }
    this.slide = {
      kind: info.toKind,
      slot: info.toKind === 'video' ? info.toSlot : null,
      showing: false,
    };
    this.applyMusic();
  }

  /** Termina la entrada: el vídeo empieza a reproducirse y su audio sube en 300 ms. */
  onShowing(): void {
    if (this.closed || !this.slide) return;
    this.slide.showing = true;
    this.applyVideo();
  }

  /** Sin bucle, acabó la última: la música se desvanece en `musicFadeMs` y se pausa. */
  onFinished(): void {
    if (this.closed) return;
    const slide = this.slide;
    if (slide?.kind === 'video' && slide.slot !== null)
      this.fadeVideo(slide.slot, 0, VIDEO_FADE_MS);
    this.slide = null;
    this.silenceMusic(this.s.musicFadeMs);
  }

  /** Pausa/reanuda los elementos de música (el de vídeo es del anfitrión). */
  setPaused(paused: boolean): void {
    if (this.closed || this.paused === paused) return;
    this.paused = paused;
    if (paused) this.musicEl.pause();
    else if (this.musicWanted) this.playMusic();
  }

  // ---- Ajustes en vivo («los de audio, al momento») ----

  setAudioMode(mode: AudioMode): void {
    this.s.audioMode = mode;
    this.refresh();
  }

  setMusicEnabled(enabled: boolean): void {
    this.s.musicEnabled = enabled;
    this.refresh();
  }

  setMusicFadeMs(ms: number): void {
    if (Number.isFinite(ms)) this.s.musicFadeMs = Math.min(5000, Math.max(0, ms));
  }

  /** Solo se hace un fundido de 100 ms si esa ganancia tiene que estar sonando ahora (§17.8). */
  setMusicVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.s.musicVolume = clamp01(volume, this.s.musicVolume);
    if (this.closed || this.plan()?.music !== 'sound') return;
    fadeTo(this.ctx, this.musicGain.gain, this.s.musicVolume, USER_VOLUME_FADE_MS);
  }

  setVideoVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.s.videoVolume = clamp01(volume, this.s.videoVolume);
    if (this.closed) return;
    const slot = this.soundingVideoSlot();
    if (slot !== null) this.fadeVideo(slot, this.s.videoVolume, USER_VOLUME_FADE_MS);
  }

  /** Salir: `master` baja a 0 en 300 ms y luego `ctx.close()`. */
  stop(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.cancelMusicPause();
    fadeTo(this.ctx, this.master.gain, 0, MASTER_FADE_MS);
    return new Promise<void>((resolve) => {
      this.timers.setTimeout(() => {
        this.musicEl.pause();
        this.ctx.close().then(resolve, resolve);
      }, MASTER_FADE_MS);
    });
  }

  // ---- Internos ----

  private plan(): AudioPlan | null {
    return this.slide ? audioPlan(this.s.audioMode, this.slide.kind, this.s.musicEnabled) : null;
  }

  private soundingVideoSlot(): number | null {
    const slide = this.slide;
    if (!slide || slide.kind !== 'video' || slide.slot === null || !slide.showing) return null;
    return this.plan()?.videoAudio === 'sound' ? slide.slot : null;
  }

  private refresh(): void {
    if (this.closed) return;
    this.applyMusic();
    this.applyVideo();
  }

  private fadeVideo(slot: number, target: number, ms: number): void {
    const gain = this.videoGains[slot];
    if (gain) fadeTo(this.ctx, gain.gain, target, ms);
  }

  private applyVideo(): void {
    const slide = this.slide;
    if (!slide || slide.kind !== 'video' || slide.slot === null) return;
    const sounds = this.soundingVideoSlot() !== null;
    this.fadeVideo(slide.slot, sounds ? this.s.videoVolume : 0, VIDEO_FADE_MS);
  }

  private applyMusic(): void {
    const plan = this.plan();
    if (!plan) return;
    if (plan.music === 'sound') {
      this.cancelMusicPause();
      this.musicWanted = true;
      if (!this.paused) this.playMusic();
      fadeTo(this.ctx, this.musicGain.gain, this.s.musicVolume, this.s.musicFadeMs);
    } else {
      this.silenceMusic(this.s.musicFadeMs);
    }
  }

  private silenceMusic(fadeMs: number): void {
    this.musicWanted = false;
    this.cancelMusicPause();
    fadeTo(this.ctx, this.musicGain.gain, 0, fadeMs);
    if (fadeMs < MIN_FADE_MS) {
      this.musicEl.pause();
      return;
    }
    this.musicPauseTimer = this.timers.setTimeout(() => {
      this.musicPauseTimer = null;
      if (!this.musicWanted) this.musicEl.pause();
    }, fadeMs);
  }

  private cancelMusicPause(): void {
    if (this.musicPauseTimer === null) return;
    this.timers.clearTimeout(this.musicPauseTimer);
    this.musicPauseTimer = null;
  }

  private playMusic(): void {
    try {
      const result = this.musicEl.play();
      if (result && typeof result.then === 'function') {
        result.catch((error: unknown) => this.hooks.onMusicPlayRejected?.(error));
      }
    } catch (error) {
      this.hooks.onMusicPlayRejected?.(error);
    }
  }
}

/**
 * Conecta el planificador con el audio: lo que `PresentationScreen` necesita para el audio.
 * `slotOf(index)` da el hueco del pool de vídeos de una diapositiva de vídeo. Devuelve la función
 * que desconecta.
 */
export function bindAudio(
  scheduler: Pick<PresentationScheduler, 'subscribe'>,
  audio: PresentationAudio,
  slotOf: (index: number) => number | null,
): () => void {
  return scheduler.subscribe((e) => {
    switch (e.type) {
      case 'transition':
        audio.onTransition({
          fromKind: e.fromKind,
          fromSlot: e.from === null ? null : slotOf(e.from),
          toKind: e.toKind,
          toSlot: slotOf(e.to),
          durationMs: e.plan.durationMs,
        });
        return;
      case 'showing':
        audio.onShowing();
        return;
      case 'paused':
        audio.setPaused(true);
        return;
      case 'resumed':
        audio.setPaused(false);
        return;
      case 'finished':
        audio.onFinished();
        return;
      default:
        return;
    }
  });
}
