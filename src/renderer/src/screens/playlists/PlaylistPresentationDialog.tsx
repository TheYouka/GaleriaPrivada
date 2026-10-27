// «Ajustes de presentación de esta playlist» (docs/DESIGN.md §14.8 y §17.2): los ajustes propios de
// una playlist y el interruptor «Usar los ajustes predeterminados». Con el interruptor encendido, la
// playlist sigue los valores de Ajustes → Presentación (playlists:setPresentation con null, que
// quita también las pistas asignadas a la playlist); apagado, se editan y se guardan como propios.
import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import type { AppError } from '@shared/errors';
import type { PlaylistSummary, PresentationSettings } from '@shared/types';
import { Button } from '../../components/Button';
import { announce } from '../../lib/announce';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { loadPlaylists } from '../../stores/playlists-store';
import { cloneSettings } from '../presentation/presentation-form-model';
import { PresentationSettingsForm, SwitchField } from '../presentation/PresentationSettingsForm';
import type { TransitionSetting } from '../presentation/transitions';

function SettingsForm({ playlist, onClose }: { playlist: PlaylistSummary; onClose(): void }) {
  const [settings, setSettings] = useState<PresentationSettings | null>(null);
  const [useDefaults, setUseDefaults] = useState(!playlist.hasCustomPresentation);
  const [last, setLast] = useState<TransitionSetting>('fade');
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void invoke('presentation:getConfig', { playlistId: playlist.id }).then((res) => {
      if (!alive) return;
      if (!res.ok) return setLoadError(res.error);
      setSettings(cloneSettings(res.data.settings));
    });
    return () => {
      alive = false;
    };
  }, [playlist.id]);

  const save = async (): Promise<void> => {
    if (!settings || saving) return;
    // Sin ajustes propios y sin tocar el interruptor no hay nada que guardar.
    if (useDefaults && !playlist.hasCustomPresentation) return onClose();
    setSaving(true);
    setSaveError(null);
    const res = await invoke('playlists:setPresentation', {
      id: playlist.id,
      settings: useDefaults ? null : settings,
    });
    setSaving(false);
    if (!res.ok) return setSaveError(res.error);
    const message = useDefaults
      ? `«${playlist.name}» usa los ajustes predeterminados.`
      : `Ajustes guardados para «${playlist.name}».`;
    toast(message);
    announce(message);
    void loadPlaylists();
    onClose();
  };

  if (loadError) {
    return (
      <p role="alert" className="mt-4 text-sm text-danger-text">
        {errorMessage(loadError)}
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <SwitchField
        label="Usar los ajustes predeterminados"
        hint={
          playlist.hasCustomPresentation
            ? 'Al guardar, esta playlist deja sus ajustes propios (también sus pistas de música) y sigue los de Ajustes → Presentación.'
            : 'Apágalo para que esta playlist tenga sus propios ajustes y su propia música.'
        }
        checked={useDefaults}
        disabled={settings === null || saving}
        onCheckedChange={setUseDefaults}
        testId="playlist-use-defaults"
      />
      {settings === null ? (
        <p role="status" className="text-sm text-text-muted">
          Cargando…
        </p>
      ) : useDefaults ? null : (
        <PresentationSettingsForm
          settings={settings}
          context="setup"
          lastTransition={last}
          onChange={(patch) => {
            if (patch.transition && patch.transition !== 'none') setLast(patch.transition);
            setSettings((s) => (s ? { ...s, ...patch } : s));
          }}
        />
      )}
      {saveError ? (
        <p role="alert" className="text-sm text-danger-text">
          {errorMessage(saveError)}
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <Button disabled={saving} onClick={onClose}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          disabled={saving || settings === null}
          onClick={() => void save()}
        >
          Guardar
        </Button>
      </div>
    </div>
  );
}

export function PlaylistPresentationDialog({
  playlist,
  open,
  onOpenChange,
}: {
  playlist: PlaylistSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-playlist-presentation=""
          aria-describedby="playlist-presentation-description"
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-3rem)] w-[min(60rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-bg-elevated p-6 text-text shadow-lg"
        >
          <Dialog.Title className="text-xl font-semibold">
            {`Ajustes de presentación de «${playlist.name}»`}
          </Dialog.Title>
          <Dialog.Description
            id="playlist-presentation-description"
            className="mt-1 text-sm text-text-muted"
          >
            Cómo se ve y suena la presentación de esta playlist.
          </Dialog.Description>
          {open ? <SettingsForm playlist={playlist} onClose={() => onOpenChange(false)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
