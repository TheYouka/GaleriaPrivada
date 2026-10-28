// Selección de la galería (docs/DESIGN.md §14.6, PLAN.md nota 192): `Set<Id>` + ancla. El reductor es
// puro y recibe el orden actual del resultado (total y estable, §9.2), así que el rango con Shift es
// determinista.
//   toggle      → alterna ese elemento (y pasa a ser el ancla); si deja el conjunto vacío se vuelve a
//                 EMPTY_SELECTION (ancla `null`): salir de la selección es un reinicio
//   shift       → exactamente el rango [ancla, elemento] en el orden actual (el ancla no cambia);
//                 sin ancla válida actúa como un clic
//   click       → solo ese elemento (Mayús+flechas sin ancla y menú contextual; ya no es el clic de ratón)
//   all         → todo el resultado actual (el ancla se conserva)
//   escape      → nada
//   intersect   → intersección con el resultado nuevo (el ancla se conserva si sigue en él)
//   restore     → vuelve a una instantánea guardada (la usa el doble clic: ver `tileClickAction`)
// Un clic en cualquier parte del mosaico SIEMPRE alterna ese elemento (nunca abre el visor); abrir es
// el doble clic o Intro (PLAN.md nota 195). `createSelectionStore`
// permite que el detalle de una playlist tenga su propia selección, sin mezclarla con la galería.
import { create } from 'zustand';
import type { Id } from '@shared/types';

export interface SelectionState {
  readonly selected: ReadonlySet<Id>;
  readonly anchor: Id | null;
}

export type SelectionAction =
  | { type: 'click'; id: Id }
  | { type: 'toggle'; id: Id }
  | { type: 'shift'; id: Id }
  | { type: 'all' }
  | { type: 'escape' }
  | { type: 'intersect' }
  | { type: 'restore'; state: SelectionState };

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
    case 'toggle': {
      const selected = new Set(state.selected);
      if (!selected.delete(action.id)) selected.add(action.id);
      return selected.size === 0 ? EMPTY_SELECTION : { selected, anchor: action.id };
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
    case 'restore': {
      const present = new Set(order);
      const selected = new Set<Id>();
      for (const id of action.state.selected) if (present.has(id)) selected.add(id);
      if (selected.size === 0)
        return state.selected.size === 0 && state.anchor === null ? state : EMPTY_SELECTION;
      const anchor =
        action.state.anchor !== null && present.has(action.state.anchor)
          ? action.state.anchor
          : null;
      if (
        anchor === state.anchor &&
        selected.size === state.selected.size &&
        [...selected].every((id) => state.selected.has(id))
      ) {
        return state;
      }
      return { selected, anchor };
    }
  }
}

/** ¿La selección está activa (modo selección)? Con ≥ 1 elemento marcado se ven todas las casillas y la barra. */
export function isSelecting(state: Pick<SelectionState, 'selected'>): boolean {
  return state.selected.size > 0;
}

/**
 * Acción de un clic simple en un mosaico. Mayús marca el rango; cualquier otro clic (con o sin
 * Ctrl/Meta) alterna ese elemento, haya o no selección. Un clic nunca abre: abrir es el doble clic
 * (o Intro), PLAN.md nota 195.
 */
export function tileClickAction(
  mods: { ctrl: boolean; meta: boolean; shift: boolean },
  id: Id,
): SelectionAction {
  if (mods.ctrl || mods.meta) return { type: 'toggle', id };
  if (mods.shift) return { type: 'shift', id };
  return { type: 'toggle', id };
}

export interface SelectionStore extends SelectionState {
  dispatch(action: SelectionAction, order: readonly Id[]): void;
}

/** Fábrica: la galería y el detalle de una playlist tienen almacenes independientes. */
export function createSelectionStore() {
  return create<SelectionStore>((set) => ({
    ...EMPTY_SELECTION,
    dispatch: (action, order) =>
      set((s) => {
        const next = reduceSelection(s, action, order);
        return next === s ? s : { selected: next.selected, anchor: next.anchor };
      }),
  }));
}

export const useSelectionStore = createSelectionStore();
