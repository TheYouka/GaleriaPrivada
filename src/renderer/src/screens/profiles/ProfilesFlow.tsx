// Pantallas con la bóveda bloqueada (docs/DESIGN.md §14.2–§14.4): bienvenida sin perfiles, selector,
// administrar, crear y editar. Solo ven datos en claro de profiles.json (nombre y avatar).
import { useEffect } from 'react';
import { Button } from '../../components/Button';
import { ScreenHeading } from '../../components/ScreenHeading';
import { errorMessage } from '../../lib/errors-es';
import { useNavStore } from '../../stores/nav-store';
import { refreshProfiles, useSessionStore } from '../../stores/session-store';
import { ManageProfiles } from './ManageProfiles';
import { ProfileForm } from './ProfileForm';
import { ProfilePicker } from './ProfilePicker';
import { ThemeMenu } from './ThemeMenu';

/** Primer arranque (§14.2): bienvenida con "Crear perfil". */
function Welcome() {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
      <ScreenHeading className="text-5xl text-text">Galería</ScreenHeading>
      <p className="max-w-md text-lg text-text-muted">
        Tu galería privada de fotos y vídeos, cifrada y sin conexión. Crea un perfil para empezar.
      </p>
      <Button
        variant="primary"
        size="lg"
        onClick={() => useNavStore.getState().showProfiles({ name: 'create' })}
      >
        Crear perfil
      </Button>
      <ThemeMenu className="absolute top-3 right-4" />
    </div>
  );
}

export function ProfilesFlow() {
  const view = useNavStore((s) => s.profilesView);
  const profiles = useSessionStore((s) => s.profiles);
  const error = useSessionStore((s) => s.profilesError);

  useEffect(() => {
    void refreshProfiles();
  }, []);

  if (profiles === null) return <div className="h-full" aria-busy="true" />;

  if (error && profiles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <ScreenHeading className="text-3xl text-text">No se pueden leer los perfiles</ScreenHeading>
        <p className="max-w-lg text-text-muted">{errorMessage(error)}</p>
      </div>
    );
  }

  switch (view.name) {
    case 'manage':
      return <ManageProfiles profiles={profiles} focusProfileId={view.focusProfileId} />;
    case 'create':
      return <ProfileForm mode={{ kind: 'create' }} />;
    case 'edit': {
      const profile = profiles.find((p) => p.id === view.profileId);
      return profile ? (
        <ProfileForm key={profile.id} mode={{ kind: 'edit', profile }} />
      ) : (
        <ManageProfiles profiles={profiles} />
      );
    }
    default:
      return profiles.length === 0 ? (
        <Welcome />
      ) : (
        <ProfilePicker profiles={profiles} focusProfileId={view.focusProfileId} />
      );
  }
}
