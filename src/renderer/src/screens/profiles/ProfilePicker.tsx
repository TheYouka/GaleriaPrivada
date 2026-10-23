// Selector de perfiles estilo Netflix / HBO Max (docs/DESIGN.md §14.2). La estructura, el orden del
// DOM y el teclado son los mismos en todos los temas (D9, §15.10); cambia solo la presentación:
//   - `fluent` (Clásico): fila centrada (varias filas si hace falta) sobre fondo oscuro forzado;
//   - `xmb-row` (Ondas): una fila horizontal sobre las ondas; el avatar enfocado se agranda y se
//     centra con un deslizamiento, con "Pulsa Intro" debajo.
// Lista con roving tabindex: ←/→/↑/↓ mueven el foco, Home/End van a los extremos, Enter/Espacio abre
// el desbloqueo y Tab sale hacia "Administrar perfiles". Con movimiento reducido solo queda el anillo.
import { useCallback, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { motion } from 'motion/react';
import { Plus, Unplug } from 'lucide-react';
import { MAX_PROFILES } from '@shared/constants';
import type { Id, ProfileSummary } from '@shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { ScreenHeading } from '../../components/ScreenHeading';
import { cx } from '../../lib/cx';
import { useScreenFocus } from '../../lib/focus';
import { rovingIndex } from '../../lib/keyboard';
import { useNavStore } from '../../stores/nav-store';
import { useThemeStore } from '../../stores/theme-store';
import { useTheme } from '../../themes/use-theme';
import { ThemeMenu } from './ThemeMenu';
import { UnlockDialog } from './UnlockDialog';

type Entry = { kind: 'profile'; profile: ProfileSummary } | { kind: 'add' };

interface EntryProps {
  tabbable: boolean;
  size: number;
  xmb: boolean;
  scale: number | null;
  buttonRef: Ref<HTMLButtonElement>;
  onFocus(): void;
}

const RING =
  'rounded-avatar ring-accent ring-offset-4 ring-offset-bg group-hover:ring-4 group-focus-visible:ring-4';

function ProfileEntry({
  profile,
  hidden,
  breathe,
  onOpen,
  tabbable,
  size,
  xmb,
  scale,
  buttonRef,
  onFocus,
}: EntryProps & { profile: ProfileSummary; hidden: boolean; breathe: boolean; onOpen(): void }) {
  const unavailable = profile.vaultStatus === 'unavailable';
  return (
    <motion.button
      ref={buttonRef}
      type="button"
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={onOpen}
      whileHover={scale ? { scale } : undefined}
      whileFocus={scale ? { scale } : undefined}
      className="group flex flex-col items-center gap-3 rounded-lg p-2 text-text outline-none"
    >
      <span className={cx('relative block', RING)} style={{ width: size, height: size }}>
        {hidden ? null : (
          <motion.span layoutId={`avatar-${profile.id}`} className="block">
            <motion.span
              className="block"
              animate={breathe ? { scale: [1, 1.02, 1] } : undefined}
              transition={
                breathe ? { duration: 4, repeat: Infinity, ease: 'easeInOut' } : undefined
              }
            >
              <Avatar
                source={{ kind: 'ref', profileId: profile.id, avatar: profile.avatar }}
                size={size}
              />
            </motion.span>
          </motion.span>
        )}
      </span>
      <span className="max-w-full truncate text-lg group-hover:font-semibold group-focus-visible:font-semibold">
        {profile.name}
      </span>
      {unavailable ? (
        <span className="inline-flex items-center gap-1 rounded-sm bg-surface px-2 py-0.5 text-xs text-text">
          <Unplug aria-hidden="true" size={14} />
          Disco no conectado
        </span>
      ) : null}
      {xmb && tabbable ? (
        <span aria-hidden="true" className="text-sm text-text-muted">
          Pulsa Intro
        </span>
      ) : null}
    </motion.button>
  );
}

function AddEntry({ tabbable, size, scale, buttonRef, onFocus, xmb }: EntryProps) {
  return (
    <motion.button
      ref={buttonRef}
      type="button"
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={() => useNavStore.getState().showProfiles({ name: 'create' })}
      whileHover={scale ? { scale } : undefined}
      whileFocus={scale ? { scale } : undefined}
      className="group flex flex-col items-center gap-3 rounded-lg p-2 text-text outline-none"
    >
      <span
        className={cx(
          'flex items-center justify-center border-2 border-dashed border-border-strong bg-surface-alpha',
          RING,
        )}
        style={{ width: size, height: size }}
      >
        <Plus aria-hidden="true" size={size / 3} strokeWidth={1.5} />
      </span>
      <span className="text-lg group-hover:font-semibold group-focus-visible:font-semibold">
        Añadir perfil
      </span>
      {xmb && tabbable ? (
        <span aria-hidden="true" className="text-sm text-text-muted">
          Pulsa Intro
        </span>
      ) : null}
    </motion.button>
  );
}

export interface ProfilePickerProps {
  profiles: ProfileSummary[];
  /** Tras crear un perfil, el foco va a su avatar (§14.4). */
  focusProfileId?: Id;
}

export function ProfilePicker({ profiles, focusProfileId }: ProfilePickerProps) {
  const { def } = useTheme();
  const xmb = def.picker === 'xmb-row';
  const reducedMotion = useThemeStore((s) => s.reducedMotion);
  const entries: Entry[] = [
    ...profiles.map((profile): Entry => ({ kind: 'profile', profile })),
    ...(profiles.length < MAX_PROFILES ? [{ kind: 'add' } as const] : []),
  ];
  const initial = focusProfileId
    ? Math.max(
        0,
        profiles.findIndex((p) => p.id === focusProfileId),
      )
    : 0;
  const [active, setActive] = useState(initial);
  const [selected, setSelected] = useState<ProfileSummary | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const lastSelected = useRef(0);

  const focusTarget = useCallback(
    () => (focusProfileId ? buttons.current[initial] : null),
    [focusProfileId, initial],
  );
  useScreenFocus(focusTarget);

  const size = profiles.length > 5 ? 120 : 160;
  const scale = reducedMotion ? null : def.motion.focusScale;
  const tabbable = Math.min(active, entries.length - 1);
  // xmb-row: la fila se desplaza para que el avatar enfocado quede en el centro.
  const pitch = size + 24 + 32;
  const offset = xmb ? ((entries.length - 1) / 2 - tabbable) * pitch : 0;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const next = rovingIndex(e.key, tabbable, entries.length);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    buttons.current[next]?.focus();
  };

  return (
    <div
      className={cx(
        'relative flex h-full flex-col items-center overflow-auto px-8 pb-10',
        xmb ? 'justify-start gap-10 pt-[12vh]' : 'justify-center gap-10',
      )}
    >
      <ScreenHeading takeFocus={!focusProfileId} className="text-3xl text-text">
        ¿Quién eres?
      </ScreenHeading>
      <div className={cx('w-full', xmb ? 'overflow-hidden py-6' : 'flex justify-center')}>
        <motion.ul
          aria-label="Perfiles"
          onKeyDown={onKeyDown}
          animate={{ x: offset }}
          transition={{ duration: reducedMotion ? 0 : def.motion.normalMs / 1000 }}
          className={cx(
            'flex items-start justify-center gap-8',
            xmb ? 'flex-nowrap' : 'max-w-[68rem] flex-wrap',
          )}
        >
          {entries.map((entry, i) => {
            const common: EntryProps = {
              tabbable: i === tabbable,
              size,
              xmb,
              scale,
              buttonRef: (el: HTMLButtonElement | null) => {
                buttons.current[i] = el;
              },
              onFocus: () => setActive(i),
            };
            return (
              <motion.li
                key={entry.kind === 'profile' ? entry.profile.id : 'add'}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: (i * def.motion.staggerMs) / 1000,
                  duration: reducedMotion ? 0.15 : 0.35,
                }}
                className="flex justify-center"
                style={{ width: size + 24 }}
              >
                {entry.kind === 'profile' ? (
                  <ProfileEntry
                    {...common}
                    profile={entry.profile}
                    hidden={selected?.id === entry.profile.id}
                    breathe={!reducedMotion}
                    onOpen={() => {
                      lastSelected.current = i;
                      setSelected(entry.profile);
                    }}
                  />
                ) : (
                  <AddEntry {...common} />
                )}
              </motion.li>
            );
          })}
        </motion.ul>
      </div>
      <Button size="lg" onClick={() => useNavStore.getState().showProfiles({ name: 'manage' })}>
        Administrar perfiles
      </Button>
      <ThemeMenu className="absolute top-3 right-4" />
      <UnlockDialog
        profile={selected}
        onClose={() => setSelected(null)}
        onReturnFocus={() => buttons.current[lastSelected.current]?.focus()}
      />
    </div>
  );
}
