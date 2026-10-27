// Diálogos de playlists (docs/DESIGN.md §14.8), montados una sola vez en UnlockedApp para que sirvan
// desde la galería ("Nueva playlist…" en la barra de selección) y desde la pantalla Playlists:
//  - nombre: crear (1–100 caracteres; con elementos seleccionados, también los añade) o renombrar;
//  - eliminar: AlertDialog con el foco inicial en "Cancelar"; borra la playlist, nunca los medios.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppError } from '@shared/errors';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { FIELD_INPUT_CLASS } from '../../components/TextField';
import { errorMessage } from '../../lib/errors-es';
import {
  closePlaylistDialog,
  confirmDeletePlaylist,
  plural,
  submitPlaylistName,
  usePlaylistsStore,
  type PlaylistDialog,
} from '../../stores/playlists-store';
import { playlistNameProblem } from './playlist-order';

function NameForm({ dialog }: { dialog: Exclude<PlaylistDialog, { kind: 'delete' }> }) {
  const [name, setName] = useState(dialog.kind === 'rename' ? dialog.playlist.name : '');
  const [error, setError] = useState<AppError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const problem = playlistNameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    const failure = await submitPlaylistName(name);
    setBusy(false);
    if (failure) setError(failure);
  };

  const message = typeof error === 'string' ? error : error ? errorMessage(error) : null;
  const adding = dialog.kind === 'create' ? dialog.mediaIds.length : 0;
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="playlist-name-input" className="text-sm font-medium text-text">
          Nombre
        </label>
        <input
          id="playlist-name-input"
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? 'playlist-name-error' : undefined}
          autoComplete="off"
          spellCheck={false}
          className={FIELD_INPUT_CLASS}
        />
        {message ? (
          <p id="playlist-name-error" role="alert" className="text-sm text-danger-text">
            {message}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-3">
        <Button disabled={busy} onClick={closePlaylistDialog}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {dialog.kind === 'rename'
            ? 'Guardar'
            : adding > 0
              ? `Crear y añadir ${plural(adding, 'elemento', 'elementos')}`
              : 'Crear'}
        </Button>
      </div>
    </form>
  );
}

export function PlaylistDialogs() {
  const dialog = usePlaylistsStore((s) => s.dialog);
  const deleting = usePlaylistsStore((s) => s.deleting);
  const nameDialog = dialog && dialog.kind !== 'delete' ? dialog : null;
  const deleteTarget = dialog?.kind === 'delete' ? dialog.playlist : null;
  return (
    <>
      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) closePlaylistDialog();
        }}
        title={nameDialog?.kind === 'rename' ? 'Renombrar playlist' : 'Nueva playlist'}
        description={
          nameDialog?.kind === 'rename'
            ? 'El nombre se guarda cifrado dentro de la bóveda.'
            : 'El nombre se guarda cifrado dentro de la bóveda. Puedes repetir nombres.'
        }
      >
        {nameDialog ? (
          <NameForm
            key={nameDialog.kind === 'rename' ? nameDialog.playlist.id : 'create'}
            dialog={nameDialog}
          />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) closePlaylistDialog();
        }}
        title="Eliminar playlist"
        description={
          deleteTarget
            ? `Se eliminará la playlist «${deleteTarget.name}». Las fotos y los vídeos no se borran: siguen en la galería.`
            : ''
        }
        confirmLabel="Eliminar playlist"
        danger
        busy={deleting}
        onConfirm={() => void confirmDeletePlaylist()}
      />
    </>
  );
}
