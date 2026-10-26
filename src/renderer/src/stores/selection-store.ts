// Selección de la galería (docs/DESIGN.md §14.6): `Set<Id>` + ancla. El reductor es puro y recibe el
// orden actual del resultado (total y estable, §9.2), así que el rango con Shift es determinista.
//   clic        → solo ese elemento (y pasa a ser el ancla)
//   Ctrl+clic   → alterna ese elemento (y pasa a ser el ancla)
//   Shift+clic  → exactamente el rango [ancla, elemento] en el orden actual (el ancla no cambia);
//                 sin ancla válida actúa como un clic
//   Ctrl+A      → todo el resultado actual (el ancla se conserva)
//   Esc         → nada
//   consulta    → intersección con el resultado nuevo (el ancla se conserva si sigue en él)
import { create } from 'zustand';
import type { Id } from '@shared/types';

export interface SelectionState {
  readonly selected: ReadonlySet<Id>;
  readonly anchor: Id | null;
}

export type SelectionAction =
  | { type: 'click'; id: Id }
  | { type: 'ctrl'; id: Id }
  | { type: 'shift'; id: Id }
  | { type: 'all' }
  | { type: 'escape' }
  | { type: 'intersect' };

export const EMPTY_SELECTION: SelectionState = Object.freeze({
  selected: new Set<Id>(),
  anchor: null,
});

export function reduceSelection(
  state: SelectionState,
  action: SelectionAction,
  order: readonly Id[],
): SelectionState {
  switch (action.type) {
    case 'click':
      return { selected: new Set([action.id]), anchor: action.id };
    case 'ctrl': {
      const selected = new Set(state.selected);
      if (!selected.delete(action.id)) selected.add(action.id);
      return { selected, anchor: action.id };
    }
    case 'shift': {
      const to = order.indexOf(action.id);
      const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
      if (to === -1) return state;
      if (from === -1) return { selected: new Set([action.id]), anchor: action.id };
      const [a, b] = from <= to ? [from, to] : [to, from];
      return { selected: new Set(order.slice(a, b + 1)), anchor: state.anchor };
    }
    case 'all':
      return { selected: new Set(order), anchor: state.anchor };
    case 'escape':
      return state.selected.size === 0 && state.anchor === null ? state : EMPTY_SELECTION;
    case 'intersect': {
      if (state.selected.size === 0 && state.anchor === null) return state;
      const present = new Set(order);
      const selected = new Set<Id>();
      for (const id of state.selected) if (present.has(id)) selected.add(id);
      const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
      if (selected.size === state.selected.size && anchor === state.anchor) return state;
      return { selected, anchor };
    }
  }
}

interface SelectionStore extends SelectionState {
  dispatch(action: SelectionAction, order: readonly Id[]): void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  ...EMPTY_SELECTION,
  dispatch: (action, order) =>
    set((s) => {
      const next = reduceSelection(s, action, order);
      return next === s ? s : { selected: next.selected, anchor: next.anchor };
    }),
}));
