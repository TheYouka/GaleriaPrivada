// Esc en el visor y el editor (docs/DESIGN.md §16.1, §16.4; PLAN.md nota 159): mientras el editor
// guarda, Esc se ignora (antes cerraba el editor a mitad del guardado y un error se perdía).
import { describe, expect, it } from 'vitest';
import {
  escapeAction,
  type EscapeState,
} from '../../../src/renderer/src/screens/viewer/viewer-keys';

const base: EscapeState = { phase: 'open', mode: 'view', editorSaving: false, zoomed: false };

describe('escapeAction', () => {
  it('en el editor: Esc cancela la edición, salvo mientras se guarda', () => {
    expect(escapeAction({ ...base, mode: 'edit' })).toBe('leave-editor');
    expect(escapeAction({ ...base, mode: 'edit', editorSaving: true })).toBe('none');
    // Con zoom de fondo sigue siendo el editor el que decide.
    expect(escapeAction({ ...base, mode: 'edit', editorSaving: true, zoomed: true })).toBe('none');
  });

  it('en el visor: con zoom vuelve a ajustar; sin zoom cierra', () => {
    expect(escapeAction({ ...base, zoomed: true })).toBe('reset-zoom');
    expect(escapeAction(base)).toBe('close');
    // editorSaving no afecta fuera del editor.
    expect(escapeAction({ ...base, editorSaving: true })).toBe('close');
  });

  it('durante la animación de apertura o de cierre no hace nada', () => {
    for (const phase of ['opening', 'closing'] as const) {
      expect(escapeAction({ ...base, phase })).toBe('none');
      expect(escapeAction({ ...base, phase, mode: 'edit' })).toBe('none');
    }
  });
});
