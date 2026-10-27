// Ajustes → Música (docs/DESIGN.md §14.9 y §8.6.1): la biblioteca de música del perfil. Importar abre
// el diálogo nativo en main (multiselección; la app nunca ve rutas), copia cada pista a music/ con un
// nombre neutro y deja el original donde estaba. Aviso fijo: la copia va SIN CIFRAR. Cada pista se
// puede escuchar (un fragmento de unos segundos con un <audio> simple), renombrar y eliminar.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Music, Pause, Pencil, Play, Trash2, Upload } from 'lucide-react';
import { MUSIC_TITLE_MAX } from '@shared/constants';
import type { AppError } from '@shared/errors';
import type { Id, MusicTrack } from '@shared/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { IconButton } from '../../components/IconButton';
import { FIELD_INPUT_CLASS } from '../../components/TextField';
import { errorMessage } from '../../lib/errors-es';
import { formatBytes, formatDuration } from '../../lib/format';
import { toast } from '../../lib/toast';
import { musicUrl } from '../../lib/vault-url';
import {
  deleteTrack,
  dismissMusicSummary,
  importMusic,
  loadMusic,
  renameTrack,
  useMusicStore,
} from '../../stores/music-store';
import { MUSIC_UNENCRYPTED_NOTICE, PREVIEW_MS, previewStartSeconds } from './music-preview';

function titleProblem(raw: string): string | null {
  const title = raw.normalize('NFC').trim();
  if (title.length === 0) return 'Escribe un título.';
  if ([...title].length > MUSIC_TITLE_MAX) {
    return `El título admite como máximo ${MUSIC_TITLE_MAX} caracteres.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    return 'El título no puede tener caracteres de control.';
  }
  return null;
}

function RenameTrackForm({ track, onDone }: { track: MusicTrack; onDone(): void }) {
  const [title, setTitle] = useState(track.title);
  const [error, setError] = useState<AppError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const problem = titleProblem(title);
    if (problem) return setError(problem);
    setBusy(true);
    const failure = await renameTrack(track.id, title);
    setBusy(false);
    if (failure) setError(failure);
    else onDone();
  };

  const message = typeof error === 'string' ? error : error ? errorMessage(error) : null;
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="track-title-input" className="text-sm font-medium text-text">
          Título
        </label>
        <input
          id="track-title-input"
          ref={inputRef}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? 'track-title-error' : undefined}
          autoComplete="off"
          spellCheck={false}
          className={FIELD_INPUT_CLASS}
        />
        {message ? (
          <p id="track-title-error" role="alert" className="text-sm text-danger-text">
            {message}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-3">
        <Button disabled={busy} onClick={onDone}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Guardar
        </Button>
      </div>
    </form>
  );
}

function ImportSummary() {
  const summary = useMusicStore((s) => s.summary);
  const importError = useMusicStore((s) => s.importError);
  if (importError) {
    return (
      <div role="alert" className="max-w-prose rounded-md border border-danger-text p-3 text-sm">
        <p className="text-danger-text">{errorMessage(importError)}</p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={dismissMusicSummary}>
          Cerrar
        </Button>
      </div>
    );
  }
  if (!summary) return null;
  const added = summary.imported.length;
  return (
    <section
      aria-label="Resumen de la importación de música"
      className="max-w-prose rounded-md border border-border-strong bg-surface p-3 text-sm text-text"
    >
      <p role="status" className="font-medium">
        {added === 0
          ? 'No se añadió ninguna pista.'
          : added === 1
            ? 'Se añadió 1 pista.'
            : `Se añadieron ${added} pistas.`}
      </p>
      {summary.failed.length > 0 ? (
        <>
          <p className="mt-2 text-text-muted">
            {summary.failed.length === 1
              ? 'No se pudo importar este archivo:'
              : `No se pudieron importar estos ${summary.failed.length} archivos:`}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {summary.failed.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span className="font-medium">{f.name}</span>: {errorMessage(f.code)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-2 text-text-muted">Los archivos originales siguen en su carpeta.</p>
      <Button size="sm" variant="ghost" className="mt-2" onClick={dismissMusicSummary}>
        Cerrar resumen
      </Button>
    </section>
  );
}

export function MusicLibrary() {
  const tracks = useMusicStore((s) => s.tracks);
  const status = useMusicStore((s) => s.status);
  const error = useMusicStore((s) => s.error);
  const importing = useMusicStore((s) => s.importing);
  const [renaming, setRenaming] = useState<MusicTrack | null>(null);
  const [removing, setRemoving] = useState<MusicTrack | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [previewId, setPreviewId] = useState<Id | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadMusic();
  }, []);

  const stopPreview = (): void => {
    if (stopTimer.current !== null) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setPreviewId(null);
  };

  // Al salir de la pantalla (o bloquear) no queda nada sonando.
  useEffect(
    () => () => {
      if (stopTimer.current !== null) clearTimeout(stopTimer.current);
      audioRef.current?.pause();
    },
    [],
  );

  const togglePreview = (track: MusicTrack): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (previewId === track.id) return stopPreview();
    stopPreview();
    audio.src = musicUrl(track.id);
    const start = previewStartSeconds(track.durationMs);
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (start > 0) audio.currentTime = start;
      },
      { once: true },
    );
    setPreviewId(track.id);
    audio.play().then(
      () => {
        stopTimer.current = setTimeout(stopPreview, PREVIEW_MS);
      },
      (err: unknown) => {
        // AbortError: el usuario paró o cambió de pista antes de que empezara a sonar.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        toast('No se pudo reproducir esa pista.', 'error');
        stopPreview();
      },
    );
  };

  const confirmRemove = async (): Promise<void> => {
    if (!removing) return;
    setRemoveBusy(true);
    if (previewId === removing.id) stopPreview();
    await deleteTrack(removing);
    setRemoveBusy(false);
    setRemoving(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col items-start gap-3" aria-labelledby="music-heading">
        <h2 id="music-heading" className="text-lg font-semibold text-text">
          Biblioteca de música
        </h2>
        <p
          role="note"
          className="max-w-prose rounded-md border border-warning bg-surface p-3 text-sm text-text"
        >
          <strong>{MUSIC_UNENCRYPTED_NOTICE}</strong> La copia queda en la carpeta de música de este
          perfil con un nombre neutro, así que cualquiera con acceso a esa carpeta podrá escucharla.
          Es una copia idéntica: conserva las etiquetas del archivo (título, artista, portada), que
          también se pueden leer. Los títulos de Galería y las playlists que la usan sí van
          cifrados.
        </p>
        <Button
          variant="primary"
          disabled={importing}
          aria-busy={importing || undefined}
          onClick={() => void importMusic()}
        >
          <Upload aria-hidden="true" size={16} strokeWidth={1.75} />
          {importing ? 'Importando…' : 'Importar música…'}
        </Button>
        <ImportSummary />
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="music-tracks-heading">
        <h2 id="music-tracks-heading" className="text-lg font-semibold text-text">
          Pistas
        </h2>
        {status === 'error' ? (
          <p role="alert" className="text-sm text-danger-text">
            {errorMessage(error)}
          </p>
        ) : status !== 'ready' ? (
          <p role="status" className="text-sm text-text-muted">
            Cargando…
          </p>
        ) : tracks.length === 0 ? (
          <p className="max-w-prose text-sm text-text-muted">
            Todavía no has importado música. Elige archivos MP3, M4A, AAC, Ogg, Opus, FLAC o WAV.
          </p>
        ) : (
          <ul aria-label="Pistas de música" className="flex max-w-3xl flex-col gap-1">
            {tracks.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
              >
                <Music aria-hidden="true" size={18} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">{t.title}</p>
                  <p className="text-xs text-text-muted">
                    {t.durationMs === null ? 'Duración desconocida' : formatDuration(t.durationMs)}
                    {' · '}
                    {formatBytes(t.sizeBytes)}
                  </p>
                </div>
                <IconButton
                  label={
                    previewId === t.id
                      ? `Parar el fragmento de «${t.title}»`
                      : `Escuchar un fragmento de «${t.title}»`
                  }
                  icon={previewId === t.id ? Pause : Play}
                  aria-pressed={previewId === t.id}
                  onClick={() => togglePreview(t)}
                />
                <IconButton
                  label={`Renombrar «${t.title}»`}
                  icon={Pencil}
                  onClick={() => setRenaming(t)}
                />
                <IconButton
                  label={`Eliminar «${t.title}»`}
                  icon={Trash2}
                  onClick={() => setRemoving(t)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Solo para la vista previa: sin controles, sin conexión a Web Audio. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- solo música, sin texto que subtitular */}
      <audio ref={audioRef} preload="none" onEnded={stopPreview} className="hidden" />

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Renombrar pista"
        description="El título es solo para ti: el archivo copiado conserva su nombre neutro."
      >
        {renaming ? (
          <RenameTrackForm key={renaming.id} track={renaming} onDone={() => setRenaming(null)} />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Eliminar pista"
        description={
          removing
            ? `Se eliminará «${removing.title}» de la biblioteca, de las playlists que la usan y su copia en la carpeta de música. El archivo original no se toca.`
            : ''
        }
        confirmLabel="Eliminar pista"
        danger
        busy={removeBusy}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}
