// Shell `vibrancy` del tema Cristal (docs/DESIGN.md §15.2 y §15.5): barra lateral translúcida
// agrupada por secciones (↑/↓ con roving tabindex, Intro abre) y una barra de herramientas unida a la
// de título, con los botones de la ventana a la izquierda (semáforo). Las dos superficies suben hasta
// el borde superior de la ventana por debajo de la barra de título, y son las únicas con
// `backdrop-filter` (styles/themes.css, §15.7); el contenido va en una tarjeta opaca.
import { useRef, useState, type KeyboardEvent } from 'react';
import { SkipLink } from '../../components/SkipLink';
import { cx } from '../../lib/cx';
import { rovingIndex } from '../../lib/keyboard';
import { MAIN_CONTENT_ID, type NavItem, type ShellProps } from './nav-model';

export function VibrancyShell({ nav, active, onNavigate, commandBar, children }: ShellProps) {
  const items: NavItem[] = nav.flatMap((c) => [...c.items]);
  const activeIndex = Math.max(
    0,
    items.findIndex((it) => it.key === active),
  );
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const tabbable = focusIndex ?? activeIndex;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const next = rovingIndex(e.key, tabbable, items.length, { orientation: 'vertical' });
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  const renderItem = (item: NavItem) => {
    const index = items.indexOf(item);
    const current = item.key === active;
    const Icon = item.icon;
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
            'flex h-8 w-full items-center gap-2.5 rounded-md text-left text-sm',
            current ? 'bg-accent font-medium text-on-accent' : 'text-text hover:bg-surface-hover',
          )}
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} className="shrink-0" />
          {item.label}
        </button>
      </li>
    );
  };

  return (
    <div className="relative flex h-full min-h-0">
      <SkipLink />
      <nav
        aria-label="Navegación principal"
        className="g-vibrancy-sidebar -mt-8 flex w-(--g-nav-width) shrink-0 flex-col gap-2 overflow-y-auto px-2 pt-12 pb-4"
      >
        <ul className="flex flex-col gap-0.5">
          {nav.map((category) =>
            category.items.length > 1 ? (
              <li key={category.id} className="mb-1">
                <span className="flex h-7 items-center px-3 text-xs font-semibold text-text-muted">
                  {category.label}
                </span>
                <ul className="flex flex-col gap-0.5">
                  {category.items.map((item) => renderItem(item))}
                </ul>
              </li>
            ) : (
              category.items.map((item) => renderItem(item))
            ),
          )}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="g-vibrancy-toolbar -mt-8 shrink-0 px-3 pt-10 pb-2">{commandBar}</div>
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="mr-3 mb-3 ml-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-bg-elevated shadow-md"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
