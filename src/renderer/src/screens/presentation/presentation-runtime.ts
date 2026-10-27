// Anfitrión de la presentación (docs/DESIGN.md §17; PLAN.md nota 177): conecta el motor puro
// (planificador, audio, cola de música) con el escenario (capas, pool de <video>, animaciones). No
// importa React: `SlideStage` y `PresentationScreen` lo consumen con `useSyncExternalStore`.
//
// Responsabilidades:
// - eventos del planificador → capas (`prepare` carga, `transition` anima, `showing` reproduce el
//   vídeo, `left` libera, `skipped` avisa, `replay`, `finished`, `failed-all`);
// - el AudioContext({ latencyHint: 'playback' }), el <audio> de música y los 3 <video> del pool,
//   conectados a Web Audio una sola vez (`PresentationAudio`); sin AudioContext, los vídeos suenan
//   por su propio elemento (§17.8);
// - el cambio de pista (`MusicQueue`) cuando una acaba o falla;
// - los ajustes en vivo: la transición y la duración valen desde la diapositiva siguiente; el
//   audio, al momento.
import type { MediaListItem, PresentationSettings } from '@shared/types';
import { testHooksEnabled } from '../../lib/ipc';
import { musicUrl } from '../../lib/vault-url';
import { clearViewerCache, loadDetail } from '../viewer/media-cache';
import {
  audioPlan,
  bindAudio,
  directVideoElementState,
  PresentationAudio,
  type AudioContextLike,
} from './audio-graph';
import { MusicQueue } from './music-queue';
import { audioSettingsOf, schedulerSettingsOf } from './presentation-form-model';
import {
  PresentationScheduler,
  realTimers,
  type SchedulerEvent,
  type SnapshotPhase,
  type Timers,
} from './scheduler';
import { resolveSlide, slideSpecs, type ResolvedSlide } from './slide-source';
import { StageAnimator } from './stage-animator';
import { StageModel, VIDEO_POOL_SIZE } from './stage-model';
import type { Rng } from './transitions';

export const SKIPPED_MESSAGE = 'Se omitió un elemento que no se pudo cargar';
export const ALL_FAILED_MESSAGE = 'No se pudo reproducir ningún elemento';
export const MUSIC_FAILED_MESSAGE = 'No se pudo reproducir la música. Se desactivó.';

export interface RuntimeSnapshot {
  phase: SnapshotPhase;
  index: number | null;
  total: number;
  paused: boolean;
  /** Sin bucle, acabó la última («Fin de la presentación»). */
  finished: boolean;
  /** Algo se está reproduciendo o va a hacerlo (para session:setPlayback, D12). */
  playing: boolean;
}

export interface RuntimeDeps {
  items: readonly MediaListItem[];
  settings: PresentationSettings;
  reducedMotion: boolean;
  /** Todas las diapositivas fallaron (§17.10): hay que salir. */
  onFailedAll(): void;
  /** Toast (la música se desactivó, una diapositiva se omitió). */
  notify(message: string, tone?: 'info' | 'error'): void;
  /** La música se desactivó sola (todas las pistas fallaron): el ajuste del estado también. */
  onMusicDisabled(): void;
  timers?: Timers;
  rng?: Rng;
}

const IDLE_SNAPSHOT: RuntimeSnapshot = {
  phase: 'idle',
  index: null,
  total: 0,
  paused: false,
  finished: false,
  playing: false,
};

export class PresentationRuntime {
  readonly model: StageModel;
  readonly animator = new StageAnimator();
  readonly pool: HTMLVideoElement[] = [];
  readonly musicEl: HTMLAudioElement;

  private settings: PresentationSettings;
  private scheduler: PresentationScheduler | null = null;
  private audio: PresentationAudio | null = null;
  private ctx: AudioContext | null = null;
  private queue: MusicQueue;
  private readonly listeners = new Set<() => void>();
  private snapshot: RuntimeSnapshot = IDLE_SNAPSHOT;
  private unsubs: Array<() => void> = [];
  private started = false;
  private disposed = false;
  private finished = false;
  private musicDisabledByFailure = false;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timers: Timers;

  constructor(private readonly deps: RuntimeDeps) {
    this.timers = deps.timers ?? realTimers;
    this.settings = deps.settings;
    this.model = new StageModel(deps.items);
    this.queue = new MusicQueue(deps.settings.trackIds);
    // Elementos creados al empezar y conectados a Web Audio una sola vez (§17.5).
    this.musicEl = document.createElement('audio');
    this.musicEl.crossOrigin = 'anonymous';
    this.musicEl.preload = 'auto';
    for (let i = 0; i < VIDEO_POOL_SIZE; i += 1) this.pool.push(this.makeVideo());
  }

  // ---- Almacén para la interfaz ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  private publish(): void {
    const s = this.scheduler?.snapshot();
    if (!s) return;
    const next: RuntimeSnapshot = {
      phase: s.phase,
      index: s.index,
      total: s.total,
      paused: s.paused,
      finished: this.finished,
      playing:
        !s.paused &&
        !this.finished &&
        (s.phase === 'entering' || s.phase === 'showing' || s.phase === 'preparing'),
    };
    const prev = this.snapshot;
    if (
      prev.phase === next.phase &&
      prev.index === next.index &&
      prev.total === next.total &&
      prev.paused === next.paused &&
      prev.finished === next.finished &&
      prev.playing === next.playing
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  // ---- Ciclo de vida ----

  start(): void {
    if (this.disposeTimer !== null) {
      globalThis.clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    if (this.started || this.disposed) return;
    this.started = true;
    this.setupAudio();
    const scheduler = new PresentationScheduler(
      slideSpecs(this.deps.items),
      schedulerSettingsOf(this.settings, this.deps.reducedMotion),
      { timers: this.timers, rng: this.deps.rng },
    );
    this.scheduler = scheduler;
    this.unsubs.push(scheduler.subscribe((e) => this.onEvent(e)));
    if (this.audio) {
      this.unsubs.push(bindAudio(scheduler, this.audio, (i) => this.model.slotOf(i)));
    }
    this.snapshot = { ...IDLE_SNAPSHOT, total: this.deps.items.length };
    scheduler.start(0);
    this.publish();
  }

  /**
   * Libera dentro de un instante: si la pantalla vuelve a llamar a `start()` antes (el doble montaje
   * de StrictMode en desarrollo), se cancela.
   */
  scheduleDispose(): void {
    if (this.disposeTimer !== null) return;
    this.disposeTimer = globalThis.setTimeout(() => this.dispose(), 0);
  }

  /** Suelta todo: planificador, animaciones, audio (con el fundido de 300 ms) y el pool. */
  dispose(): void {
    if (this.disposeTimer !== null) {
      globalThis.clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler?.destroy();
    this.scheduler = null;
    for (const off of this.unsubs.splice(0)) off();
    this.animator.dispose();
    const audio = this.audio;
    const release = (): void => {
      this.musicEl.pause();
      this.musicEl.removeAttribute('src');
      this.musicEl.load();
      for (const v of this.pool) this.resetVideo(v);
    };
    if (audio) void audio.stop().then(release, release);
    else release();
    this.model.clear();
    clearViewerCache();
    this.listeners.clear();
  }

  private makeVideo(): HTMLVideoElement {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.disableRemotePlayback = true;
    v.setAttribute('controlslist', 'nodownload noremoteplayback');
    v.className = 'size-full object-contain';
    return v;
  }

  private resetVideo(v: HTMLVideoElement): void {
    v.pause();
    v.removeAttribute('src');
    v.removeAttribute('poster');
    v.load();
    v.remove();
  }

  // ---- Audio ----

  private setupAudio(): void {
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ latencyHint: 'playback' });
    } catch {
      ctx = null; // sin AudioContext: la presentación sigue sin música (§17.8)
    }
    this.ctx = ctx;
    if (!ctx) {
      this.applyDirectVideoState();
      return;
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const first = this.queue.current();
    if (first) this.musicEl.src = musicUrl(first);
    this.audio = new PresentationAudio(
      ctx as unknown as AudioContextLike,
      this.musicEl,
      this.pool,
      audioSettingsOf(this.settings),
      this.timers,
    );
    this.musicEl.addEventListener('ended', this.onMusicEnded);
    this.musicEl.addEventListener('error', this.onMusicError);
  }

  private onMusicEnded = (): void => {
    const next = this.queue.advance();
    if (next === null) return;
    // Una sola pista: vuelve a empezar sin recargarla.
    if (this.musicEl.getAttribute('src') === musicUrl(next)) this.musicEl.currentTime = 0;
    else this.musicEl.src = musicUrl(next);
    if (this.audio?.shouldPlayMusic) void this.musicEl.play().catch(() => undefined);
  };

  private onMusicError = (): void => {
    if (!this.musicEl.getAttribute('src')) return; // el error de quitar el src al salir
    const next = this.queue.fail();
    if (next === null) {
      if (!this.musicDisabledByFailure && this.settings.musicEnabled) {
        this.musicDisabledByFailure = true;
        this.audio?.setMusicEnabled(false);
        this.deps.onMusicDisabled();
        this.deps.notify(MUSIC_FAILED_MESSAGE, 'error');
      }
      return;
    }
    this.musicEl.src = musicUrl(next);
    if (this.audio?.shouldPlayMusic) void this.musicEl.play().catch(() => undefined);
  };

  /** Sin AudioContext, el vídeo suena desde su propio elemento (§17.8). */
  private applyDirectVideoState(): void {
    if (this.ctx) return;
    const { muted, volume } = directVideoElementState(
      this.settings.audioMode,
      this.settings.videoVolume,
    );
    for (const v of this.pool) {
      v.muted = muted;
      v.volume = volume;
    }
  }

  /** Ajustes en vivo: la transición y la duración desde la diapositiva siguiente; el audio ya. */
  applySettings(next: PresentationSettings): void {
    if (this.disposed) return;
    const prev = this.settings;
    this.settings = next;
    this.scheduler?.updateSettings(schedulerSettingsOf(next, this.deps.reducedMotion));
    const audio = this.audio;
    if (audio) {
      if (prev.audioMode !== next.audioMode) audio.setAudioMode(next.audioMode);
      if (prev.musicFadeMs !== next.musicFadeMs) audio.setMusicFadeMs(next.musicFadeMs);
      if (prev.musicVolume !== next.musicVolume) audio.setMusicVolume(next.musicVolume);
      if (prev.videoVolume !== next.videoVolume) audio.setVideoVolume(next.videoVolume);
      if (prev.musicEnabled !== next.musicEnabled) {
        if (next.musicEnabled) this.musicDisabledByFailure = false;
        audio.setMusicEnabled(next.musicEnabled);
      }
    } else {
      this.applyDirectVideoState();
    }
    if (prev.trackIds.join() !== next.trackIds.join()) this.queue.setTracks(next.trackIds);
  }

  // ---- Órdenes ----

  togglePause(): void {
    if (this.snapshot.finished) return;
    this.scheduler?.togglePause();
  }

  /** Siguiente a mano. Devuelve la diapositiva de destino, o null si no hay (borde sin bucle…). */
  next(): number | null {
    return this.navigate('next');
  }

  prev(): number | null {
    return this.navigate('prev');
  }

  private navigate(dir: 'next' | 'prev'): number | null {
    const scheduler = this.scheduler;
    if (!scheduler) return null;
    const moved = dir === 'next' ? scheduler.next() : scheduler.prev();
    if (!moved) return null;
    const s = scheduler.snapshot();
    return s.pendingIndex ?? s.index;
  }

  restart(): void {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    this.finished = false;
    this.animator.setPaused(false);
    this.animator.dispose();
    this.model.clear();
    scheduler.restart();
    this.publish();
  }

  // ---- Eventos de las capas (los llama `SlideStage`) ----

  /** La foto está decodificada. */
  photoReady(index: number): void {
    this.markReady(index);
  }

  /** La foto no se pudo cargar. */
  photoFailed(index: number): void {
    if (this.model.has(index)) this.scheduler?.failed(index);
  }

  /** El vídeo puede reproducirse (`canplay`). */
  videoReady(index: number): void {
    this.markReady(index);
  }

  videoFailed(index: number): void {
    if (this.model.has(index)) this.scheduler?.failed(index);
  }

  videoEnded(index: number): void {
    this.scheduler?.ended(index);
  }

  private markReady(index: number): void {
    const entry = this.model.get(index);
    if (!entry || entry.ready) return;
    this.model.patch(index, { ready: true });
    this.scheduler?.loaded(index);
  }

  // ---- Planificador → capas ----

  private onEvent(e: SchedulerEvent): void {
    switch (e.type) {
      case 'prepare':
        this.prepare(e.index);
        break;
      case 'transition':
        this.model.patch(e.to, { role: 'entering' });
        if (e.from !== null) this.model.patch(e.from, { role: 'leaving' });
        this.animator.transition({ from: e.from, to: e.to, plan: e.plan });
        break;
      case 'showing':
        this.model.patch(e.index, { role: 'current' });
        if (e.kind === 'video' && !this.scheduler?.snapshot().paused) this.playVideo(e.index);
        break;
      case 'left':
        this.animator.stop(e.index);
        this.model.remove(e.index);
        break;
      case 'skipped': {
        const entry = this.model.get(e.index);
        if (entry && entry.role === 'preload') this.model.remove(e.index);
        this.deps.notify(SKIPPED_MESSAGE);
        break;
      }
      case 'replay':
        this.replayVideo(e.index);
        break;
      case 'paused':
        this.animator.setPaused(true);
        this.pauseVideos();
        break;
      case 'resumed': {
        this.animator.setPaused(false);
        const s = this.scheduler?.snapshot();
        if (s && s.phase === 'showing' && s.index !== null) this.playVideo(s.index);
        break;
      }
      case 'finished':
        this.finished = true;
        break;
      case 'failed-all':
        this.deps.notify(ALL_FAILED_MESSAGE, 'error');
        this.deps.onFailedAll();
        break;
    }
    this.publish();
  }

  /** Carga la diapositiva (idempotente): foto → media:get + decode(); vídeo → hueco del pool + canplay. */
  private prepare(index: number): void {
    const existing = this.model.get(index);
    if (existing) {
      if (existing.ready) this.scheduler?.loaded(index);
      return;
    }
    const item = this.deps.items[index];
    if (!item) return;
    if (item.kind === 'video') {
      const entry = this.model.add(index, resolveSlide(item, null));
      if (!entry) this.scheduler?.failed(index);
      return;
    }
    if (!this.model.add(index, null)) return;
    void loadDetail(item.id).then((detail) => {
      const entry = this.model.get(index);
      if (!entry || entry.slide) return;
      this.model.patch(index, { slide: resolveSlide(item, detail?.edits ?? null) });
    });
  }

  private videoOf(index: number): HTMLVideoElement | null {
    const slot = this.model.slotOf(index);
    return slot === null ? null : (this.pool[slot] ?? null);
  }

  /**
   * Coloca el <video> del hueco en la capa (`host`) y empieza a cargarlo (`preload="auto"`, póster
   * = miniatura). Devuelve la función que lo libera con pause(), removeAttribute('src') y load()
   * (§17.5): el elemento sigue conectado a Web Audio para el siguiente vídeo.
   */
  attachVideo(
    index: number,
    slot: number,
    slide: Pick<ResolvedSlide, 'posterUrl' | 'mediaUrl'>,
    host: HTMLElement,
  ): () => void {
    const video = this.pool[slot];
    if (!video) return () => undefined;
    const ready = (): void => this.videoReady(index);
    const ended = (): void => this.videoEnded(index);
    const failed = (): void => this.videoFailed(index);
    video.addEventListener('canplay', ready, { once: true });
    video.addEventListener('ended', ended);
    video.addEventListener('error', failed);
    video.poster = slide.posterUrl;
    video.src = slide.mediaUrl;
    video.load();
    host.appendChild(video);
    return () => {
      video.removeEventListener('canplay', ready);
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', failed);
      this.resetVideo(video);
    };
  }

  private playVideo(index: number): void {
    const v = this.videoOf(index);
    if (!v || this.deps.items[index]?.kind !== 'video') return;
    void v.play().catch((error: unknown) => {
      // Pausar o cambiar de diapositiva cancela el play(): no es un fallo.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.scheduler?.failed(index);
    });
  }

  private replayVideo(index: number): void {
    const v = this.videoOf(index);
    if (!v) return;
    v.currentTime = 0;
    this.playVideo(index);
  }

  private pauseVideos(): void {
    for (const v of this.pool) if (!v.paused) v.pause();
  }

  // ---- Estado para los tests (solo sin empaquetar, §23.2) ----

  /** Estado del audio y de las capas, sin datos de la bóveda. Solo con los ganchos de prueba. */
  testState(): Record<string, unknown> | null {
    if (!testHooksEnabled()) return null;
    const snap = this.scheduler?.snapshot() ?? null;
    const item = snap && snap.index !== null ? this.deps.items[snap.index] : undefined;
    const plan = item
      ? audioPlan(this.settings.audioMode, item.kind, this.settings.musicEnabled)
      : null;
    return {
      phase: snap?.phase ?? 'idle',
      slideIndex: snap?.index ?? null,
      total: this.deps.items.length,
      paused: snap?.paused ?? false,
      finished: this.finished,
      slideKind: item?.kind ?? null,
      audio: this.audio ? 'webaudio' : 'direct',
      audioContext: this.ctx?.state ?? 'none',
      audioMode: this.settings.audioMode,
      musicEnabled: this.settings.musicEnabled,
      musicVolume: this.settings.musicVolume,
      videoVolume: this.settings.videoVolume,
      musicFadeMs: this.settings.musicFadeMs,
      transitionSetting: this.settings.transition,
      transitionMs: this.settings.transitionMs,
      slideMs: this.settings.slideMs,
      loop: this.settings.loop,
      animations: this.settings.animations,
      plan,
      musicTarget: plan ? (plan.music === 'sound' ? this.settings.musicVolume : 0) : null,
      videoTarget: plan ? (plan.videoAudio === 'sound' ? this.settings.videoVolume : 0) : null,
      musicGain: this.audio?.musicGainValue ?? null,
      videoGains: this.pool.map((_, slot) => this.audio?.videoGainValue(slot) ?? null),
      trackId: this.queue.current(),
      musicPaused: this.musicEl.paused,
      musicTime: this.musicEl.currentTime,
      videoPlaying: this.pool.map((v) => !v.paused),
      transition: this.animator.last,
      layers: this.model.getSnapshot().map((l) => ({
        index: l.index,
        role: l.role,
        ready: l.ready,
        slot: l.slot,
      })),
    };
  }
}
