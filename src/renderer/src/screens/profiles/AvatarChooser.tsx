// Elección de avatar (docs/DESIGN.md §14.4): RadioGroup con los 12 integrados, navegable con
// flechas, más "Usar una foto…", que muestra siempre el aviso de que la foto se guarda sin cifrar.
import { Check, ImagePlus, TriangleAlert } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import type { BuiltinAvatarId, Id } from '@shared/types';
import { Avatar, type AvatarSource } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { BUILTIN_AVATAR_IDS, BUILTIN_AVATAR_LABELS } from '../../lib/avatars';

/** Lo elegido en el formulario: integrado, la foto actual del perfil o una foto nueva (token). */
export type AvatarChoice =
  { kind: 'builtin'; id: BuiltinAvatarId } | { kind: 'current' } | { kind: 'photo'; token: string };

export interface AvatarChooserProps {
  value: AvatarChoice;
  onChange(value: AvatarChoice): void;
  /** Foto actual del perfil (editar un perfil con avatar personalizado). */
  current: { profileId: Id; rev: number } | null;
  /** Foto elegida en esta pantalla, aún sin guardar. */
  photoToken: string | null;
  onPickPhoto(): void;
  picking: boolean;
  photoError: string | null;
}

const SIZE = 56;

function Option({ value, label, source }: { value: string; label: string; source: AvatarSource }) {
  return (
    <RadioGroup.Item
      value={value}
      aria-label={label}
      className="group relative rounded-avatar p-0.5 data-[state=checked]:ring-2 data-[state=checked]:ring-accent"
    >
      <Avatar source={source} size={SIZE} />
      <RadioGroup.Indicator className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
        <Check aria-hidden="true" size={14} strokeWidth={3} />
      </RadioGroup.Indicator>
    </RadioGroup.Item>
  );
}

export function AvatarChooser({
  value,
  onChange,
  current,
  photoToken,
  onPickPhoto,
  picking,
  photoError,
}: AvatarChooserProps) {
  const selected = value.kind === 'builtin' ? value.id : value.kind;
  const select = (v: string): void => {
    if (v === 'current') onChange({ kind: 'current' });
    else if (v === 'photo' && photoToken) onChange({ kind: 'photo', token: photoToken });
    else {
      const id = BUILTIN_AVATAR_IDS.find((a) => a === v);
      if (id) onChange({ kind: 'builtin', id });
    }
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend id="avatar-legend" className="mb-1.5 text-sm font-medium text-text">
        Avatar
      </legend>
      <RadioGroup.Root
        aria-labelledby="avatar-legend"
        value={selected}
        onValueChange={select}
        className="grid w-fit grid-cols-6 gap-2.5"
      >
        {BUILTIN_AVATAR_IDS.map((id) => (
          <Option
            key={id}
            value={id}
            label={BUILTIN_AVATAR_LABELS[id]}
            source={{ kind: 'ref', profileId: '', avatar: { type: 'builtin', id } }}
          />
        ))}
        {current ? (
          <Option
            value="current"
            label="Foto actual"
            source={{
              kind: 'ref',
              profileId: current.profileId,
              avatar: { type: 'custom', rev: current.rev },
            }}
          />
        ) : null}
        {photoToken ? (
          <Option
            value="photo"
            label="Foto elegida"
            source={{ kind: 'pending', token: photoToken }}
          />
        ) : null}
      </RadioGroup.Root>
      <div className="flex flex-col items-start gap-2">
        <Button onClick={onPickPhoto} disabled={picking}>
          <ImagePlus aria-hidden="true" size={16} />
          Usar una foto…
        </Button>
        <p className="flex items-start gap-2 text-sm text-text-muted">
          <TriangleAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-warning" />
          <span>
            Esta foto se guardará <strong className="text-text">sin cifrar</strong> y la verá
            cualquiera que abra Galería en este equipo.
          </span>
        </p>
        {photoError ? (
          <p role="alert" className="text-sm text-danger-text">
            {photoError}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
