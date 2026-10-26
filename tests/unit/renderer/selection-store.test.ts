// Reductor de la selección de la galería (docs/DESIGN.md §14.6, PLAN.md 2.12): clic, Ctrl, Shift con
// ancla sobre el orden total, Ctrl+A, Esc e intersección al cambiar la consulta.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  reduceSelection,
  useSelectionStore,
  type SelectionAction,
  type SelectionState,
} from '@renderer/stores/selection-store';

const ID = (n: number): string => n.toString(16).padStart(32, '0');
const ORDER = Array.from({ length: 10 }, (_, i) => ID(i + 1));

function run(actions: SelectionAction[], order: readonly string[] = ORDER): SelectionState {
  return actions.reduce<SelectionState>((s, a) => reduceSelection(s, a, order), EMPTY_SELECTION);
}
const ids = (s: SelectionState): string[] => ORDER.filter((id) => s.selected.has(id));

describe('selección: clic y Ctrl', () => {
  it('un clic deja solo ese elemento y lo hace ancla', () => {
    const s = run([
      { type: 'click', id: ID(2) },
      { type: 'click', id: ID(5) },
    ]);
    expect(ids(s)).toEqual([ID(5)]);
    expect(s.anchor).toBe(ID(5));
  });

  it('Ctrl alterna sin tocar el resto y mueve el ancla', () => {
    let s = run([
      { type: 'click', id: ID(2) },
      { type: 'ctrl', id: ID(4) },
      { type: 'ctrl', id: ID(6) },
    ]);
    expect(ids(s)).toEqual([ID(2), ID(4), ID(6)]);
    expect(s.anchor).toBe(ID(6));
    s = reduceSelection(s, { type: 'ctrl', id: ID(4) }, ORDER);
    expect(ids(s)).toEqual([ID(2), ID(6)]);
    expect(s.anchor).toBe(ID(4));
  });
});

describe('selección: rango con Shift', () => {
  it('selecciona exactamente el rango desde el ancla, en los dos sentidos, y conserva el ancla', () => {
    let s = run([
      { type: 'click', id: ID(4) },
      { type: 'shift', id: ID(7) },
    ]);
    expect(ids(s)).toEqual([ID(4), ID(5), ID(6), ID(7)]);
    expect(s.anchor).toBe(ID(4));
    // Otro Shift reemplaza el rango (no lo acumula) y sigue anclado en el 4.
    s = reduceSelection(s, { type: 'shift', id: ID(2) }, ORDER);
    expect(ids(s)).toEqual([ID(2), ID(3), ID(4)]);
    expect(s.anchor).toBe(ID(4));
  });

  it('es determinista: depende solo del orden recibido', () => {
    const reversed = [...ORDER].reverse();
    const a = run(
      [
        { type: 'click', id: ID(4) },
        { type: 'shift', id: ID(7) },
      ],
      reversed,
    );
    expect([...a.selected].sort()).toEqual([ID(4), ID(5), ID(6), ID(7)]);
    // Con el mismo orden, el mismo resultado siempre.
    const b = run(
      [
        { type: 'click', id: ID(4) },
        { type: 'shift', id: ID(7) },
      ],
      reversed,
    );
    expect([...b.selected]).toEqual([...a.selected]);
  });

  it('sin ancla, o con un ancla que ya no está en el resultado, actúa como un clic', () => {
    expect(ids(run([{ type: 'shift', id: ID(3) }]))).toEqual([ID(3)]);
    const withAnchor = run([{ type: 'click', id: ID(9) }]);
    const shorter = ORDER.filter((id) => id !== ID(9));
    const s = reduceSelection(withAnchor, { type: 'shift', id: ID(3) }, shorter);
    expect(ids(s)).toEqual([ID(3)]);
    expect(s.anchor).toBe(ID(3));
  });

  it('un elemento que no está en el resultado no cambia nada', () => {
    const before = run([{ type: 'click', id: ID(2) }]);
    expect(reduceSelection(before, { type: 'shift', id: ID(99) }, ORDER)).toBe(before);
  });
});

describe('selección: Ctrl+A, Esc e intersección', () => {
  it('Ctrl+A selecciona todo el resultado actual y conserva el ancla', () => {
    const s = run([{ type: 'click', id: ID(3) }, { type: 'all' }]);
    expect(ids(s)).toEqual(ORDER);
    expect(s.anchor).toBe(ID(3));
  });

  it('Esc limpia la selección y el ancla', () => {
    const s = run([{ type: 'click', id: ID(3) }, { type: 'all' }, { type: 'escape' }]);
    expect(s.selected.size).toBe(0);
    expect(s.anchor).toBeNull();
  });

  it('al cambiar la consulta se conserva la intersección con el resultado nuevo', () => {
    const s = run([{ type: 'click', id: ID(2) }, { type: 'ctrl', id: ID(5) }, { type: 'all' }]);
    const narrowed = [ID(5), ID(6), ID(7)];
    const next = reduceSelection(s, { type: 'intersect' }, narrowed);
    expect([...next.selected].sort()).toEqual([ID(5), ID(6), ID(7)]);
    // El ancla (5) sigue en el resultado.
    expect(next.anchor).toBe(ID(5));
    const gone = reduceSelection(
      run([{ type: 'click', id: ID(2) }]),
      { type: 'intersect' },
      narrowed,
    );
    expect(gone.selected.size).toBe(0);
    expect(gone.anchor).toBeNull();
  });

  it('la intersección sin cambios devuelve el mismo estado (sin renders de más)', () => {
    const s = run([{ type: 'click', id: ID(2) }]);
    expect(reduceSelection(s, { type: 'intersect' }, ORDER)).toBe(s);
  });
});

describe('useSelectionStore', () => {
  it('aplica el reductor con el orden recibido', () => {
    useSelectionStore.setState({ ...EMPTY_SELECTION });
    const { dispatch } = useSelectionStore.getState();
    dispatch({ type: 'click', id: ID(1) }, ORDER);
    dispatch({ type: 'shift', id: ID(3) }, ORDER);
    expect([...useSelectionStore.getState().selected]).toEqual([ID(1), ID(2), ID(3)]);
    dispatch({ type: 'escape' }, ORDER);
    expect(useSelectionStore.getState().selected.size).toBe(0);
  });
});
