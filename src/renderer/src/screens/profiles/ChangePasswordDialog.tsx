// Cambiar la contraseña (docs/DESIGN.md §6.6 y §14.4): actual, nueva y repetir, con la nota sobre
// las copias antiguas. Solo vuelve a envolver la clave maestra: es instantáneo.
import { useRef, useState, type FormEvent } from 'react';
import type { AppError } from '@shared/errors';
import type { ProfileSummary } from '@shared/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { PasswordField } from '../../components/PasswordField';
import { announce } from '../../lib/announce';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import {
  codePointLength,
  PASSWORD_ISSUE_MESSAGES,
  passwordBytes,
  passwordIssue,
} from '../../lib/password';
import { toast } from '../../lib/toast';

export interface ChangePasswordDialogProps {
  /** null = cerrado. */
  profile: ProfileSummary | null;
  onClose(): void;
}

function ChangePasswordForm({
  profile,
  busy,
  setBusy,
  onDone,
}: {
  profile: ProfileSummary;
  busy: boolean;
  setBusy(busy: boolean): void;
  onDone(): void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const currentRef = useRef<HTMLInputElement>(null);

  const issue = passwordIssue(next);
  const mismatch = repeat.length > 0 && repeat !== next;
  const valid = current.length > 0 && issue === null && repeat === next;
  const wrong = error?.code === 'WRONG_PASSWORD';
  const length = codePointLength(next);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const currentPassword = passwordBytes(current);
    const newPassword = passwordBytes(next);
    const res = await invoke('profiles:changePassword', {
      profileId: profile.id,
      currentPassword,
      newPassword,
    });
    currentPassword.fill(0);
    newPassword.fill(0);
    setBusy(false);
    if (res.ok) {
      toast('Contraseña cambiada.');
      onDone();
      return;
    }
    setError(res.error);
    announce(errorMessage(res.error), res.error.code === 'WRONG_PASSWORD' ? 'assertive' : 'polite');
    if (res.error.code === 'WRONG_PASSWORD') {
      currentRef.current?.focus();
      currentRef.current?.select();
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-busy={busy || undefined}
      noValidate
      className="mt-5 flex flex-col gap-4"
    >
      <PasswordField
        ref={currentRef}
        label="Contraseña actual"
        value={current}
        onValueChange={(v) => {
          setCurrent(v);
          if (wrong) setError(null);
        }}
        readOnly={busy}
        error={wrong ? errorMessage(error) : null}
      />
      <PasswordField
        label="Nueva contraseña"
        autoComplete="new-password"
        value={next}
        onValueChange={setNext}
        onBlur={() => setTouched(true)}
        readOnly={busy}
        hint={`${length} ${length === 1 ? 'carácter' : 'caracteres'} (mínimo 8)`}
        error={touched && issue ? PASSWORD_ISSUE_MESSAGES[issue] : null}
      />
      <PasswordField
        label="Repetir la nueva contraseña"
        autoComplete="new-password"
        value={repeat}
        onValueChange={setRepeat}
        readOnly={busy}
        error={mismatch ? 'Las contraseñas no coinciden' : null}
      />
      <p className="rounded-md border border-border bg-surface-2 p-3 text-sm text-text-muted">
        El cambio es instantáneo: tus fotos y vídeos no se vuelven a cifrar. La clave de la bóveda
        no cambia, así que quien tenga una copia antigua de los datos del perfil y conozca la
        contraseña antigua podría seguir abriéndola.
      </p>
      {error && !wrong ? (
        <p role="alert" className="text-sm text-danger-text">
          {errorMessage(error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <Button onClick={onDone} disabled={busy}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!valid || busy}>
          {busy ? 'Cambiando…' : 'Cambiar contraseña'}
        </Button>
      </div>
    </form>
  );
}

export function ChangePasswordDialog({ profile, onClose }: ChangePasswordDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={profile !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={busy}
      title="Cambiar contraseña"
      description={profile ? `Perfil «${profile.name}»` : undefined}
    >
      {profile ? (
        <ChangePasswordForm
          key={profile.id}
          profile={profile}
          busy={busy}
          setBusy={setBusy}
          onDone={onClose}
        />
      ) : null}
    </Dialog>
  );
}
