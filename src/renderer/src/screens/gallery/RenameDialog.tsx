// Renombrar un medio (docs/DESIGN.md §14.6): diálogo con el nombre actual (sin la extensión, que se
// muestra aparte) y validación de §10.3 (1–255 caracteres, sin caracteres de control). Enter guarda.
// El foco vuelve a la celda de la rejilla al cerrar (Radix devuelve el foco al elemento anterior).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppError } from '@shared/errors';
import type { MediaListItem } from '@shared/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { FIELD_INPUT_CLASS } from '../../components/TextField';
import { errorMessage } from '../../lib/errors-es';
import { cancelRename, renameItem, useLibraryStore } from '../../stores/library-store';
import { focusGalleryCell } from './gallery-focus';
import { renameProblem } from './rename-name';

function RenameForm({ item }: { item: MediaListItem }) {
  const [name, setName] = useState(item.name);
  const [error, setError] = useState<AppError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Nombre seleccionado entero al abrir: escribir lo sustituye.
    inputRef.current?.select();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const problem = renameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    const failure = await renameItem(item.id, name);
    setBusy(false);
    if (failure) setError(failure);
  };

  const message = typeof error === 'string' ? error : error ? errorMessage(error) : null;
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rename-input" className="text-sm font-medium text-text">
          Nombre
        </label>
        <div className="flex items-center gap-2">
          <input
            id="rename-input"
            ref={inputRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? 'rename-error' : 'rename-ext'}
            autoComplete="off"
            spellCheck={false}
            className={FIELD_INPUT_CLASS}
          />
          <span id="rename-ext" className="shrink-0 text-sm text-text-muted">
            {item.ext ? `.${item.ext}` : ''}
          </span>
        </div>
        {message ? (
          <p id="rename-error" role="alert" className="text-sm text-danger-text">
            {message}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-3">
        <Button disabled={busy} onClick={cancelRename}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Guardar
        </Button>
      </div>
    </form>
  );
}

export function RenameDialog() {
  const target = useLibraryStore((s) => s.renameTarget);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) cancelRename();
      }}
      title="Renombrar"
      onCloseAutoFocus={(e) => {
        if (focusGalleryCell()) e.preventDefault();
      }}
      description="El nombre es solo para ti: no cambia el archivo que hay dentro de la bóveda."
    >
      {target ? <RenameForm key={target.id} item={target} /> : null}
    </Dialog>
  );
}
