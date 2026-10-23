// Administrar perfiles (docs/DESIGN.md §14.4): cada perfil con "Editar", "Cambiar contraseña" y
// "Eliminar" (las tres piden la contraseña del perfil), más "Añadir perfil" y "Listo".
import { useCallback, useRef, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash } from 'lucide-react';
import { MAX_PROFILES } from '@shared/constants';
import type { Id, ProfileSummary } from '@shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { ScreenHeading } from '../../components/ScreenHeading';
import { useScreenFocus } from '../../lib/focus';
import { useNavStore } from '../../stores/nav-store';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { DeleteProfileDialog } from './DeleteProfileDialog';

export interface ManageProfilesProps {
  profiles: ProfileSummary[];
  /** Al volver de editar, el foco va al "Editar" de ese perfil. */
  focusProfileId?: Id;
}

export function ManageProfiles({ profiles, focusProfileId }: ManageProfilesProps) {
  const [changing, setChanging] = useState<ProfileSummary | null>(null);
  const [deleting, setDeleting] = useState<ProfileSummary | null>(null);
  const editButtons = useRef(new Map<Id, HTMLButtonElement>());
  const doneRef = useRef<HTMLButtonElement>(null);

  const focusTarget = useCallback(
    () => (focusProfileId ? editButtons.current.get(focusProfileId) : null),
    [focusProfileId],
  );
  useScreenFocus(focusTarget);

  const nav = useNavStore.getState;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-auto px-8 py-10">
      <ScreenHeading takeFocus={!focusProfileId} className="text-3xl text-text">
        Administrar perfiles
      </ScreenHeading>
      {profiles.length === 0 ? (
        <p className="text-text-muted">No hay perfiles.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-4 rounded-lg border border-border bg-surface p-3"
            >
              <Avatar source={{ kind: 'ref', profileId: p.id, avatar: p.avatar }} size={56} />
              <span className="min-w-0 flex-1 truncate text-lg font-medium text-text">
                {p.name}
              </span>
              <Button
                ref={(el) => {
                  if (el) editButtons.current.set(p.id, el);
                  else editButtons.current.delete(p.id);
                }}
                aria-label={`Editar ${p.name}`}
                onClick={() => nav().showProfiles({ name: 'edit', profileId: p.id })}
              >
                <Pencil aria-hidden="true" size={16} />
                Editar
              </Button>
              <Button aria-label={`Cambiar contraseña de ${p.name}`} onClick={() => setChanging(p)}>
                <KeyRound aria-hidden="true" size={16} />
                Cambiar contraseña
              </Button>
              <Button
                variant="danger-ghost"
                aria-label={`Eliminar ${p.name}`}
                onClick={() => setDeleting(p)}
              >
                <Trash aria-hidden="true" size={16} />
                Eliminar
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-3">
        {profiles.length < MAX_PROFILES ? (
          <Button onClick={() => nav().showProfiles({ name: 'create' })}>
            <Plus aria-hidden="true" size={16} />
            Añadir perfil
          </Button>
        ) : null}
        <Button
          ref={doneRef}
          variant="primary"
          onClick={() => nav().showProfiles({ name: 'picker' })}
        >
          Listo
        </Button>
      </div>
      <ChangePasswordDialog profile={changing} onClose={() => setChanging(null)} />
      <DeleteProfileDialog
        profile={deleting}
        onClose={(deleted) => {
          setDeleting(null);
          // El botón que abrió el diálogo ya no existe: el foco va a "Listo".
          if (deleted) requestAnimationFrame(() => doneRef.current?.focus());
        }}
      />
    </div>
  );
}
