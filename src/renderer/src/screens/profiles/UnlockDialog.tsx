// Desbloqueo (docs/DESIGN.md §14.3): avatar y nombre, contraseña con foco automático, "Mostrar",
// "Entrar" y "Cancelar". Enter envía; mientras se calcula Argon2, "Comprobando…" con aria-busy (y no
// se puede cerrar: el resultado llegaría con el diálogo cerrado). Con VAULT_UNAVAILABLE, la ruta,
// "Reintentar" y "Buscar la bóveda…" (vault:locate, §8.7). No hay ningún enlace para recuperar la
// contraseña. En Cristal (selector `login`) el mismo formulario va en línea bajo el avatar (InlineUnlock).
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
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
import { refreshProfiles, useSessionStore } from '../../stores/session-store';

export interface UnlockDialogProps {
  /** null = cerrado. */
  profile: ProfileSummary | null;
  onClose(): void;
  /** Al cerrar, el foco vuelve al avatar (§14.2). */
  onReturnFocus(): void;
}

export function UnlockForm({
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
  const [locating, setLocating] = useState(false);
  /** Resultado de "Buscar la bóveda…" (§8.7): encontrada, o la carpeta no era la bóveda. */
  const [located, setLocated] = useState<'found' | 'rejected' | null>(null);

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (busy || locating || password.length === 0) return;
    setBusy(true);
    setError(null);
    setLocated(null);
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

  /** vault:locate: diálogo de carpeta en main; el renderer no envía ninguna ruta [H3-8]. */
  const locate = async (): Promise<void> => {
    if (busy || locating) return;
    setLocating(true);
    const res = await invoke('vault:locate', { profileId: profile.id });
    setLocating(false);
    if (res.ok) {
      if (!res.data) return; // diálogo cancelado
      setError(null);
      setLocated('found');
      announce('Bóveda encontrada. Escribe la contraseña para entrar.', 'polite');
      void refreshProfiles();
      inputRef.current?.focus();
      return;
    }
    if (res.error.code === 'VAULT_UNAVAILABLE') {
      // La ruta configurada sigue siendo la misma: se muestra la de la respuesta.
      setError(res.error);
      setLocated('rejected');
      announce('Esa carpeta no es la bóveda de este perfil.', 'polite');
      return;
    }
    setError(res.error);
    setLocated(null);
    announce(errorMessage(res.error), 'polite');
  };

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
          {located === 'rejected' ? (
            <p className="mt-2">Esa carpeta no es la bóveda de este perfil.</p>
          ) : null}
          {vaultPath ? (
            <p className="mt-2">
              Ruta de la bóveda:{' '}
              <code className="font-mono break-all text-text select-all">{vaultPath}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      {located === 'found' && !error ? (
        <p className="rounded-md border border-border-strong bg-surface p-3 text-sm text-text">
          Bóveda encontrada. Escribe la contraseña para entrar.
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-text-muted">
          Comprobando…
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap justify-end gap-3">
        <Button onClick={onCancel} disabled={busy || locating}>
          Cancelar
        </Button>
        {vaultPath ? (
          <Button onClick={() => void locate()} disabled={busy || locating}>
            {locating ? 'Buscando…' : 'Buscar la bóveda…'}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || locating || password.length === 0}
        >
          {busy ? 'Comprobando…' : vaultPath ? 'Reintentar' : 'Entrar'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Desbloqueo en línea bajo el avatar elegido (selector `login` de Cristal, §14.3 / §15.10). Es el
 * mismo formulario del diálogo (envío, errores, «Comprobando…», «Buscar la bóveda…»), sin modal: el
 * foco va a la contraseña, Esc cierra (salvo mientras se comprueba) y las teclas no llegan a la lista
 * de perfiles, así que ←/→/Inicio/Fin editan el texto en vez de mover el foco.
 */
export function InlineUnlock({ profile, onClose }: { profile: ProfileSummary; onClose(): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    // El contenedor solo intercepta el teclado de sus hijos (campo y botones, que son los controles).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={`Contraseña de ${profile.name}`}
      className="g-unlock-inline mt-2 w-full text-left"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && !busy) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <UnlockForm
        profile={profile}
        inputRef={inputRef}
        busy={busy}
        setBusy={setBusy}
        onCancel={onClose}
      />
    </div>
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
      className="g-unlock w-[min(26rem,calc(100vw-2rem))] text-center"
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
