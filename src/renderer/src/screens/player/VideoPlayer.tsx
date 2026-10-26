// Reproductor de vídeo del visor (docs/DESIGN.md §16.6): un <video> sin controles nativos que lee
// `vault://media/<id>` (descifrado al vuelo, con Range: buscar es pedir otro rango) y los controles
// de PlayerControls. El contenido del vídeo no depende del tema; solo los controles.
//
// Teclado (lo reparte Viewer a `handleKey`, porque el foco suele estar en el diálogo): Espacio/K
// reproduce o pausa, J/L y Mayús+←/→ saltan 10 s, ↑/↓ el volumen, M silencio, R bucle y Mayús+, /
// Mayús+. la velocidad; F (pantalla completa) y ←/→ (anterior/siguiente) los resuelve Viewer. Los
// controles se ocultan a los 2,5 s sin movimiento mientras suena y siguen visibles con el foco dentro.
//
// Mientras suena, `player-store` envía session:setPlayback { active: true } (pausa del auto-bloqueo,
// powerSaveBlocker) y pausa los fondos animados.
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useIsPresent } from 'motion/react';
import type { Id } from '@shared/types';
import { announce } from '../../lib/announce';
import { cx } from '../../lib/cx';
import { mediaUrl } from '../../lib/vault-url';
import {
  setPlayerMuted,
  setPlayerPlaying,
  setPlayerSpeed,
  setPlayerVolume,
  usePlayerStore,
} from '../../stores/player-store';
import { PlayerControls } from './PlayerControls';
import {
  bufferedSegments,
  clamp,
  CONTROLS_HIDE_MS,
  controlsVisible,
  effectiveDuration,
  formatSpeed,
  SEEK_STEP_S,
  seekTime,
  stepSpeed,
  stepVolume,
  videoErrorMessage,
  type BufferedSegment,
} from './player-math';

export interface PlayerHandle {
  /** Atajo del reproductor. Devuelve true si lo ha resuelto (el visor no debe hacer nada más). */
  handleKey(e: KeyboardEvent): boolean;
}

export interface VideoPlayerProps {
  id: Id;
  /** Duración de la DB (ms), por si `video.duration` no es finita (§18.4). */
  durationMs: number | null;
  fullscreen: boolean;
  onToggleFullscreen(): void;
  /** Hay un primer fotograma: el visor puede quitar el póster. */
  onReady(): void;
  ref?: Ref<PlayerHandle>;
}

function bufferedOf(video: HTMLVideoElement): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < video.buffered.length; i += 1) {
    out.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
  }
  return out;
}

export function VideoPlayer({
  id,
  durationMs,
  fullscreen,
  onToggleFullscreen,
  onReady,
  ref,
}: VideoPlayerProps) {
  const playerId = useId();
  const present = useIsPresent();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const speed = usePlayerStore((s) => s.speed);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(() => effectiveDuration(Number.NaN, durationMs));
  const [buffered, setBuffered] = useState<BufferedSegment[]>([]);
  const [loop, setLoop] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentActivity, setRecentActivity] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const visible = controlsVisible({
    playing,
    recentActivity,
    focusWithin,
    hovering,
    menuOpen,
    error: error !== null,
  });

  // Controles visibles 2,5 s desde el último movimiento o tecla.
  const bump = (): void => {
    setRecentActivity(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setRecentActivity(false), CONTROLS_HIDE_MS);
  };
  // Al montar, los controles empiezan visibles (`recentActivity` arranca en true) y se ocultan a los 2,5 s.
  useEffect(() => {
    hideTimer.current = setTimeout(() => setRecentActivity(false), CONTROLS_HIDE_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // Volumen, silencio, velocidad (con el tono conservado) y bucle van al elemento.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.preservesPitch = true;
    v.defaultPlaybackRate = speed;
    v.playbackRate = speed;
  }, [speed]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.loop = loop;
  }, [loop]);

  // Reproducción activa → main (auto-bloqueo, powerSaveBlocker) y fondos animados. Un error del medio
  // no cambia `paused` ni dispara `pause`, así que con un error ya no cuenta como reproducción.
  const hasError = error !== null;
  useEffect(() => {
    setPlayerPlaying(playerId, playing && !hasError);
  }, [playerId, playing, hasError]);
  useEffect(() => () => setPlayerPlaying(playerId, false), [playerId]);

  // Un vídeo que sale por la navegación (fundido cruzado) deja de sonar enseguida.
  useEffect(() => {
    if (!present) videoRef.current?.pause();
  }, [present]);

  const syncState = (): void => {
    const v = videoRef.current;
    if (v) setPlaying(!v.paused && !v.ended);
  };
  const syncDuration = (): void => {
    const v = videoRef.current;
    if (v) setDuration(effectiveDuration(v.duration, durationMs));
  };

  const togglePlay = (): void => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => undefined);
    else v.pause();
  };

  const seekTo = (target: number): void => {
    const v = videoRef.current;
    if (!v) return;
    const limit = effectiveDuration(v.duration, durationMs);
    v.currentTime = limit > 0 ? clamp(target, 0, limit) : Math.max(0, target);
    setTime(v.currentTime);
  };
  const seekBy = (delta: number): void => {
    const v = videoRef.current;
    if (!v) return;
    seekTo(seekTime(v.currentTime, delta, effectiveDuration(v.duration, durationMs)));
  };

  const changeVolume = (next: number): void => {
    setPlayerVolume(next);
    if (next > 0 && muted) setPlayerMuted(false);
    announce(`Volumen ${Math.round(clamp(next, 0, 1) * 100)} %`);
  };
  const toggleMute = (): void => {
    setPlayerMuted(!muted);
    announce(muted ? 'Sonido activado' : 'Silenciado');
  };
  const changeSpeed = (next: number): void => {
    setPlayerSpeed(next);
    announce(`Velocidad ${formatSpeed(next)}`);
  };
  const toggleLoop = (): void => {
    setLoop(!loop);
    announce(loop ? 'Bucle desactivado' : 'Bucle activado');
  };

  useImperativeHandle(ref, () => ({
    handleKey: (e) => {
      bump();
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      const target = e.target instanceof Element ? e.target : null;
      // Los menús (velocidad) resuelven sus propias teclas.
      if (target?.closest('[role="menu"]')) return false;
      const onButton = target?.closest('button') != null;
      const insidePlayer =
        target !== null &&
        (target.closest('[data-player]') !== null || target.hasAttribute('data-viewer'));
      switch (e.key) {
        case ' ':
          if (onButton) return false; // el botón enfocado se activa solo
          togglePlay();
          return true;
        case 'k':
        case 'K':
          togglePlay();
          return true;
        case 'j':
        case 'J':
          seekBy(-SEEK_STEP_S);
          return true;
        case 'l':
        case 'L':
          seekBy(SEEK_STEP_S);
          return true;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (!e.shiftKey) return false; // anterior/siguiente: lo resuelve el visor
          seekBy(e.key === 'ArrowRight' ? SEEK_STEP_S : -SEEK_STEP_S);
          return true;
        case 'ArrowUp':
        case 'ArrowDown':
          if (!insidePlayer) return false;
          changeVolume(stepVolume(muted ? 0 : volume, e.key === 'ArrowUp' ? 1 : -1));
          return true;
        case 'm':
        case 'M':
          toggleMute();
          return true;
        case 'r':
        case 'R':
          toggleLoop();
          return true;
        default:
          break;
      }
      if (e.shiftKey && (e.code === 'Comma' || e.code === 'Period')) {
        changeSpeed(stepSpeed(speed, e.code === 'Period' ? 1 : -1));
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      data-player=""
      data-playing={playing ? 'true' : 'false'}
      data-current-time={time.toFixed(2)}
      data-duration={duration.toFixed(2)}
      data-speed={speed}
      data-loop={loop ? 'true' : 'false'}
      data-muted={muted ? 'true' : 'false'}
      data-volume={volume.toFixed(2)}
      data-ready={ready ? 'true' : 'false'}
      data-controls-visible={visible ? 'true' : 'false'}
      className={cx('absolute inset-0', playing && !visible && 'cursor-none')}
      onPointerMove={bump}
      onPointerDown={bump}
    >
      {/* Sin subtítulos por decisión del usuario (docs/DESIGN.md §16.6): no hay <track>. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        data-player-video=""
        src={mediaUrl(id)}
        preload="metadata"
        autoPlay
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload noremoteplayback"
        className={cx('size-full object-contain', ready ? 'opacity-100' : 'opacity-0')}
        onClick={togglePlay}
        onDoubleClick={onToggleFullscreen}
        onPlay={syncState}
        onPause={syncState}
        onEnded={syncState}
        onEmptied={syncState}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          syncDuration();
          setBuffered(bufferedSegments(bufferedOf(v), effectiveDuration(v.duration, durationMs)));
        }}
        onDurationChange={syncDuration}
        onLoadedData={() => {
          setReady(true);
          onReady();
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setTime(v.currentTime);
          setBuffered(bufferedSegments(bufferedOf(v), effectiveDuration(v.duration, durationMs)));
        }}
        onProgress={(e) => {
          const v = e.currentTarget;
          setBuffered(bufferedSegments(bufferedOf(v), effectiveDuration(v.duration, durationMs)));
        }}
        onError={(e) => setError(videoErrorMessage(e.currentTarget.error?.code))}
      />
      {error ? (
        <p
          role="alert"
          data-player-error=""
          className="absolute inset-x-0 top-1/2 mx-auto w-fit max-w-[80%] -translate-y-1/2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-center text-sm text-danger-text"
        >
          {error}
        </p>
      ) : null}
      <PlayerControls
        visible={visible}
        playing={playing}
        time={time}
        duration={duration}
        buffered={buffered}
        volume={volume}
        muted={muted}
        speed={speed}
        loop={loop}
        fullscreen={fullscreen}
        onTogglePlay={togglePlay}
        onSeekBy={seekBy}
        onSeekTo={seekTo}
        onVolume={changeVolume}
        onToggleMute={toggleMute}
        onSpeed={changeSpeed}
        onToggleLoop={toggleLoop}
        onToggleFullscreen={onToggleFullscreen}
        onMenuOpenChange={setMenuOpen}
        onFocusWithinChange={setFocusWithin}
        onHoverChange={setHovering}
      />
    </div>
  );
}
