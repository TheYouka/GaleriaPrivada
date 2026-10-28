// Reductor de la selección de la galería (docs/DESIGN.md §14.6, PLAN.md 2.12): clic, toggle, Shift con
// ancla sobre el orden total, Ctrl+A, Esc e intersección al cambiar la consulta.
import { describe, expect, it } from 'vitest';
import {
  createSelectionStore,
  EMPTY_SELECTION,
  isSelecting,
  reduceSelection,
  tileClickAction,
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
      { type: 'toggle', id: ID(4) },
      { type: 'toggle', id: ID(6) },
    ]);
    expect(ids(s)).toEqual([ID(2), ID(4), ID(6)]);
    expect(s.anchor).toBe(ID(6));
    s = reduceSelection(s, { type: 'toggle', id: ID(4) }, ORDER);
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
    const s = run([{ type: 'click', id: ID(2) }, { type: 'toggle', id: ID(5) }, { type: 'all' }]);
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

describe('modo selección (PLAN.md nota 192)', () => {
  it('toggle que deja el conjunto vacío vuelve a EMPTY_SELECTION (ancla null)', () => {
    const s = run([
      { type: 'toggle', id: ID(3) },
      { type: 'toggle', id: ID(3) },
    ]);
    expect(s).toBe(EMPTY_SELECTION);
    expect(s.anchor).toBeNull();
    expect(isSelecting(s)).toBe(false);
  });

  it('con una selección vacía, Mayús+clic actúa como un clic (no hay ancla)', () => {
    const emptied = run([
      { type: 'toggle', id: ID(3) },
      { type: 'toggle', id: ID(3) },
      { type: 'shift', id: ID(6) },
    ]);
    expect(ids(emptied)).toEqual([ID(6)]);
    expect(emptied.anchor).toBe(ID(6));
  });

  it('tileClickAction: un clic simple alterna (nunca abre), con y sin selección', () => {
    const none = { ctrl: false, meta: false, shift: false };
    expect(tileClickAction(none, ID(2))).toEqual({ type: 'toggle', id: ID(2) });
    // Con la selección vacía y con elementos marcados el resultado es el mismo.
    expect(isSelecting(EMPTY_SELECTION)).toBe(false);
    expect(isSelecting(run([{ type: 'toggle', id: ID(1) }]))).toBe(true);
    expect(tileClickAction(none, ID(2))).not.toBeNull();
  });

  it('tileClickAction: Ctrl y Meta alternan; Mayús marca el rango', () => {
    const base = { ctrl: false, meta: false, shift: false };
    expect(tileClickAction({ ...base, ctrl: true }, ID(2))).toEqual({ type: 'toggle', id: ID(2) });
    expect(tileClickAction({ ...base, meta: true }, ID(2))).toEqual({ type: 'toggle', id: ID(2) });
    expect(tileClickAction({ ...base, shift: true }, ID(2))).toEqual({ type: 'shift', id: ID(2) });
  });

  it('un clic desde el modo normal marca; clics siguientes alternan; el último deselecciona y vuelve al modo normal', () => {
    let s = EMPTY_SELECTION;
    const click = (id: string): void => {
      s = reduceSelection(
        s,
        tileClickAction({ ctrl: false, meta: false, shift: false }, id),
        ORDER,
      );
    };
    // Sin selección el clic ya marca (no abre).
    click(ID(2));
    expect(ids(s)).toEqual([ID(2)]);
    expect(isSelecting(s)).toBe(true);
    click(ID(4));
    click(ID(5));
    expect(ids(s)).toEqual([ID(2), ID(4), ID(5)]);
    click(ID(4));
    expect(ids(s)).toEqual([ID(2), ID(5)]);
    click(ID(2));
    click(ID(5));
    expect(isSelecting(s)).toBe(false);
    expect(s).toBe(EMPTY_SELECTION);
  });
  it('Mayús+clic marca el rango desde el ancla y Ctrl+clic alterna dentro de él', () => {
    const s = run([
      { type: 'toggle', id: ID(2) },
      { type: 'shift', id: ID(5) },
      { type: 'toggle', id: ID(3) },
    ]);
    expect(ids(s)).toEqual([ID(2), ID(4), ID(5)]);
  });
});

describe('restore (doble clic sin retrasar los clics)', () => {
  const snapshotOf = (s: SelectionState): SelectionState => ({
    selected: new Set(s.selected),
    anchor: s.anchor,
  });
  const same = (a: SelectionState, b: SelectionState): void => {
    expect([...a.selected].sort()).toEqual([...b.selected].sort());
    expect(a.anchor).toBe(b.anchor);
  };

  it('devuelve el estado de la instantánea', () => {
    const before = run([
      { type: 'toggle', id: ID(1) },
      { type: 'toggle', id: ID(4) },
    ]);
    const mid = reduceSelection(before, { type: 'toggle', id: ID(7) }, ORDER);
    const restored = reduceSelection(mid, { type: 'restore', state: before }, ORDER);
    same(restored, before);
  });

  it('recorta ids ausentes y pone el ancla a null si ya no está', () => {
    const snap = run([
      { type: 'toggle', id: ID(1) },
      { type: 'toggle', id: ID(9) },
    ]);
    const shorter = ORDER.filter((id) => id !== ID(9));
    const s = reduceSelection(EMPTY_SELECTION, { type: 'restore', state: snap }, shorter);
    expect(ids(s)).toEqual([ID(1)]);
    expect(s.anchor).toBeNull();
  });

  it('una instantánea vacía (o sin ids presentes) deja EMPTY_SELECTION', () => {
    const current = run([{ type: 'toggle', id: ID(3) }]);
    expect(reduceSelection(current, { type: 'restore', state: EMPTY_SELECTION }, ORDER)).toBe(
      EMPTY_SELECTION,
    );
    const gone = run([{ type: 'toggle', id: ID(99) }], [ID(99)]);
    expect(reduceSelection(current, { type: 'restore', state: gone }, ORDER)).toBe(EMPTY_SELECTION);
  });

  it('un estado igual al actual devuelve la misma referencia', () => {
    const current = run([
      { type: 'toggle', id: ID(2) },
      { type: 'toggle', id: ID(5) },
    ]);
    expect(reduceSelection(current, { type: 'restore', state: snapshotOf(current) }, ORDER)).toBe(
      current,
    );
    expect(
      reduceSelection(EMPTY_SELECTION, { type: 'restore', state: EMPTY_SELECTION }, ORDER),
    ).toBe(EMPTY_SELECTION);
  });

  it.each([
    ['vacía', [] as SelectionAction[]],
    [
      'con otros elementos marcados',
      [
        { type: 'toggle', id: ID(1) },
        { type: 'toggle', id: ID(6) },
      ] as SelectionAction[],
    ],
    ['sobre un elemento ya marcado', [{ type: 'toggle', id: ID(3) }] as SelectionAction[]],
  ])('doble clic simulado (toggle, toggle, restore) deja la selección intacta: %s', (_n, setup) => {
    const before = run(setup);
    // El doble clic alterna dos veces el elemento 3 (o lo marca y lo desmarca) y restaura la
    // instantánea tomada antes del primer clic.
    const snapshot = snapshotOf(before);
    let s = reduceSelection(before, { type: 'toggle', id: ID(3) }, ORDER);
    s = reduceSelection(s, { type: 'toggle', id: ID(3) }, ORDER);
    s = reduceSelection(s, { type: 'restore', state: snapshot }, ORDER);
    same(s, before);
  });

  it('doble clic sobre el único elemento marcado: el primer clic vacía y la restauración lo devuelve', () => {
    const before = run([{ type: 'toggle', id: ID(3) }]);
    const snapshot = snapshotOf(before);
    let s = reduceSelection(before, { type: 'toggle', id: ID(3) }, ORDER);
    expect(s).toBe(EMPTY_SELECTION);
    s = reduceSelection(s, { type: 'restore', state: snapshot }, ORDER);
    same(s, before);
  });
});

describe('createSelectionStore', () => {
  it('crea almacenes independientes (el de las playlists no toca el de la galería)', () => {
    useSelectionStore.setState({ ...EMPTY_SELECTION });
    const other = createSelectionStore();
    other.getState().dispatch({ type: 'toggle', id: ID(2) }, ORDER);
    expect(other.getState().selected.has(ID(2))).toBe(true);
    expect(useSelectionStore.getState().selected.size).toBe(0);
    useSelectionStore.getState().dispatch({ type: 'toggle', id: ID(5) }, ORDER);
    expect([...other.getState().selected]).toEqual([ID(2)]);
    useSelectionStore.setState({ ...EMPTY_SELECTION });
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
