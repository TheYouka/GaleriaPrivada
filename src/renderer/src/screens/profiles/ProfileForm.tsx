// Crear y editar un perfil (docs/DESIGN.md §14.4).
//   - Crear: nombre, avatar, contraseña dos veces, el aviso destacado de que no hay forma de
//     recuperar la contraseña y la casilla obligatoria. "Crear perfil" queda deshabilitado hasta que
//     todo es válido; durante profiles:create, "Preparando tu bóveda…" con aria-busy. Al terminar se
//     vuelve al selector con el foco en el avatar nuevo.
//   - Editar: nombre y avatar; exige la contraseña del perfil (D14).
import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Checkbox } from 'radix-ui';
import type { AppError } from '@shared/errors';
import type { AvatarInput, ProfileSummary } from '@shared/types';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/PasswordField';
import { ScreenHeading } from '../../components/ScreenHeading';
import { TextField } from '../../components/TextField';
import { announce } from '../../lib/announce';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import {
  codePointLength,
  NAME_ISSUE_MESSAGES,
  normalizeName,
  PASSWORD_ISSUE_MESSAGES,
  passwordBytes,
  passwordIssue,
  profileNameIssue,
} from '../../lib/password';
import { useNavStore } from '../../stores/nav-store';
import { refreshProfiles } from '../../stores/session-store';
import { AvatarChooser, type AvatarChoice } from './AvatarChooser';

export type ProfileFormMode = { kind: 'create' } | { kind: 'edit'; profile: ProfileSummary };

function initialChoice(profile: ProfileSummary | null): AvatarChoice {
  if (!profile) return { kind: 'builtin', id: 'aurora' };
  return profile.avatar.type === 'builtin'
    ? { kind: 'builtin', id: profile.avatar.id }
    : { kind: 'current' };
}

function toInput(choice: AvatarChoice): AvatarInput | null {
  if (choice.kind === 'builtin') return { type: 'builtin', id: choice.id };
  if (choice.kind === 'photo') return { type: 'custom', token: choice.token };
  return null;
}

function sameAvatar(choice: AvatarChoice, profile: ProfileSummary): boolean {
  if (choice.kind === 'current') return true;
  return (
    choice.kind === 'builtin' &&
    profile.avatar.type === 'builtin' &&
    profile.avatar.id === choice.id
  );
}

export function ProfileForm({ mode }: { mode: ProfileFormMode }) {
  const editing = mode.kind === 'edit' ? mode.profile : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [avatar, setAvatar] = useState<AvatarChoice>(() => initialChoice(editing));
  const [photoToken, setPhotoToken] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const nameIssue = profileNameIssue(name);
  const pwIssue = passwordIssue(password);
  const mismatch = repeat.length > 0 && repeat !== password;
  const nameTaken = error?.code === 'PROFILE_NAME_TAKEN';
  const wrongPassword = error?.code === 'WRONG_PASSWORD';

  const changed =
    editing !== null && (normalizeName(name) !== editing.name || !sameAvatar(avatar, editing));
  const valid = editing
    ? nameIssue === null && currentPassword.length > 0 && changed
    : nameIssue === null && pwIssue === null && repeat === password && acknowledged;

  const back = (): void => {
    const nav = useNavStore.getState();
    if (editing) nav.showProfiles({ name: 'manage', focusProfileId: editing.id });
    else nav.showProfiles({ name: 'picker' });
  };

  const pickPhoto = async (): Promise<void> => {
    setPicking(true);
    setPhotoError(null);
    const res = await invoke('profiles:pickAvatarPhoto');
    setPicking(false);
    if (!res.ok) {
      setPhotoError(errorMessage(res.error));
      return;
    }
    if (res.data) {
      setPhotoToken(res.data.token);
      setAvatar({ kind: 'photo', token: res.data.token });
    }
  };

  const fail = (err: AppError): void => {
    setBusy(false);
    setError(err);
    announce(errorMessage(err), err.code === 'WRONG_PASSWORD' ? 'assertive' : 'polite');
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    if (editing) {
      const bytes = passwordBytes(currentPassword);
      const newName = normalizeName(name);
      const input = sameAvatar(avatar, editing) ? null : toInput(avatar);
      const res = await invoke('profiles:update', {
        profileId: editing.id,
        password: bytes,
        ...(newName !== editing.name ? { name: newName } : {}),
        ...(input ? { avatar: input } : {}),
      });
      bytes.fill(0);
      if (res.ok) {
        await refreshProfiles();
        useNavStore.getState().showProfiles({ name: 'manage', focusProfileId: editing.id });
        return;
      }
      fail(res.error);
      return;
    }
    const bytes = passwordBytes(password);
    const res = await invoke('profiles:create', {
      name: normalizeName(name),
      avatar: toInput(avatar) ?? { type: 'builtin', id: 'aurora' },
      password: bytes,
      acknowledgeNoRecovery: true,
    });
    bytes.fill(0);
    if (res.ok) {
      await refreshProfiles();
      useNavStore.getState().showProfiles({ name: 'picker', focusProfileId: res.data.id });
      return;
    }
    fail(res.error);
  };

  const length = codePointLength(password);
  const nameError = nameTaken
    ? errorMessage(error)
    : nameTouched && nameIssue
      ? NAME_ISSUE_MESSAGES[nameIssue]
      : null;
  const formError = error && !nameTaken && !wrongPassword ? errorMessage(error) : null;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-busy={busy || undefined}
      noValidate
      className="mx-auto grid h-full max-w-5xl auto-rows-min grid-cols-2 gap-x-12 gap-y-6 overflow-auto px-10 py-8"
    >
      <div className="col-span-2">
        <ScreenHeading className="text-3xl">
          {editing ? `Editar «${editing.name}»` : 'Crear perfil'}
        </ScreenHeading>
      </div>

      <div className="flex flex-col gap-6">
        <TextField
          label="Nombre"
          value={name}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            if (nameTaken) setError(null);
          }}
          onBlur={() => setNameTouched(true)}
          error={nameError}
          readOnly={busy}
        />
        <AvatarChooser
          value={avatar}
          onChange={setAvatar}
          current={
            editing && editing.avatar.type === 'custom'
              ? { profileId: editing.id, rev: editing.avatar.rev }
              : null
          }
          photoToken={photoToken}
          onPickPhoto={() => void pickPhoto()}
          picking={picking || busy}
          photoError={photoError}
        />
      </div>

      <div className="flex flex-col gap-5">
        {editing ? (
          <PasswordField
            label="Contraseña del perfil"
            value={currentPassword}
            onValueChange={(v) => {
              setCurrentPassword(v);
              if (wrongPassword) setError(null);
            }}
            readOnly={busy}
            hint="Para editar el perfil hace falta su contraseña."
            error={wrongPassword ? errorMessage(error) : null}
          />
        ) : (
          <>
            <PasswordField
              label="Contraseña"
              autoComplete="new-password"
              value={password}
              onValueChange={setPassword}
              onBlur={() => setPasswordTouched(true)}
              readOnly={busy}
              hint={`${length} ${length === 1 ? 'carácter' : 'caracteres'} (mínimo 8)`}
              error={passwordTouched && pwIssue ? PASSWORD_ISSUE_MESSAGES[pwIssue] : null}
            />
            <PasswordField
              label="Repetir contraseña"
              autoComplete="new-password"
              value={repeat}
              onValueChange={setRepeat}
              readOnly={busy}
              error={mismatch ? 'Las contraseñas no coinciden' : null}
            />
            <div
              role="note"
              className="flex gap-3 rounded-md border-2 border-warning bg-surface p-4 text-sm text-text"
            >
              <TriangleAlert
                aria-hidden="true"
                size={22}
                className="mt-0.5 shrink-0 text-warning"
              />
              <p>
                <strong>No hay forma de recuperar la contraseña.</strong> Si la olvidas, nadie podrá
                descifrar tus fotos y vídeos: ni tú, ni otra persona, ni el desarrollador. Galería
                tampoco tiene función de exportar.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox.Root
                id="acknowledge-no-recovery"
                checked={acknowledged}
                onCheckedChange={(c) => setAcknowledged(c === true)}
                disabled={busy}
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border-2 border-border-strong bg-surface data-[state=checked]:border-accent data-[state=checked]:bg-accent"
              >
                <Checkbox.Indicator className="text-on-accent">
                  <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
                    <path
                      d="M3 8.5L6.5 12 13 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    />
                  </svg>
                </Checkbox.Indicator>
              </Checkbox.Root>
              <label htmlFor="acknowledge-no-recovery" className="text-sm text-text">
                Entiendo que si olvido la contraseña perderé el acceso para siempre
              </label>
            </div>
          </>
        )}
        {formError ? (
          <p role="alert" className="text-sm text-danger-text">
            {formError}
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm text-text-muted">
            {editing ? 'Guardando…' : 'Preparando tu bóveda…'}
          </p>
        ) : null}
      </div>

      <div className="col-span-2 flex justify-end gap-3 pb-2">
        <Button onClick={back} disabled={busy}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={!valid || busy}>
          {busy
            ? editing
              ? 'Guardando…'
              : 'Preparando tu bóveda…'
            : editing
              ? 'Guardar cambios'
              : 'Crear perfil'}
        </Button>
      </div>
    </form>
  );
}
