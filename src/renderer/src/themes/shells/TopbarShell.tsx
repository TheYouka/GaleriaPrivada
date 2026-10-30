// Shell `topbar` del tema Cine (anexo §8, docs/DESIGN.md §15.5): barra superior transparente sobre el
// degradado que se vuelve sólida al desplazar el contenido, con las secciones a la izquierda y el
// avatar del perfil a la derecha. Mismo NavModel y mismas pantallas que los demás shells: las
// secciones son los destinos del modelo en una fila (←/→ con roving tabindex, Intro abre). Al
// desplazar cualquier zona del contenido (la rejilla de la galería lleva su propio desplazamiento),
// `data-scrolled` pasa a `true` y styles/themes.css pinta la barra sólida con sombra.
import { useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import { Avatar } from '../../components/Avatar';
import { SkipLink } from '../../components/SkipLink';
import { cx } from '../../lib/cx';
import { rovingIndex } from '../../lib/keyboard';
import { useSessionStore } from '../../stores/session-store';
import { MAIN_CONTENT_ID, navLabel, type NavItem, type ShellProps } from './nav-model';

/** Desplazamiento (px) a partir del cual la barra pasa a ser sólida. */
const SOLID_AFTER_PX = 4;

export function TopbarShell({ nav, active, onNavigate, commandBar, children }: ShellProps) {
  const profile = useSessionStore((s) => s.profile);
  const items: NavItem[] = nav.flatMap((c) => [...c.items]);
  const activeIndex = Math.max(
    0,
    items.findIndex((it) => it.key === active),
  );
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const tabbable = focusIndex ?? activeIndex;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // El desplazamiento es de la pantalla actual: al cambiar de pantalla la barra vuelve a ser transparente.
  const [scroll, setScroll] = useState({ active, scrolled: false });
  const scrolled = scroll.active === active && scroll.scrolled;
  const onScrollCapture = (e: UIEvent<HTMLDivElement>): void => {
    const target = e.target;
    if (target instanceof HTMLElement) {
      setScroll({ active, scrolled: target.scrollTop > SOLID_AFTER_PX });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const next = rovingIndex(e.key, tabbable, items.length, { orientation: 'horizontal' });
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col" onScrollCapture={onScrollCapture}>
      <SkipLink />
      <nav
        aria-label="Navegación principal"
        data-topbar=""
        data-scrolled={scrolled ? 'true' : 'false'}
        className="g-topbar relative z-10 flex h-14 shrink-0 items-center gap-6 px-8"
      >
        <ul className="flex items-center gap-1">
          {items.map((item, index) => {
            const current = item.key === active;
            return (
              <li key={item.key}>
                <button
                  ref={(el) => {
                    refs.current[index] = el;
                  }}
                  type="button"
                  tabIndex={index === tabbable ? 0 : -1}
                  aria-current={current ? 'page' : undefined}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={onKeyDown}
                  onClick={() => onNavigate(item.key)}
                  className={cx(
                    'g-topbar-link relative h-10 rounded-md px-3 text-sm',
                    current ? 'font-bold text-text' : 'text-text-muted hover:text-text',
                  )}
                >
                  {navLabel(nav, item.key)}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex-1" />
        {profile ? (
          <div role="img" aria-label={`Perfil: ${profile.name}`} title={profile.name}>
            <Avatar
              source={{ kind: 'ref', profileId: profile.id, avatar: profile.avatar }}
              size={36}
            />
          </div>
        ) : null}
      </nav>
      {commandBar ? <div className="shrink-0 px-8">{commandBar}</div> : null}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
