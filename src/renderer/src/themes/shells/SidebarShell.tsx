// Shell `sidebar` del tema Clásico (docs/DESIGN.md §15.2 y §15.5): panel de navegación a la izquierda
// (280 px, se pliega a iconos por debajo de 1100 px o con el botón), ↑/↓ dentro de la lista con
// roving tabindex y Enter para abrir. La barra de comandos va encima del contenido.
import { useRef, useState, type KeyboardEvent } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IconButton } from '../../components/IconButton';
import { SkipLink } from '../../components/SkipLink';
import { cx } from '../../lib/cx';
import { rovingIndex } from '../../lib/keyboard';
import { useMediaQuery } from '../../lib/use-media';
import { MAIN_CONTENT_ID, type NavItem, type ShellProps } from './nav-model';

export function SidebarShell({ nav, active, onNavigate, commandBar, children }: ShellProps) {
  const narrow = useMediaQuery('(max-width: 1099px)');
  const [collapsedPref, setCollapsedPref] = useState<boolean | null>(null);
  const collapsed = collapsedPref ?? narrow;

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

  const renderItem = (item: NavItem, nested: boolean) => {
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
            'g-nav-item relative flex h-10 w-full items-center gap-3 rounded-md text-left text-sm text-text hover:bg-surface-hover',
            collapsed ? 'justify-center px-0' : nested ? 'pr-3 pl-9' : 'px-3',
            current && 'bg-surface-hover font-semibold',
          )}
        >
          <Icon aria-hidden="true" size={18} strokeWidth={1.75} className="shrink-0" />
          <span className={cx(collapsed && 'sr-only')}>{item.label}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="relative flex h-full min-h-0">
      <SkipLink />
      <nav
        aria-label="Navegación principal"
        className={cx(
          'flex shrink-0 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-4',
          collapsed ? 'w-16' : 'w-(--g-nav-width)',
        )}
      >
        <IconButton
          label={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
          aria-expanded={!collapsed}
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          onClick={() => setCollapsedPref(!collapsed)}
          className={cx(collapsed ? 'self-center' : 'ml-1')}
        />
        <ul className="flex flex-col gap-0.5">
          {nav.map((category) =>
            category.items.length > 1 ? (
              <li key={category.id}>
                <span
                  className={cx(
                    'flex h-8 items-center px-3 text-xs font-semibold text-text-muted',
                    collapsed && 'sr-only',
                  )}
                >
                  {category.label}
                </span>
                <ul className="flex flex-col gap-0.5">
                  {category.items.map((item) => renderItem(item, true))}
                </ul>
              </li>
            ) : (
              category.items.map((item) => renderItem(item, false))
            ),
          )}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col pr-2 pb-2">
        {commandBar}
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface-alpha"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
