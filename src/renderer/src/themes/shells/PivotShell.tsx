// Shell `pivot` del tema Mosaico (docs/DESIGN.md §15.2 y §15.5): pestañas horizontales grandes arriba
// (las categorías del NavModel) y, si la categoría tiene varios destinos (Galería: Todo, Fotos y
// Vídeos), una segunda fila con ellos; el contenido va debajo. ←/→ recorre cada fila (roving
// tabindex), ↓ pasa de las categorías a los destinos y ↑ vuelve, Intro o clic abre. El foco se ve con
// escala + borde de 3 px (styles/themes.css); con movimiento reducido solo queda el borde.
// Son botones con `aria-current` dentro de un <nav>, como en los otros shells: la pantalla no es un
// `tabpanel`, así que un `role="tablist"` dejaría `aria-controls` apuntando a nada.
import { useRef, useState, type KeyboardEvent } from 'react';
import { SkipLink } from '../../components/SkipLink';
import { cx } from '../../lib/cx';
import { rovingIndex } from '../../lib/keyboard';
import { categoryOf, MAIN_CONTENT_ID, type ShellProps } from './nav-model';

export function PivotShell({ nav, active, onNavigate, commandBar, children }: ShellProps) {
  const activeCategory = categoryOf(nav, active);
  const [focusCategory, setFocusCategory] = useState<number | null>(null);
  const [focusItem, setFocusItem] = useState<number | null>(null);
  const categoryRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const shown = nav[activeCategory];
  const items = shown && shown.items.length > 1 ? shown.items : [];
  const activeItem = Math.max(
    0,
    items.findIndex((it) => it.key === active),
  );
  const tabbableCategory = focusCategory ?? activeCategory;
  const tabbableItem = Math.min(focusItem ?? activeItem, Math.max(0, items.length - 1));

  // Elegir una categoría abre la que ya está activa o, si es otra, su primer destino.
  const openCategory = (index: number): void => {
    if (index === activeCategory) return;
    const first = nav[index]?.items[0];
    if (first) onNavigate(first.key);
  };

  const onCategoryKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      itemRefs.current[tabbableItem]?.focus();
      return;
    }
    const next = rovingIndex(e.key, tabbableCategory, nav.length, { orientation: 'horizontal' });
    if (next === null) return;
    e.preventDefault();
    setFocusCategory(next);
    categoryRefs.current[next]?.focus();
  };

  const onItemKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      categoryRefs.current[tabbableCategory]?.focus();
      return;
    }
    const next = rovingIndex(e.key, tabbableItem, items.length, { orientation: 'horizontal' });
    if (next === null) return;
    e.preventDefault();
    setFocusItem(next);
    itemRefs.current[next]?.focus();
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <SkipLink />
      <nav aria-label="Navegación principal" className="shrink-0 px-6 pt-1 pb-3">
        <ul aria-label="Categorías" className="flex flex-wrap items-end gap-x-8 gap-y-1">
          {nav.map((category, i) => {
            const selected = i === activeCategory;
            return (
              <li key={category.id}>
                <button
                  ref={(el) => {
                    categoryRefs.current[i] = el;
                  }}
                  type="button"
                  tabIndex={i === tabbableCategory ? 0 : -1}
                  aria-current={selected ? 'true' : undefined}
                  data-selected={selected ? 'true' : 'false'}
                  onFocus={() => setFocusCategory(i)}
                  onKeyDown={onCategoryKey}
                  onClick={() => openCategory(i)}
                  className={cx(
                    'g-pivot-tab px-3 py-1 text-2xl text-text',
                    selected ? 'font-semibold' : 'text-text-muted',
                  )}
                >
                  {category.label}
                </button>
              </li>
            );
          })}
        </ul>
        {items.length > 0 ? (
          <ul aria-label={shown?.label} className="mt-2 flex flex-wrap gap-2 px-3">
            {items.map((item, i) => {
              const current = item.key === active;
              return (
                <li key={item.key}>
                  <button
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    tabIndex={i === tabbableItem ? 0 : -1}
                    aria-current={current ? 'page' : undefined}
                    data-selected={current ? 'true' : 'false'}
                    onFocus={() => setFocusItem(i)}
                    onKeyDown={onItemKey}
                    onClick={() => onNavigate(item.key)}
                    className={cx(
                      'g-pivot-item px-4 py-1 text-sm',
                      current ? 'bg-accent font-semibold text-on-accent' : 'bg-surface text-text',
                    )}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </nav>
      {commandBar ? <div className="shrink-0 px-6">{commandBar}</div> : null}
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="mx-6 mb-4 min-h-0 flex-1 overflow-auto border-2 border-border bg-surface-alpha"
      >
        {children}
      </main>
    </div>
  );
}
