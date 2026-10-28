// Campos de los ajustes de la presentación (docs/DESIGN.md §17.2), compartidos por el diálogo de
// inicio, el panel en vivo y Ajustes → Presentación. Todo son tokens del tema (superficies, bordes,
// acento): en Clásico y en Ondas es la misma estructura.
//
// Las tres cosas que se pueden apagar son independientes (PLAN.md nota 173): transiciones,
// animaciones (Ken Burns) y música. El audio son «Silenciar vídeos» y «Música de fondo» (D16), uno
// al lado del otro; «Mantener la música durante los vídeos» solo aparece con la música encendida.
import { useEffect, useId, type ReactNode } from 'react';
import { Check, ChevronDown, Upload } from 'lucide-react';
import { Select, Switch } from 'radix-ui';
import { PRESENTATION_LIMITS } from '@shared/constants';
import type { MusicTrack, PresentationSettings } from '@shared/types';
import { Button } from '../../components/Button';
import { Slider } from '../../components/Slider';
import { formatDuration } from '../../lib/format';
import { importMusic, loadMusic, useMusicStore } from '../../stores/music-store';
import { useThemeStore } from '../../stores/theme-store';
import { toggleTrack } from '../playlists/playlist-order';
import { MUSIC_UNENCRYPTED_NOTICE } from '../settings/music-preview';
import {
  appendTracks,
  clampSlideMs,
  clampTransitionMs,
  describeAudio,
  formatSeconds,
  musicDuringVideo,
  setMusicDuringVideo,
  setTransitionsOn,
  setVideosSilenced,
  toggleRandomKind,
  TRANSITION_KIND_LABELS,
  TRANSITION_KINDS,
  TRANSITION_MS_STEP,
  TRANSITION_OPTIONS,
  videosSilenced,
} from './presentation-form-model';
import type { TransitionSetting } from './transitions';

export type FormContext = 'setup' | 'live' | 'defaults';

export interface FormProps {
  settings: PresentationSettings;
  onChange(patch: Partial<PresentationSettings>): void;
  context: FormContext;
  /** Última transición distinta de «ninguna», para devolverla al volver a encender las transiciones. */
  lastTransition?: TransitionSetting;
}

const HEADING = 'text-sm font-semibold text-text';
const GROUP = 'flex flex-col gap-3 rounded-md border border-border bg-surface p-3';
const OPTION_ITEM =
  'relative flex h-9 cursor-default items-center rounded-sm pr-3 pl-8 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring';

export function SwitchField({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
  testId,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange(checked: boolean): void;
  testId?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex items-start gap-3">
      <Switch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={hintId}
        data-testid={testId}
        className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border-2 border-border-strong bg-surface transition-colors data-disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-text transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-on-accent" />
      </Switch.Root>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-xs text-text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SliderField({
  label,
  valueText,
  value,
  min,
  max,
  step,
  disabled,
  onValueChange,
}: {
  label: string;
  valueText: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onValueChange(value: number): void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span aria-hidden="true" className="font-medium whitespace-nowrap text-text">
          {label}
        </span>
        <span aria-hidden="true" className="whitespace-nowrap text-text-muted tabular-nums">
          {valueText}
        </span>
      </div>
      <Slider
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        valueText={valueText}
        disabled={disabled}
        onValueChange={onValueChange}
      />
    </div>
  );
}

function TransitionSelect({
  value,
  onChange,
}: {
  value: TransitionSetting;
  onChange(value: TransitionSetting): void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-text">
        Tipo de transición
      </span>
      <Select.Root value={value} onValueChange={(v) => onChange(v as TransitionSetting)}>
        <Select.Trigger
          aria-labelledby={labelId}
          className="inline-flex h-10 w-full items-center justify-between rounded-md border border-border-strong bg-surface px-3 text-sm text-text"
        >
          <Select.Value />
          <Select.Icon>
            <ChevronDown aria-hidden="true" size={16} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-[80] w-(--radix-select-trigger-width) rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md"
          >
            <Select.Viewport>
              {TRANSITION_OPTIONS.map((o) => (
                <Select.Item key={o.value} value={o.value} className={OPTION_ITEM}>
                  <Select.ItemIndicator className="absolute left-2 inline-flex">
                    <Check aria-hidden="true" size={16} />
                  </Select.ItemIndicator>
                  <Select.ItemText>{o.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

/**
 * «Silenciar vídeos» y «Música de fondo» uno al lado del otro (D16), el mantener la música durante
 * los vídeos y los volúmenes. Sirve en el menú de audio de la barra y en el formulario.
 */
export function AudioFields({
  settings,
  onChange,
  hasTracks,
}: {
  settings: PresentationSettings;
  onChange(patch: Partial<PresentationSettings>): void;
  hasTracks: boolean;
}) {
  const musicOn = settings.musicEnabled && hasTracks;
  return (
    <div className="flex flex-col gap-3" data-audio-fields="">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SwitchField
          label="Silenciar vídeos"
          hint="Los vídeos se ven sin su sonido."
          checked={videosSilenced(settings)}
          onCheckedChange={(silenced) =>
            onChange({ audioMode: setVideosSilenced(settings.audioMode, silenced) })
          }
          testId="audio-mute-videos"
        />
        <SwitchField
          label="Música de fondo"
          hint={hasTracks ? undefined : 'Elige al menos una pista para activarla.'}
          checked={musicOn}
          disabled={!hasTracks}
          onCheckedChange={(on) => onChange({ musicEnabled: on })}
          testId="audio-background-music"
        />
      </div>
      {musicOn ? (
        <SwitchField
          label="Mantener la música durante los vídeos"
          hint="Si no, la música baja mientras suena un vídeo y vuelve al terminar."
          checked={musicDuringVideo(settings)}
          onCheckedChange={(keep) =>
            onChange({ audioMode: setMusicDuringVideo(settings.audioMode, keep) })
          }
          testId="audio-music-during-video"
        />
      ) : null}
      <p className="text-xs text-text-muted" data-audio-summary="">
        {describeAudio({ audioMode: settings.audioMode, musicEnabled: musicOn })}
      </p>
      <div className="flex flex-col gap-3">
        <SliderField
          label="Volumen de la música"
          valueText={`${Math.round(settings.musicVolume * 100)} %`}
          value={Math.round(settings.musicVolume * 100)}
          min={0}
          max={100}
          step={5}
          disabled={!musicOn}
          onValueChange={(v) => onChange({ musicVolume: v / 100 })}
        />
        <SliderField
          label="Volumen de los vídeos"
          valueText={`${Math.round(settings.videoVolume * 100)} %`}
          value={Math.round(settings.videoVolume * 100)}
          min={0}
          max={100}
          step={5}
          disabled={videosSilenced(settings)}
          onValueChange={(v) => onChange({ videoVolume: v / 100 })}
        />
      </div>
    </div>
  );
}

function TrackPicker({
  settings,
  tracks,
  onChange,
}: {
  settings: PresentationSettings;
  tracks: readonly MusicTrack[];
  onChange(patch: Partial<PresentationSettings>): void;
}) {
  const importing = useMusicStore((s) => s.importing);
  const full = settings.trackIds.length >= PRESENTATION_LIMITS.trackIdsMax;

  const doImport = async (): Promise<void> => {
    await importMusic();
    const imported = useMusicStore.getState().summary?.imported ?? [];
    if (imported.length === 0) return;
    // La música recién importada se añade a la lista y enciende la música de fondo.
    onChange({
      trackIds: appendTracks(
        settings.trackIds,
        imported.map((t) => t.id),
      ),
      musicEnabled: true,
    });
  };

  return (
    <fieldset className={GROUP}>
      <legend className={`${HEADING} px-1`}>Pistas de música</legend>
      {tracks.length === 0 ? (
        <p className="text-sm text-text-muted">
          Todavía no hay música en la biblioteca. Impórtala para poder usarla.
        </p>
      ) : (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-track-list="">
          {tracks.map((t) => {
            const order = settings.trackIds.indexOf(t.id);
            const checked = order !== -1;
            return (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-text hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={() => {
                    const trackIds = toggleTrack(settings.trackIds, t.id);
                    // La primera pista enciende la música de fondo; sin pistas no hay música.
                    onChange({
                      trackIds,
                      musicEnabled:
                        trackIds.length === 0
                          ? false
                          : settings.trackIds.length === 0
                            ? true
                            : settings.musicEnabled,
                    });
                  }}
                  className="size-4 accent-(--g-accent)"
                />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 text-xs text-text-muted">
                  {t.durationMs === null ? '' : formatDuration(t.durationMs)}
                </span>
                {checked ? (
                  <span className="shrink-0 rounded-full bg-accent px-2 text-xs text-on-accent">
                    {order + 1}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      )}
      <div className="flex flex-col items-start gap-1.5">
        <Button size="sm" disabled={importing} onClick={() => void doImport()}>
          <Upload aria-hidden="true" size={14} strokeWidth={1.75} />
          {importing ? 'Importando…' : 'Importar música…'}
        </Button>
        <p className="text-xs text-text-muted">{MUSIC_UNENCRYPTED_NOTICE}</p>
      </div>
    </fieldset>
  );
}

export function PresentationSettingsForm({
  settings,
  onChange,
  context,
  lastTransition,
}: FormProps) {
  const tracks = useMusicStore((s) => s.tracks);
  const systemReducedMotion = useThemeStore((s) => s.reducedMotion);
  const musicStatus = useMusicStore((s) => s.status);
  const withTracks = context !== 'live';
  // El diálogo de inicio y Ajustes tienen sitio para dos columnas; el panel en vivo no.
  const wide = context === 'setup';
  useEffect(() => {
    if (withTracks) void loadMusic();
  }, [withTracks]);

  const transitionsAreOn = settings.transition !== 'none';
  const hasTracks = settings.trackIds.length > 0;

  return (
    <div
      className={wide ? 'grid items-start gap-4 md:grid-cols-2' : 'flex flex-col gap-4'}
      data-presentation-form={context}
    >
      <div className="flex flex-col gap-4">
        <fieldset className={GROUP}>
          <legend className={`${HEADING} px-1`}>Transiciones</legend>
          <SwitchField
            label="Transiciones"
            hint="Apagadas, las diapositivas cambian de golpe."
            checked={transitionsAreOn}
            onCheckedChange={(on) => onChange(setTransitionsOn(settings, on, lastTransition))}
            testId="transitions-on"
          />
          {transitionsAreOn ? (
            <>
              <TransitionSelect
                value={settings.transition}
                onChange={(transition) => onChange({ transition })}
              />
              {settings.transition === 'random' ? (
                <div
                  className="flex flex-col gap-1.5"
                  role="group"
                  aria-label="Transiciones del modo aleatorio"
                >
                  <span className="text-sm font-medium text-text">Elegir entre</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {TRANSITION_KINDS.map((kind) => (
                      <label key={kind} className="flex items-center gap-2 text-sm text-text">
                        <input
                          type="checkbox"
                          checked={settings.randomPool.includes(kind)}
                          onChange={() =>
                            onChange({ randomPool: toggleRandomKind(settings.randomPool, kind) })
                          }
                          className="size-4 accent-(--g-accent)"
                        />
                        {TRANSITION_KIND_LABELS[kind]}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              <SliderField
                label="Duración de la transición"
                valueText={formatSeconds(settings.transitionMs)}
                value={Math.max(TRANSITION_MS_STEP, settings.transitionMs)}
                min={TRANSITION_MS_STEP}
                max={PRESENTATION_LIMITS.transitionMsMax}
                step={TRANSITION_MS_STEP}
                onValueChange={(v) => onChange({ transitionMs: clampTransitionMs(v) })}
              />
            </>
          ) : null}
          <SwitchField
            label="Animaciones"
            hint="Movimiento lento (Ken Burns) en las fotos, con cualquier transición. Apagadas, las fotos se quedan quietas."
            checked={settings.animations}
            onCheckedChange={(animations) => onChange({ animations })}
            testId="animations-on"
          />
          {systemReducedMotion ? (
            <p role="note" data-reduced-motion-hint="" className="text-xs text-text-muted">
              Tu sistema pide reducir el movimiento. Las transiciones y animaciones de la
              presentación siguen lo que elijas aquí.
            </p>
          ) : null}
        </fieldset>

        <fieldset className={GROUP}>
          <legend className={`${HEADING} px-1`}>Reproducción</legend>
          <SliderField
            label="Duración de cada foto"
            valueText={formatSeconds(settings.slideMs)}
            value={settings.slideMs}
            min={PRESENTATION_LIMITS.slideMsMin}
            max={PRESENTATION_LIMITS.slideMsMax}
            step={PRESENTATION_LIMITS.slideMsStep}
            onValueChange={(v) => onChange({ slideMs: clampSlideMs(v) })}
          />
          <p className="-mt-1 text-xs text-text-muted">Los vídeos duran lo que duran.</p>
          <SwitchField
            label="Repetir en bucle"
            hint="Tras la última diapositiva sigue la primera."
            checked={settings.loop}
            onCheckedChange={(loop) => onChange({ loop })}
            testId="loop-on"
          />
          {context !== 'live' ? (
            <SwitchField
              label="Empezar en pantalla completa"
              hint="Apagado, la presentación se ve dentro de la ventana, bajo la barra de título."
              checked={settings.startFullscreen}
              onCheckedChange={(startFullscreen) => onChange({ startFullscreen })}
              testId="fullscreen-on"
            />
          ) : null}
        </fieldset>
      </div>

      <div className="flex flex-col gap-4">
        <fieldset className={GROUP}>
          <legend className={`${HEADING} px-1`}>Sonido</legend>
          <AudioFields settings={settings} onChange={onChange} hasTracks={hasTracks} />
          <SliderField
            label="Fundido de la música"
            valueText={formatSeconds(settings.musicFadeMs)}
            value={settings.musicFadeMs}
            min={PRESENTATION_LIMITS.musicFadeMsMin}
            max={PRESENTATION_LIMITS.musicFadeMsMax}
            step={100}
            disabled={!(settings.musicEnabled && hasTracks)}
            onValueChange={(v) => onChange({ musicFadeMs: Math.round(v / 100) * 100 })}
          />
        </fieldset>

        {withTracks ? (
          musicStatus === 'ready' ? (
            <TrackPicker settings={settings} tracks={tracks} onChange={onChange} />
          ) : (
            <p role="status" className="text-sm text-text-muted">
              Cargando la música…
            </p>
          )
        ) : (
          <p className="text-xs text-text-muted">
            Las pistas se eligen antes de empezar, en el diálogo de inicio o en Ajustes →
            Presentación.
          </p>
        )}
      </div>
    </div>
  );
}
