// Selector de perfiles estilo Netflix / HBO Max (docs/DESIGN.md §14.2). La estructura, el orden del
// DOM y el teclado son los mismos en todos los temas (D9, §15.10); cambia solo la presentación:
//   - `fluent` (Clásico): fila centrada (varias filas si hace falta) sobre fondo oscuro forzado;
//   - `tiles` (Mosaico): mosaicos planos (perfil 2×2, «Añadir perfil» 2×1) con el nombre dentro, sobre
//     una etiqueta sólida; el enfocado escala y lleva un borde blanco de 3 px;
//   - `xmb-row` (Ondas): una fila horizontal sobre las ondas; el avatar enfocado se agranda y se
//     centra con un deslizamiento, con «Pulsa Intro» debajo;
//   - `login` (Cristal): avatares circulares sobre el fondo, como una pantalla de inicio de sesión; al
//     elegir uno, la contraseña se pide en línea bajo su avatar (InlineUnlock, dentro de su <li>);
//   - `showcase` (Cine): avatares grandes y redondeados sobre el degradado; escalan y llevan un anillo
//     blanco al enfocar.
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
import type { PickerKind } from '../../themes/theme-types';
import { useTheme } from '../../themes/use-theme';
import { ThemeMenu } from './ThemeMenu';
import { InlineUnlock, UnlockDialog } from './UnlockDialog';

type Entry = { kind: 'profile'; profile: ProfileSummary } | { kind: 'add' };

/** Clases de una variante del selector (solo presentación). */
interface Look {
  /** Botón de la entrada. */
  button: string;
  /** Marco del avatar: anillo de foco y radio. */
  ring: string;
  /** Nombre del perfil. */
  name: string;
  /** Etiqueta «Disco no conectado». */
  badge: string;
}

const RING_ACCENT =
  'rounded-avatar ring-accent ring-offset-4 ring-offset-bg group-hover:ring-4 group-focus-visible:ring-4';
const BUTTON = 'group flex flex-col items-center gap-3 rounded-lg p-2 text-text outline-none';
const NAME =
  'max-w-full truncate text-lg group-hover:font-semibold group-focus-visible:font-semibold';
const BADGE = 'inline-flex items-center gap-1 rounded-sm bg-surface px-2 py-0.5 text-xs text-text';

const LOOKS: Record<PickerKind, Look> = {
  fluent: { button: BUTTON, ring: RING_ACCENT, name: NAME, badge: BADGE },
  'xmb-row': { button: BUTTON, ring: RING_ACCENT, name: NAME, badge: BADGE },
  login: { button: BUTTON, ring: RING_ACCENT, name: NAME, badge: BADGE },
  tiles: {
    button: 'group relative flex flex-col items-stretch rounded-none p-1 text-text outline-none',
    ring: 'rounded-avatar ring-focus-ring ring-offset-2 ring-offset-bg group-hover:ring-2 group-focus-visible:ring-[3px]',
    name: 'absolute inset-x-1 bottom-1 truncate bg-surface px-3 py-2 text-left text-base font-semibold',
    badge: `absolute top-2 left-2 z-10 ${BADGE}`,
  },
  showcase: {
    button: 'group flex flex-col items-center gap-4 rounded-lg p-2 text-text outline-none',
    ring: 'rounded-avatar ring-focus-ring ring-offset-4 ring-offset-bg group-hover:ring-2 group-focus-visible:ring-4',
    name: 'max-w-full truncate text-xl font-semibold',
    badge: BADGE,
  },
};

interface EntryProps {
  tabbable: boolean;
  size: number;
  variant: PickerKind;
  scale: number | null;
  buttonRef: Ref<HTMLButtonElement>;
  onFocus(): void;
}

function ProfileEntry({
  profile,
  hidden,
  breathe,
  onOpen,
  tabbable,
  size,
  variant,
  scale,
  buttonRef,
  onFocus,
}: EntryProps & { profile: ProfileSummary; hidden: boolean; breathe: boolean; onOpen(): void }) {
  const unavailable = profile.vaultStatus === 'unavailable';
  const look = LOOKS[variant];
  return (
    <motion.button
      ref={buttonRef}
      type="button"
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={onOpen}
      whileHover={scale ? { scale } : undefined}
      whileFocus={scale ? { scale } : undefined}
      className={look.button}
    >
      <span className={cx('relative block', look.ring)} style={{ width: size, height: size }}>
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
      <span className={look.name}>{profile.name}</span>
      {unavailable ? (
        <span className={look.badge}>
          <Unplug aria-hidden="true" size={14} />
          Disco no conectado
        </span>
      ) : null}
      {variant === 'xmb-row' && tabbable ? (
        <span aria-hidden="true" className="text-sm text-text-muted">
          Pulsa Intro
        </span>
      ) : null}
    </motion.button>
  );
}

function AddEntry({ tabbable, size, scale, buttonRef, onFocus, variant }: EntryProps) {
  const look = LOOKS[variant];
  // Mosaico: «Añadir perfil» es un mosaico de 2×1 (la mitad de alto que el de un perfil) con su
  // etiqueta debajo en vez de encima.
  const height = variant === 'tiles' ? size / 2 : size;
  return (
    <motion.button
      ref={buttonRef}
      type="button"
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={() => useNavStore.getState().showProfiles({ name: 'create' })}
      whileHover={scale ? { scale } : undefined}
      whileFocus={scale ? { scale } : undefined}
      className={look.button}
    >
      <span
        className={cx(
          'flex items-center justify-center border-2 border-dashed border-border-strong bg-surface-alpha',
          look.ring,
        )}
        style={{ width: size, height }}
      >
        <Plus aria-hidden="true" size={size / 3} strokeWidth={1.5} />
      </span>
      <span
        className={
          variant === 'tiles'
            ? 'w-full truncate bg-surface px-3 py-2 text-left text-base font-semibold'
            : look.name
        }
      >
        Añadir perfil
      </span>
      {variant === 'xmb-row' && tabbable ? (
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
  const variant = def.picker;
  const xmb = variant === 'xmb-row';
  const tiles = variant === 'tiles';
  const inline = variant === 'login';
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

  const many = profiles.length > 5;
  const size = variant === 'showcase' ? (many ? 150 : 200) : many ? 120 : 160;
  // Ancho de la celda: el avatar más el margen del anillo; los mosaicos van casi pegados.
  const cell = size + (tiles ? 8 : 24);
  const scale = reducedMotion ? null : def.motion.focusScale;
  const tabbable = Math.min(active, entries.length - 1);
  // xmb-row: la fila se desplaza para que el avatar enfocado quede en el centro.
  const pitch = cell + 32;
  const offset = xmb ? ((entries.length - 1) / 2 - tabbable) * pitch : 0;

  /** `login`: la entrada del perfil elegido lleva el formulario debajo y se ensancha. */
  const showForm = (entry: Entry): boolean =>
    inline && entry.kind === 'profile' && selected?.id === entry.profile.id;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const next = rovingIndex(e.key, tabbable, entries.length);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    buttons.current[next]?.focus();
  };

  /** Cierra el desbloqueo en línea y devuelve el foco al avatar (§14.2). */
  const closeInline = (): void => {
    setSelected(null);
    buttons.current[lastSelected.current]?.focus();
  };

  return (
    <div
      data-picker={variant}
      className={cx(
        'relative flex h-full flex-col items-center overflow-auto px-8 pb-10',
        xmb ? 'justify-start gap-10 pt-[12vh]' : 'justify-center gap-10',
      )}
    >
      <ScreenHeading
        takeFocus={!focusProfileId}
        className={cx('text-3xl text-text', variant === 'showcase' && 'font-bold')}
      >
        ¿Quién eres?
      </ScreenHeading>
      <div className={cx('w-full', xmb ? 'overflow-hidden py-6' : 'flex justify-center')}>
        <motion.ul
          aria-label="Perfiles"
          onKeyDown={onKeyDown}
          animate={{ x: offset }}
          transition={{ duration: reducedMotion ? 0 : def.motion.normalMs / 1000 }}
          className={cx(
            'flex items-start justify-center',
            tiles ? 'gap-1' : 'gap-8',
            xmb ? 'flex-nowrap' : 'max-w-[68rem] flex-wrap',
          )}
        >
          {entries.map((entry, i) => {
            const common: EntryProps = {
              tabbable: i === tabbable,
              size,
              variant,
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
                className={cx('flex', inline ? 'flex-col items-center' : 'justify-center')}
                style={{ width: showForm(entry) ? Math.max(cell, 288) : cell }}
              >
                {entry.kind === 'profile' ? (
                  <ProfileEntry
                    {...common}
                    profile={entry.profile}
                    hidden={!inline && selected?.id === entry.profile.id}
                    breathe={!reducedMotion && !tiles}
                    onOpen={() => {
                      lastSelected.current = i;
                      setSelected(entry.profile);
                    }}
                  />
                ) : (
                  <AddEntry {...common} />
                )}
                {selected && entry.kind === 'profile' && showForm(entry) ? (
                  <InlineUnlock key={selected.id} profile={selected} onClose={closeInline} />
                ) : null}
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
        profile={inline ? null : selected}
        onClose={() => setSelected(null)}
        onReturnFocus={() => buttons.current[lastSelected.current]?.focus()}
      />
    </div>
  );
}
