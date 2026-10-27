// Barra inferior de la presentación (docs/DESIGN.md §17.9): anterior, reproducir/pausar, siguiente,
// posición («3 / 25»), música sí/no, menú de audio («Silenciar vídeos» y «Música de fondo» juntos,
// D16), ajustes, pantalla completa y salir. Se oculta a los 3 s sin movimiento (lo decide
// PresentationScreen). Todo usa los tokens del tema, igual que los controles del reproductor: el
// contenido de la diapositiva no depende del tema, la barra sí.
import {
  Maximize,
  Minimize,
  Music,
  Music2,
  Pause,
  Play,
  Settings,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import type { PresentationSettings } from '@shared/types';
import { IconButton } from '../../components/IconButton';
import { cx } from '../../lib/cx';
import { AudioFields } from './PresentationSettingsForm';

/** El anillo de foco por dentro, para verse sobre cualquier fondo. */
const BUTTON = 'focus-visible:-outline-offset-2';

export interface PresentationControlsProps {
  visible: boolean;
  paused: boolean;
  /** Posición de la diapositiva actual (1-based) y total. */
  position: number;
  total: number;
  fullscreen: boolean;
  settings: PresentationSettings;
  settingsOpen: boolean;
  onPrev(): void;
  onTogglePause(): void;
  onNext(): void;
  onToggleMusic(): void;
  onChangeSettings(patch: Partial<PresentationSettings>): void;
  onToggleSettings(): void;
  onToggleFullscreen(): void;
  onExit(): void;
  onAudioMenuOpenChange(open: boolean): void;
  onFocusWithinChange(within: boolean): void;
  onHoverChange(hovering: boolean): void;
}

export function PresentationControls({
  visible,
  paused,
  position,
  total,
  fullscreen,
  settings,
  settingsOpen,
  onPrev,
  onTogglePause,
  onNext,
  onToggleMusic,
  onChangeSettings,
  onToggleSettings,
  onToggleFullscreen,
  onExit,
  onAudioMenuOpenChange,
  onFocusWithinChange,
  onHoverChange,
}: PresentationControlsProps) {
  const hasTracks = settings.trackIds.length > 0;
  const musicOn = settings.musicEnabled && hasTracks;
  return (
    <div
      role="group"
      aria-label="Controles de la presentación"
      data-presentation-controls=""
      data-visible={visible ? 'true' : 'false'}
      className={cx(
        'absolute inset-x-3 bottom-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-bg-elevated/90 px-3 py-2 text-text shadow-md backdrop-blur-sm transition-opacity duration-150 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      // Solo el foco del teclado las mantiene a la vista; un clic con el ratón deja el foco en el
      // botón y no debe impedir que se oculten.
      onFocus={(e) => onFocusWithinChange(e.target.matches(':focus-visible'))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onFocusWithinChange(false);
      }}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
    >
      <IconButton label="Anterior (←)" icon={SkipBack} className={BUTTON} onClick={onPrev} />
      <IconButton
        label={paused ? 'Reanudar (Espacio)' : 'Pausar (Espacio)'}
        icon={paused ? Play : Pause}
        className={BUTTON}
        onClick={onTogglePause}
      />
      <IconButton label="Siguiente (→)" icon={SkipForward} className={BUTTON} onClick={onNext} />
      <span
        data-presentation-position=""
        className="mx-2 min-w-14 text-center text-sm tabular-nums"
      >
        {position} / {total}
      </span>
      <span className="flex-1" />
      <IconButton
        label={musicOn ? 'Música de fondo: sí (M)' : 'Música de fondo: no (M)'}
        icon={musicOn ? Music : Music2}
        aria-pressed={musicOn}
        className={cx(BUTTON, 'aria-pressed:bg-accent aria-pressed:text-on-accent')}
        onClick={onToggleMusic}
      />
      <Popover.Root onOpenChange={onAudioMenuOpenChange}>
        <Popover.Trigger asChild>
          <IconButton label="Audio" icon={Volume2} className={BUTTON} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={8}
            aria-label="Audio de la presentación"
            data-presentation-audio-menu=""
            className="z-[80] w-[min(26rem,calc(100vw-2rem))] rounded-md border border-border bg-bg-elevated p-4 text-text shadow-md"
          >
            <AudioFields settings={settings} onChange={onChangeSettings} hasTracks={hasTracks} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <IconButton
        label="Ajustes de la presentación"
        icon={Settings}
        aria-pressed={settingsOpen}
        className={cx(BUTTON, 'aria-pressed:bg-surface-hover')}
        onClick={onToggleSettings}
      />
      <IconButton
        label={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
        icon={fullscreen ? Minimize : Maximize}
        className={BUTTON}
        onClick={onToggleFullscreen}
      />
      <IconButton label="Salir (Esc)" icon={X} className={BUTTON} onClick={onExit} />
    </div>
  );
}
