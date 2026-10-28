// Contenido de la Ayuda (docs/DESIGN.md §14.10 y §24.2, PLAN.md 2.12): los 13 límites en el orden del
// diseño, la línea del riesgo aceptado v3-1 y la tabla de atajos.
import { describe, expect, it } from 'vitest';
import {
  HELP_CAMERA_VIDEO_NOTE,
  HELP_LIMITS,
  HELP_SHORTCUT_GROUPS,
} from '@renderer/screens/help/help-content';
// DESIGN.md como texto (import ?raw de Vite): este directorio no tiene los tipos de Node.
import designMd from '../../../docs/DESIGN.md?raw';

/** Los límites numerados de §24.2 de DESIGN.md, sin el formato markdown. */
function designLimits(): string[] {
  const md = designMd;
  const start = md.indexOf('### 24.2 Límites documentados');
  const end = md.indexOf('\n## 25.', start);
  return md
    .slice(start, end)
    .split('\n')
    .filter((line: string) => /^\d+\. \*\*/.test(line))
    .map((line: string) => line.replace(/^\d+\. /, '').replace(/\*\*|`/g, ''));
}

describe('Ayuda', () => {
  it('tiene los 13 límites de §24.2, en orden y con el comienzo del texto del diseño', () => {
    const design = designLimits();
    expect(design).toHaveLength(13);
    expect(HELP_LIMITS).toHaveLength(13);
    HELP_LIMITS.forEach((limit, i) => {
      const text = `${limit.title} ${limit.body}`;
      expect(text.slice(0, 70), `límite ${i + 1}`).toBe((design[i] as string).slice(0, 70));
    });
  });

  it('el límite 10 es el de D18: el bloqueo por inactividad se pausa también al importar', () => {
    const tenth = HELP_LIMITS[9] as { title: string; body: string };
    expect(tenth.title).toBe('El bloqueo por inactividad se pausa');
    expect(tenth.body).toContain('una importación o una fusión de vídeos en curso');
    expect(tenth.body).toContain('cancelan lo que esté en curso');
  });

  it('lleva la línea del riesgo aceptado v3-1, tal cual', () => {
    expect(HELP_CAMERA_VIDEO_NOTE).toBe(
      'Algunos vídeos de cámara (H.264 de 10 bits o 4:2:2/4:4:4) podrían no reproducirse en Galería después de importarlos.',
    );
  });

  it('la tabla de atajos incluye todos los globales de §14.1', () => {
    const keys = HELP_SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.map((s) => s.keys));
    for (const global of ['Ctrl+L', 'Ctrl+I', 'Ctrl+Shift+I', 'Ctrl+F', 'F5', 'F1', 'Ctrl+,']) {
      expect(keys).toContain(global);
    }
    for (const grid of ['Ctrl+A', 'F2', 'Supr', 'Esc']) expect(keys).toContain(grid);
  });

  it('explica las reglas de clic: clic selecciona, doble clic o Intro abre, también en el detalle de una playlist', () => {
    const gallery = HELP_SHORTCUT_GROUPS.find((g) => g.title === 'En la galería');
    const playlist = HELP_SHORTCUT_GROUPS.find((g) => g.title === 'En el detalle de una playlist');
    for (const group of [gallery, playlist]) {
      const shortcuts = group?.shortcuts ?? [];
      const keys = shortcuts.map((s) => s.keys);
      for (const k of ['Clic', 'Doble clic o Intro', 'Espacio']) expect(keys).toContain(k);
      const click = shortcuts.find((s) => s.keys === 'Clic');
      expect(click?.action).toBe('Seleccionar o quitar de la selección');
      const open = shortcuts.find((s) => s.keys === 'Doble clic o Intro');
      expect(open?.action).toContain('Abrir');
    }
  });
});
