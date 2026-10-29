// Un lado de la pantalla de vídeo dual (docs/DESIGN.md §18.1): un <video src="vault://media/<id>">
// sin controles nativos con `object-fit: contain` sobre fondo negro (el contenido no depende del
// tema), o el hueco «Elegir vídeo…» si todavía no hay vídeo. Los eventos del <video> suben a la
// pantalla (`onPatch`) y, en modo sincronizado, al controlador (waiting, canplay, ended).
import { useEffect, type RefObject } from 'react';
import { Film } from 'lucide-react';
import type { MediaDetail } from '@shared/types';
import { Button } from '../../components/Button';
import { mediaUrl } from '../../lib/vault-url';
import { requestPick, SIDE_LABEL } from '../../stores/dual-store';
import { effectiveDuration, videoErrorMessage } from '../player/player-math';
import type { PaneState } from './pane-state';
import type { Side } from './sync';

export interface DualPaneProps {
  side: Side;
  detail: MediaDetail | null;
  /** Época + id del medio: cambia al elegir o quitar el vídeo (aunque sea el mismo). */
  stateKey: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Bucle nativo (modo independiente); en el sincronizado lo hace el controlador. */
  nativeLoop: boolean;
  /** 0–1. */
  volume: number;
  muted: boolean;
  state: PaneState;
  onPatch(key: string, patch: Partial<PaneState>): void;
  onWaiting(): void;
  onCanPlay(): void;
  onEnded(): void;
  onClickVideo(): void;
}

export function DualPane({
  side,
  detail,
  stateKey,
  videoRef,
  nativeLoop,
  volume,
  muted,
  state,
  onPatch,
  onWaiting,
  onCanPlay,
  onEnded,
  onClickVideo,
}: DualPaneProps) {
  const label = SIDE_LABEL[side];

  // Volumen y silencio de este lado. El elemento se vuelve a crear al cambiar `stateKey` (época + id,
  // también al elegir el mismo vídeo) y trae los valores por defecto, así que hay que reaplicarlos.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [videoRef, stateKey, volume, muted]);

  if (!detail) {
    return (
      <section
        data-dual-side={side}
        data-dual-empty=""
        tabIndex={-1}
        aria-label={`Lado ${label}, sin vídeo`}
        className="flex min-h-0 flex-col items-center justify-center gap-3 bg-bg-elevated p-4 text-center focus-visible:-outline-offset-4"
      >
        <Film aria-hidden="true" size={36} strokeWidth={1.25} className="text-text-muted" />
        <p className="text-sm text-text-muted">Todavía no hay vídeo en el lado {label}.</p>
        <Button variant="primary" onClick={() => requestPick(side)}>
          Elegir vídeo…
        </Button>
      </section>
    );
  }

  const durationOf = (v: HTMLVideoElement): number =>
    effectiveDuration(v.duration, detail.durationMs);
  const playingOf = (v: HTMLVideoElement): boolean => !v.paused && !v.ended;

  return (
    <section
      data-dual-side={side}
      data-ready={state.ready ? 'true' : 'false'}
      tabIndex={-1}
      aria-label={`Lado ${label}: ${detail.name}`}
      className="relative min-h-0 bg-black focus-visible:-outline-offset-4"
    >
      {/* Sin subtítulos por decisión del usuario (docs/DESIGN.md §16.6): no hay <track>. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        key={stateKey}
        ref={videoRef}
        data-dual-video={side}
        src={mediaUrl(detail.id)}
        preload="auto"
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload noremoteplayback"
        loop={nativeLoop}
        className="size-full object-contain"
        onClick={onClickVideo}
        onPlay={(e) => onPatch(stateKey, { playing: playingOf(e.currentTarget) })}
        onPause={(e) => onPatch(stateKey, { playing: playingOf(e.currentTarget) })}
        onEnded={() => {
          onPatch(stateKey, { playing: false });
          onEnded();
        }}
        onWaiting={onWaiting}
        onCanPlay={onCanPlay}
        onLoadedMetadata={(e) => onPatch(stateKey, { duration: durationOf(e.currentTarget) })}
        onDurationChange={(e) => onPatch(stateKey, { duration: durationOf(e.currentTarget) })}
        onLoadedData={() => onPatch(stateKey, { ready: true })}
        onTimeUpdate={(e) => onPatch(stateKey, { time: e.currentTarget.currentTime })}
        onSeeked={(e) => onPatch(stateKey, { time: e.currentTarget.currentTime })}
        onError={(e) =>
          onPatch(stateKey, { error: videoErrorMessage(e.currentTarget.error?.code) })
        }
      />
      {state.error ? (
        <p
          role="alert"
          data-dual-error=""
          className="absolute inset-x-0 top-1/2 mx-auto w-fit max-w-[80%] -translate-y-1/2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-center text-sm text-danger-text"
        >
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
