// Barra de controles de la pantalla de vídeo dual (docs/DESIGN.md §18.1): reproducir/pausar, barra de
// progreso, −10 s/+10 s, volumen y silencio de cada lado, velocidad y bucle. Solo los básicos de
// §16.6 (sin pantalla completa ni subtítulos). En modo sincronizado hay UNA barra que actúa sobre los
// dos vídeos (con el volumen de cada lado); en modo independiente, una barra por lado. Todo usa los
// tokens del tema (cromo); el vídeo no. Los atajos los resuelve DualVideoScreen.
import { useRef, useState, type KeyboardEvent } from 'react';
import { FastForward, Pause, Play, Repeat, Rewind, Volume1, Volume2, VolumeX } from 'lucide-react';
import { Slider as RSlider } from 'radix-ui';
import { IconButton } from '../../components/IconButton';
import { Menu } from '../../components/Menu';
import { Slider } from '../../components/Slider';
import { cx } from '../../lib/cx';
import { formatDuration } from '../../lib/format';
import { SIDE_LABEL } from '../../stores/dual-store';
import {
  BAR_ARROW_S,
  BAR_RESOLUTION,
  formatSpeed,
  fromBarValue,
  SEEK_STEP_S,
  SPEEDS,
  toBarValue,
} from '../player/player-math';
import type { Side } from './sync';

/** Cada botón: el anillo de foco por dentro, para verse sobre cualquier fondo. */
const BUTTON = 'focus-visible:-outline-offset-2';

export interface AudioControl {
  side: Side;
  /** 0–1. */
  volume: number;
  muted: boolean;
  onVolume(volume: number): void;
  onToggleMute(): void;
}

export interface DualControlsProps {
  /** `null`: la barra sincronizada (los dos lados); si no, la barra de ese lado. */
  scope: Side | null;
  playing: boolean;
  /** Segundos. */
  time: number;
  /** Segundos; 0 si se desconoce. */
  duration: number;
  speed: number;
  loop: boolean;
  audio: readonly AudioControl[];
  onTogglePlay(): void;
  onSeekBy(delta: number): void;
  onSeekTo(time: number): void;
  onSpeed(speed: number): void;
  onToggleLoop(): void;
}

const ms = (seconds: number): string => formatDuration(seconds * 1000);

function AudioGroup({ audio, named }: { audio: AudioControl; named: boolean }) {
  const label = SIDE_LABEL[audio.side];
  const level = audio.muted || audio.volume === 0 ? 0 : Math.round(audio.volume * 100);
  const Icon = level === 0 ? VolumeX : level < 50 ? Volume1 : Volume2;
  return (
    <div role="group" aria-label={`Audio ${label}`} className="flex items-center gap-0.5">
      {named ? (
        <span aria-hidden="true" className="pl-1 text-xs text-text-muted">
          {audio.side === 'left' ? 'Izq.' : 'Der.'}
        </span>
      ) : null}
      <IconButton
        label={level === 0 ? `Activar el sonido ${label} (M)` : `Silenciar ${label} (M)`}
        icon={Icon}
        className={BUTTON}
        onClick={audio.onToggleMute}
      />
      <div className="w-20 px-1">
        <Slider
          label={`Volumen ${label}`}
          value={level}
          min={0}
          max={100}
          step={5}
          valueText={`${level} %`}
          onValueChange={(v) => audio.onVolume(v / 100)}
        />
      </div>
    </div>
  );
}

export function DualControls({
  scope,
  playing,
  time,
  duration,
  speed,
  loop,
  audio,
  onTogglePlay,
  onSeekBy,
  onSeekTo,
  onSpeed,
  onToggleLoop,
}: DualControlsProps) {
  // Mientras se arrastra la barra con el puntero se muestra la posición del puntero y no la del
  // vídeo. Con el teclado (Inicio/Fin) Radix no avisa del final del gesto en un orden fiable, así que
  // solo se guarda `scrub` durante un arrastre real.
  const [scrub, setScrub] = useState<number | null>(null);
  const dragging = useRef(false);
  const endDrag = (): void => {
    dragging.current = false;
    setScrub(null);
  };
  const barValue = scrub ?? toBarValue(time, duration);
  const shownTime = scrub === null ? time : fromBarValue(scrub, duration);
  const who = scope === null ? '' : ` ${SIDE_LABEL[scope]}`;

  const onBarKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    // ←/→ en la barra la mueven 5 s (Mayús, 10 s); Inicio y Fin los resuelve Radix.
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? SEEK_STEP_S : BAR_ARROW_S;
    onSeekBy(e.key === 'ArrowRight' ? step : -step);
  };

  return (
    <div
      role="group"
      aria-label={
        scope === null ? 'Controles sincronizados' : `Controles del lado ${SIDE_LABEL[scope]}`
      }
      data-dual-controls={scope ?? 'sync'}
      data-playing={playing ? 'true' : 'false'}
      data-current-time={time.toFixed(2)}
      data-duration={duration.toFixed(2)}
      data-speed={speed}
      data-loop={loop ? 'true' : 'false'}
      className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-text shadow-sm"
    >
      <div className="flex items-center gap-3">
        <span className="w-12 text-right text-xs tabular-nums" data-dual-time="">
          {ms(shownTime)}
        </span>
        <RSlider.Root
          className="relative flex h-6 min-w-0 flex-1 touch-none items-center data-disabled:opacity-50"
          data-dual-bar=""
          value={[barValue]}
          min={0}
          max={BAR_RESOLUTION}
          step={1}
          disabled={!(duration > 0)}
          onPointerDown={() => {
            dragging.current = true;
          }}
          onPointerUp={endDrag}
          onValueChange={(v) => {
            const value = v[0] ?? 0;
            if (dragging.current) setScrub(value);
            onSeekTo(fromBarValue(value, duration));
          }}
          onValueCommit={endDrag}
          onKeyDown={onBarKeyDown}
        >
          <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-border-strong">
            <RSlider.Range className="absolute h-full rounded-full bg-accent" />
          </RSlider.Track>
          <RSlider.Thumb
            aria-label={`Progreso${who}`}
            aria-valuetext={`${ms(shownTime)} de ${ms(duration)}`}
            data-dual-progress=""
            className="block size-4 rounded-full border-2 border-accent bg-bg-elevated shadow-sm"
          />
        </RSlider.Root>
        <span className="w-12 text-xs tabular-nums" data-dual-duration="">
          {duration > 0 ? ms(duration) : '—'}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <IconButton
          label={playing ? `Pausar${who} (K)` : `Reproducir${who} (K)`}
          icon={playing ? Pause : Play}
          className={BUTTON}
          onClick={onTogglePlay}
        />
        <IconButton
          label={`Retroceder 10 s${who} (J)`}
          icon={Rewind}
          className={BUTTON}
          onClick={() => onSeekBy(-SEEK_STEP_S)}
        />
        <IconButton
          label={`Avanzar 10 s${who} (L)`}
          icon={FastForward}
          className={BUTTON}
          onClick={() => onSeekBy(SEEK_STEP_S)}
        />
        {audio.map((a) => (
          <AudioGroup key={a.side} audio={a} named={scope === null} />
        ))}
        <span className="flex-1" />
        <Menu
          label={`Velocidad${who}`}
          value={String(speed)}
          options={SPEEDS.map((s) => ({ value: String(s), label: formatSpeed(s) }))}
          onValueChange={(v) => onSpeed(Number(v))}
          trigger={
            <button
              type="button"
              aria-label={`Velocidad${who}: ${formatSpeed(speed)}`}
              title="Velocidad (Mayús+, / Mayús+.)"
              className="inline-flex h-9 min-w-12 items-center justify-center rounded-md px-2 text-sm text-text tabular-nums transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2 active:bg-surface-pressed"
            >
              {formatSpeed(speed)}
            </button>
          }
        />
        <IconButton
          label={`Repetir en bucle${who} (R)`}
          icon={Repeat}
          aria-pressed={loop}
          className={cx(BUTTON, 'aria-pressed:bg-accent aria-pressed:text-on-accent')}
          onClick={onToggleLoop}
        />
      </div>
    </div>
  );
}
