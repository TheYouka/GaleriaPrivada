// Shell `xmb` del tema Ondas, stub de F1 (docs/DESIGN.md §15.5): fila de categorías con iconos en el
// tercio superior (←/→ cambia de categoría con un deslizamiento de 250 ms, inmediato con movimiento
// reducido), columna de subelementos (↑/↓) y Enter abre la pantalla en el panel de contenido,
// translúcido sobre las ondas. Esc o Retroceso en el contenido devuelven el foco a la barra XMB.
// F6 lo completa.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { SkipLink } from '../../components/SkipLink';
import { cx } from '../../lib/cx';
import { isTextInputTarget } from '../../lib/keyboard';
import { useThemeStore } from '../../stores/theme-store';
import { categoryOf, MAIN_CONTENT_ID, type ShellProps } from './nav-model';

/** Ancho de cada categoría de la fila (px). */
const CATEGORY_WIDTH = 136;

/** Posición del foco dentro de la XMB: la categoría (row = -1) o un subelemento. */
interface XmbFocus {
  category: number;
  row: number;
}

export function XmbShell({ nav, active, onNavigate, commandBar, children }: ShellProps) {
  const reducedMotion = useThemeStore((s) => s.reducedMotion);
  const [focus, setFocus] = useState<XmbFocus>(() => ({
    category: categoryOf(nav, active),
    row: -1,
  }));
  const categoryRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** El siguiente render debe mover el foco a `focus` (tras pintar la columna nueva). */
  const pendingFocus = useRef(false);

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const el = focus.row < 0 ? categoryRefs.current[focus.category] : itemRefs.current[focus.row];
    el?.focus();
  }, [focus]);

  const moveTo = (next: XmbFocus): void => {
    pendingFocus.current = true;
    setFocus(next);
  };

  const items = nav[focus.category]?.items ?? [];

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const last = nav.length - 1;
    switch (e.key) {
      case 'ArrowLeft':
        moveTo({ category: Math.max(0, focus.category - 1), row: -1 });
        break;
      case 'ArrowRight':
        moveTo({ category: Math.min(last, focus.category + 1), row: -1 });
        break;
      case 'ArrowDown':
        moveTo({ ...focus, row: Math.min(items.length - 1, focus.row + 1) });
        break;
      case 'ArrowUp':
        moveTo({ ...focus, row: Math.max(-1, focus.row - 1) });
        break;
      case 'Home':
        moveTo({ category: 0, row: -1 });
        break;
      case 'End':
        moveTo({ category: last, row: -1 });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Esc o Retroceso en el contenido devuelven el foco a la barra XMB. Escucha nativa en <main>: los
  // diálogos (portales) no son descendientes en el DOM, así que su Esc no llega aquí.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Backspace') return;
      if (e.defaultPrevented || isTextInputTarget(e.target)) return;
      e.preventDefault();
      pendingFocus.current = true;
      setFocus({ category: categoryOf(nav, active), row: -1 });
    };
    main.addEventListener('keydown', onKey);
    return () => main.removeEventListener('keydown', onKey);
  }, [nav, active]);

  const openCategory = (index: number): void => {
    const first = nav[index]?.items[0];
    if (first) onNavigate(first.key);
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <SkipLink />
      <nav aria-label="Navegación principal" className="absolute inset-y-0 left-0 w-[25rem]">
        <motion.ul
          aria-label="Categorías"
          className="absolute top-4 left-[10.5rem] flex"
          animate={{ x: -focus.category * CATEGORY_WIDTH }}
          transition={{ duration: reducedMotion ? 0 : 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        >
          {nav.map((category, i) => {
            const Icon = category.icon;
            const selected = i === focus.category;
            return (
              <li
                key={category.id}
                style={{ width: CATEGORY_WIDTH }}
                className="flex justify-center"
              >
                <button
                  ref={(el) => {
                    categoryRefs.current[i] = el;
                  }}
                  type="button"
                  tabIndex={selected && focus.row < 0 ? 0 : -1}
                  aria-current={categoryOf(nav, active) === i ? 'true' : undefined}
                  onFocus={() =>
                    setFocus((f) => (f.category === i && f.row < 0 ? f : { category: i, row: -1 }))
                  }
                  onKeyDown={onKeyDown}
                  onClick={() => openCategory(i)}
                  className={cx(
                    'flex w-28 flex-col items-center gap-2 rounded-md px-2 py-2 text-text transition-opacity',
                    selected ? 'opacity-100' : 'opacity-70',
                  )}
                >
                  <Icon aria-hidden="true" size={selected ? 44 : 34} strokeWidth={1.5} />
                  <span className={cx('text-sm', selected && 'font-bold')}>{category.label}</span>
                </button>
              </li>
            );
          })}
        </motion.ul>
        <ul
          aria-label={nav[focus.category]?.label}
          className="absolute top-36 left-[11.5rem] flex w-52 flex-col gap-1"
        >
          {items.map((item, row) => {
            const current = item.key === active;
            return (
              <li key={item.key}>
                <button
                  ref={(el) => {
                    itemRefs.current[row] = el;
                  }}
                  type="button"
                  tabIndex={focus.row === row ? 0 : -1}
                  aria-current={current ? 'page' : undefined}
                  onFocus={() => setFocus((f) => (f.row === row ? f : { ...f, row }))}
                  onKeyDown={onKeyDown}
                  onClick={() => onNavigate(item.key)}
                  className={cx(
                    'flex h-11 w-full items-center rounded-md px-4 text-left text-lg text-text hover:bg-surface-alpha',
                    current && 'bg-surface-alpha font-bold',
                  )}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <main
        id={MAIN_CONTENT_ID}
        ref={mainRef}
        tabIndex={-1}
        className="absolute top-36 right-6 bottom-6 left-[26rem] flex flex-col overflow-auto rounded-lg border border-border bg-surface-alpha"
      >
        {commandBar}
        {children}
      </main>
    </div>
  );
}
