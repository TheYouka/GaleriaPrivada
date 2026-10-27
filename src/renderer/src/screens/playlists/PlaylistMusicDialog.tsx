// Música de una playlist (docs/DESIGN.md §14.8 y §17.2): asigna o quita pistas de la biblioteca del
// perfil a esta playlist. Las pistas elegidas suenan en el orden en que se marcaron y se repiten en
// bucle durante su presentación. Se guardan con playlists:setPresentation (las pistas solo viven en
// la DB cifrada, nunca en presentation_json). También permite importar música nueva desde aquí.
import { useEffect, useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import { PRESENTATION_LIMITS } from '@shared/constants';
import type { AppError } from '@shared/errors';
import type { Id, PlaylistSummary, PresentationSettings } from '@shared/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { announce } from '../../lib/announce';
import { errorMessage } from '../../lib/errors-es';
import { formatDuration } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { importMusic, loadMusic, useMusicStore } from '../../stores/music-store';
import { loadPlaylists } from '../../stores/playlists-store';
import { MUSIC_UNENCRYPTED_NOTICE } from '../settings/music-preview';
import { toggleTrack } from './playlist-order';

function MusicForm({ playlist, onClose }: { playlist: PlaylistSummary; onClose(): void }) {
  const tracks = useMusicStore((s) => s.tracks);
  const musicStatus = useMusicStore((s) => s.status);
  const importing = useMusicStore((s) => s.importing);
  const [config, setConfig] = useState<PresentationSettings | null>(null);
  const [assigned, setAssigned] = useState<Id[]>([]);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadMusic();
    let alive = true;
    void invoke('presentation:getConfig', { playlistId: playlist.id }).then((res) => {
      if (!alive) return;
      if (!res.ok) return setLoadError(res.error);
      setConfig(res.data.settings);
      setAssigned(res.data.tracks.map((t) => t.id));
    });
    return () => {
      alive = false;
    };
  }, [playlist.id]);

  const known = useMemo(() => new Set(tracks.map((t) => t.id)), [tracks]);
  const initial = config?.trackIds ?? [];
  const full = assigned.length >= PRESENTATION_LIMITS.trackIdsMax;

  const save = async (): Promise<void> => {
    if (!config || saving) return;
    setSaving(true);
    setSaveError(null);
    const trackIds = assigned.filter((id) => known.has(id));
    const res = await invoke('playlists:setPresentation', {
      id: playlist.id,
      settings: {
        ...config,
        trackIds,
        // La primera pista asignada enciende la música de fondo de esta playlist (§17.2).
        musicEnabled: config.musicEnabled || (initial.length === 0 && trackIds.length > 0),
      },
    });
    setSaving(false);
    if (!res.ok) return setSaveError(res.error);
    const message =
      trackIds.length === 0
        ? `«${playlist.name}» ya no tiene música.`
        : trackIds.length === 1
          ? `«${playlist.name}» usa 1 pista de música.`
          : `«${playlist.name}» usa ${trackIds.length} pistas de música.`;
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
      {musicStatus !== 'ready' || config === null ? (
        <p role="status" className="text-sm text-text-muted">
          Cargando…
        </p>
      ) : tracks.length === 0 ? (
        <p className="text-sm text-text-muted">
          Todavía no hay música en la biblioteca. Impórtala para poder asignarla.
        </p>
      ) : (
        <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          <legend className="mb-1 text-sm font-medium text-text">Pistas de la playlist</legend>
          {tracks.map((t) => {
            const order = assigned.indexOf(t.id);
            const checked = order !== -1;
            return (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={() => setAssigned((a) => toggleTrack(a, t.id))}
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
        </fieldset>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button size="sm" disabled={importing} onClick={() => void importMusic()}>
          <Upload aria-hidden="true" size={14} strokeWidth={1.75} />
          {importing ? 'Importando…' : 'Importar música…'}
        </Button>
        <p className="text-xs text-text-muted">{MUSIC_UNENCRYPTED_NOTICE}</p>
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-danger-text">
          {errorMessage(saveError)}
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <Button disabled={saving} onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" disabled={saving || config === null} onClick={() => void save()}>
          Guardar
        </Button>
      </div>
    </div>
  );
}

export function PlaylistMusicDialog({
  playlist,
  open,
  onOpenChange,
}: {
  playlist: PlaylistSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Música de «${playlist.name}»`}
      description="Las pistas marcadas suenan en este orden y se repiten durante la presentación de esta playlist."
    >
      {open ? <MusicForm playlist={playlist} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}
