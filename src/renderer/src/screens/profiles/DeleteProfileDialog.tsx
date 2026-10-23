// Eliminar un perfil (docs/DESIGN.md §14.4, anexo §1): exige SIEMPRE la contraseña del perfil y
// escribir su nombre. "Eliminar perfil" solo se habilita con los dos campos rellenos y el foco
// inicial está en "Cancelar". No hay ninguna otra forma de borrar un perfil desde la app.
// Si quedan restos (`leftoverPath`, [H3-8]), se muestra su ruta seleccionable para borrarlos a mano.
import { useRef, useState } from 'react';
import type { AppError } from '@shared/errors';
import type { ProfileSummary } from '@shared/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PasswordField } from '../../components/PasswordField';
import { TextField } from '../../components/TextField';
import { announce } from '../../lib/announce';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { passwordBytes } from '../../lib/password';
import { toast } from '../../lib/toast';
import { refreshProfiles } from '../../stores/session-store';

export interface DeleteProfileDialogProps {
  /** null = cerrado. */
  profile: ProfileSummary | null;
  onClose(deleted: boolean): void;
}

function DeleteProfileContent({
  profile,
  onClose,
}: {
  profile: ProfileSummary;
  onClose(deleted: boolean): void;
}) {
  const [password, setPassword] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [leftoverPath, setLeftoverPath] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const wrong = error?.code === 'WRONG_PASSWORD';
  const nameMismatch = error?.code === 'VALIDATION' && error.details?.reason === 'confirm-name';

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const bytes = passwordBytes(password);
    const res = await invoke('profiles:delete', {
      profileId: profile.id,
      password: bytes,
      confirmName,
    });
    bytes.fill(0);
    setBusy(false);
    if (res.ok) {
      setPassword('');
      await refreshProfiles();
      if (res.data.leftoverPath === null) {
        toast(`Se eliminó el perfil «${profile.name}».`);
        onClose(true);
      } else {
        setLeftoverPath(res.data.leftoverPath);
      }
      return;
    }
    setError(res.error);
    announce(errorMessage(res.error), res.error.code === 'WRONG_PASSWORD' ? 'assertive' : 'polite');
    if (res.error.code === 'WRONG_PASSWORD') {
      passwordRef.current?.focus();
      passwordRef.current?.select();
    }
  };

  if (leftoverPath !== null) {
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose(true);
        }}
        title={`Se eliminó «${profile.name}»`}
        description="El perfil y su bóveda ya no se pueden abrir, pero quedaron algunos archivos que no son de Galería. Puedes borrarlos a mano en esta carpeta:"
        confirmLabel="Cerrar"
        cancelLabel="Cerrar"
      >
        <code className="rounded-md bg-surface p-3 font-mono text-sm break-all text-text select-all">
          {leftoverPath}
        </code>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title={`Eliminar «${profile.name}»`}
      description={`Se borrarán para siempre todas las fotos, vídeos, playlists y música de «${profile.name}». No se puede deshacer.`}
      confirmLabel="Eliminar perfil"
      danger
      busy={busy}
      confirmDisabled={password.length === 0 || confirmName.trim().length === 0}
      onConfirm={() => void confirm()}
    >
      <PasswordField
        ref={passwordRef}
        label="Contraseña del perfil"
        value={password}
        onValueChange={(v) => {
          setPassword(v);
          if (wrong) setError(null);
        }}
        readOnly={busy}
        error={wrong ? errorMessage(error) : null}
      />
      <TextField
        label="Escribe el nombre del perfil para confirmar"
        value={confirmName}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setConfirmName(e.target.value);
          if (nameMismatch) setError(null);
        }}
        readOnly={busy}
        error={nameMismatch ? errorMessage(error) : null}
      />
      {error && !wrong && !nameMismatch ? (
        <p role="alert" className="text-sm text-danger-text">
          {errorMessage(error)}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-text-muted">
          Eliminando…
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

export function DeleteProfileDialog({ profile, onClose }: DeleteProfileDialogProps) {
  if (!profile) return null;
  return <DeleteProfileContent key={profile.id} profile={profile} onClose={onClose} />;
}
