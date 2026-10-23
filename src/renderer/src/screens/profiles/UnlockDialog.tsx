// Desbloqueo (docs/DESIGN.md §14.3): avatar y nombre, contraseña con foco automático, "Mostrar",
// "Entrar" y "Cancelar". Enter envía; mientras se calcula Argon2, "Comprobando…" con aria-busy (y no
// se puede cerrar: el resultado llegaría con el diálogo cerrado). No hay ningún enlace para
// recuperar la contraseña.
import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { motion } from 'motion/react';
import type { AppError } from '@shared/errors';
import type { ProfileSummary } from '@shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { PasswordField } from '../../components/PasswordField';
import { announce } from '../../lib/announce';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { passwordBytes } from '../../lib/password';
import { useSessionStore } from '../../stores/session-store';

export interface UnlockDialogProps {
  /** null = cerrado. */
  profile: ProfileSummary | null;
  onClose(): void;
  /** Al cerrar, el foco vuelve al avatar (§14.2). */
  onReturnFocus(): void;
}

function UnlockForm({
  profile,
  inputRef,
  busy,
  setBusy,
  onCancel,
}: {
  profile: ProfileSummary;
  inputRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  setBusy(busy: boolean): void;
  onCancel(): void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<AppError | null>(null);

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    const bytes = passwordBytes(password);
    const res = await invoke('session:unlock', { profileId: profile.id, password: bytes });
    bytes.fill(0);
    if (res.ok) {
      setPassword('');
      useSessionStore.getState().setUnlocked(res.data.profile, res.data.prefs);
      return;
    }
    setBusy(false);
    setError(res.error);
    if (res.error.code === 'WRONG_PASSWORD') announce(errorMessage(res.error), 'assertive');
    else announce(errorMessage(res.error), 'polite');
    // El texto queda seleccionado para volver a escribirlo (§14.3).
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const wrong = error?.code === 'WRONG_PASSWORD';
  const vaultPath =
    error?.code === 'VAULT_UNAVAILABLE' && typeof error.details?.path === 'string'
      ? error.details.path
      : null;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-busy={busy || undefined}
      className="mt-5 flex flex-col gap-4"
    >
      <PasswordField
        ref={inputRef}
        label="Contraseña"
        value={password}
        onValueChange={setPassword}
        readOnly={busy}
        error={wrong ? errorMessage(error) : null}
      />
      {error && !wrong ? (
        <div className="rounded-md border border-danger-text bg-surface p-3 text-sm text-text">
          <p>{errorMessage(error)}</p>
          {vaultPath ? (
            <p className="mt-2">
              Ruta de la bóveda:{' '}
              <code className="font-mono break-all text-text select-all">{vaultPath}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-text-muted">
          Comprobando…
        </p>
      ) : null}
      <div className="mt-1 flex justify-end gap-3">
        <Button onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        {/* "Buscar la bóveda…" llega en la Fase 2 (vault:locate, 2.11). */}
        <Button type="submit" variant="primary" disabled={busy || password.length === 0}>
          {busy ? 'Comprobando…' : vaultPath ? 'Reintentar' : 'Entrar'}
        </Button>
      </div>
    </form>
  );
}

export function UnlockDialog({ profile, onClose, onReturnFocus }: UnlockDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={profile !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={busy}
      title={profile?.name ?? ''}
      description="Escribe la contraseña para abrir tu bóveda."
      className="w-[min(26rem,calc(100vw-2rem))] text-center"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        inputRef.current?.focus();
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        onReturnFocus();
      }}
      header={
        profile ? (
          <motion.div layoutId={`avatar-${profile.id}`} className="mx-auto mb-3 w-fit">
            <Avatar
              source={{ kind: 'ref', profileId: profile.id, avatar: profile.avatar }}
              size={96}
            />
          </motion.div>
        ) : null
      }
    >
      {profile ? (
        <div className="text-left">
          <UnlockForm
            key={profile.id}
            profile={profile}
            inputRef={inputRef}
            busy={busy}
            setBusy={setBusy}
            onCancel={onClose}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
