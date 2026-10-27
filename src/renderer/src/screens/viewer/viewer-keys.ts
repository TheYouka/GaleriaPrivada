// Qué hace Esc en el visor (docs/DESIGN.md §16.1, §16.4). Puro: lo prueba
// tests/unit/renderer/viewer-keys.test.ts.
//
// - Durante la animación de apertura o de cierre, nada.
// - En el editor, cancela la edición, SALVO mientras se guarda: entonces se ignora, igual que
//   «Cancelar» (deshabilitado). Si no, el editor se cerraría a mitad del guardado y un error del
//   guardado se perdería (hallazgo LOW de la Fase 3, PLAN.md nota 159).
// - En el visor con zoom, vuelve a ajustar; sin zoom, cierra el visor.

export type EscapeAction = 'none' | 'leave-editor' | 'reset-zoom' | 'close';

export interface EscapeState {
  phase: 'opening' | 'open' | 'closing';
  mode: 'view' | 'edit';
  /** El editor está guardando (edits:save en curso). */
  editorSaving: boolean;
  zoomed: boolean;
}

export function escapeAction(s: EscapeState): EscapeAction {
  if (s.phase !== 'open') return 'none';
  if (s.mode === 'edit') return s.editorSaving ? 'none' : 'leave-editor';
  return s.zoomed ? 'reset-zoom' : 'close';
}
