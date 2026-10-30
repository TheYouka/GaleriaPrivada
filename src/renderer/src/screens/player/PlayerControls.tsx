// Controles del reproductor de vídeo (docs/DESIGN.md §16.6): reproducir/pausar, barra de progreso con
// los rangos ya cargados y un tooltip con el tiempo, −10 s/+10 s, tiempo, volumen y silencio,
// velocidad (menú 0,25×–2×), bucle y pantalla completa. Solo los básicos: sin subtítulos. Todo usa los
// tokens del tema (cromo); el vídeo no. Los atajos los resuelve VideoPlayer.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  FastForward,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  Rewind,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Slider as RSlider } from 'radix-ui';
import { IconButton } from '../../components/IconButton';
import { Menu } from '../../components/Menu';
import { Slider } from '../../components/Slider';
import { cx } from '../../lib/cx';
import { formatDuration } from '../../lib/format';
import {
  BAR_ARROW_S,
  BAR_RESOLUTION,
  formatSpeed,
  fromBarValue,
  SEEK_STEP_S,
  SPEEDS,
  toBarValue,
  type BufferedSegment,
} from './player-math';

/** Cada botón: el anillo de foco por dentro, para verse sobre cualquier fondo. */
const BUTTON = 'focus-visible:-outline-offset-2';

export interface PlayerControlsProps {
  visible: boolean;
  playing: boolean;
  /** Segundos. */
  time: number;
  /** Segundos; 0 si se desconoce. */
  duration: number;
  buffered: readonly BufferedSegment[];
  volume: number;
  muted: boolean;
  speed: number;
  loop: boolean;
  fullscreen: boolean;
  onTogglePlay(): void;
  onSeekBy(delta: number): void;
  onSeekTo(time: number): void;
  onVolume(volume: number): void;
  onToggleMute(): void;
  onSpeed(speed: number): void;
  onToggleLoop(): void;
  onToggleFullscreen(): void;
  onMenuOpenChange(open: boolean): void;
  onFocusWithinChange(within: boolean): void;
  onHoverChange(hovering: boolean): void;
}

const ms = (seconds: number): string => formatDuration(seconds * 1000);

export function PlayerControls({
  visible,
  playing,
  time,
  duration,
  buffered,
  volume,
  muted,
  speed,
  loop,
  fullscreen,
  onTogglePlay,
  onSeekBy,
  onSeekTo,
  onVolume,
  onToggleMute,
  onSpeed,
  onToggleLoop,
  onToggleFullscreen,
  onMenuOpenChange,
  onFocusWithinChange,
  onHoverChange,
}: PlayerControlsProps) {
  // Mientras se arrastra la barra con el puntero se muestra la posición del puntero y no la del
  // vídeo. Con el teclado (Inicio/Fin) Radix no avisa del final del gesto en un orden fiable (llama a
  // onValueCommit antes que a onValueChange o no lo llama), así que solo se guarda `scrub` durante un
  // arrastre real (PLAN.md nota 205).
  const [scrub, setScrub] = useState<number | null>(null);
  const dragging = useRef(false);
  const endDrag = (): void => {
    dragging.current = false;
    setScrub(null);
  };
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const barValue = scrub ?? toBarValue(time, duration);
  const shownTime = scrub === null ? time : fromBarValue(scrub, duration);
  const level = muted || volume === 0 ? 0 : Math.round(volume * 100);
  const VolumeIcon = level === 0 ? VolumeX : level < 50 ? Volume1 : Volume2;

  const onBarKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    // ←/→ en la barra la mueven 5 s (Mayús, 10 s); Inicio y Fin los resuelve Radix.
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? SEEK_STEP_S : BAR_ARROW_S;
    onSeekBy(e.key === 'ArrowRight' ? step : -step);
  };

  const onBarPointerMove = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!(duration > 0)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({ x: fraction * rect.width, t: fraction * duration });
  };

  return (
    <div
      role="group"
      aria-label="Controles del reproductor"
      data-player-controls=""
      data-visible={visible ? 'true' : 'false'}
      className={cx(
        'absolute inset-x-3 bottom-3 z-10 rounded-lg border border-border bg-bg-elevated/90 px-3 py-2 text-text shadow-md backdrop-blur-sm transition-opacity duration-150 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      onFocus={() => onFocusWithinChange(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onFocusWithinChange(false);
      }}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
    >
      <div className="flex items-center gap-3">
        <span className="w-12 text-right text-xs tabular-nums" data-player-time="">
          {ms(shownTime)}
        </span>
        <div className="relative min-w-0 flex-1">
          <RSlider.Root
            className="relative flex h-6 w-full touch-none items-center data-disabled:opacity-50"
            data-player-bar=""
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
            onPointerMove={onBarPointerMove}
            onPointerLeave={() => setHover(null)}
          >
            <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-border-strong">
              {buffered.map((b) => (
                <span
                  key={`${b.left}-${b.width}`}
                  aria-hidden="true"
                  data-player-buffered=""
                  className="absolute h-full bg-text-muted/50"
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                />
              ))}
              <RSlider.Range className="absolute h-full rounded-full bg-accent" />
            </RSlider.Track>
            <RSlider.Thumb
              aria-label="Progreso"
              aria-valuetext={`${ms(shownTime)} de ${ms(duration)}`}
              data-player-progress=""
              className="block size-4 rounded-full border-2 border-accent bg-bg-elevated shadow-sm"
            />
          </RSlider.Root>
          {hover ? (
            <span
              aria-hidden="true"
              data-player-tooltip=""
              className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-xs tabular-nums shadow-sm"
              style={{ left: hover.x }}
            >
              {ms(hover.t)}
            </span>
          ) : null}
        </div>
        <span className="w-12 text-xs tabular-nums" data-player-duration="">
          {duration > 0 ? ms(duration) : '—'}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <IconButton
          label={playing ? 'Pausar (K)' : 'Reproducir (K)'}
          icon={playing ? Pause : Play}
          className={BUTTON}
          onClick={onTogglePlay}
        />
        <IconButton
          label="Retroceder 10 s (J)"
          icon={Rewind}
          className={BUTTON}
          onClick={() => onSeekBy(-SEEK_STEP_S)}
        />
        <IconButton
          label="Avanzar 10 s (L)"
          icon={FastForward}
          className={BUTTON}
          onClick={() => onSeekBy(SEEK_STEP_S)}
        />
        <IconButton
          label={level === 0 ? 'Activar el sonido (M)' : 'Silenciar (M)'}
          icon={VolumeIcon}
          className={BUTTON}
          onClick={onToggleMute}
        />
        <div className="w-24 px-1">
          <Slider
            label="Volumen"
            value={level}
            min={0}
            max={100}
            step={5}
            valueText={`${level} %`}
            onValueChange={(v) => onVolume(v / 100)}
          />
        </div>
        <span className="flex-1" />
        <Menu
          label="Velocidad"
          value={String(speed)}
          options={SPEEDS.map((s) => ({ value: String(s), label: formatSpeed(s) }))}
          onValueChange={(v) => onSpeed(Number(v))}
          onOpenChange={onMenuOpenChange}
          trigger={
            <button
              type="button"
              aria-label={`Velocidad: ${formatSpeed(speed)}`}
              title="Velocidad (Mayús+, / Mayús+.)"
              className="inline-flex h-9 min-w-12 items-center justify-center rounded-md px-2 text-sm text-text tabular-nums transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2 active:bg-surface-pressed"
            >
              {formatSpeed(speed)}
            </button>
          }
        />
        <IconButton
          label="Repetir en bucle (R)"
          icon={Repeat}
          aria-pressed={loop}
          className={cx(BUTTON, 'aria-pressed:bg-accent aria-pressed:text-on-accent')}
          onClick={onToggleLoop}
        />
        <IconButton
          label={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
          icon={fullscreen ? Minimize : Maximize}
          className={BUTTON}
          onClick={onToggleFullscreen}
        />
      </div>
    </div>
  );
}
