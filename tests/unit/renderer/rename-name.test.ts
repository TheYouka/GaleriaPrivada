// Validación del nombre al renombrar (docs/DESIGN.md §10.3, PLAN.md 2.12).
import { describe, expect, it } from 'vitest';
import { renameProblem } from '@renderer/screens/gallery/rename-name';

describe('renameProblem', () => {
  it('acepta nombres normales, con acentos y espacios', () => {
    expect(renameProblem('Cumpleaños de Marta')).toBeNull();
    expect(renameProblem('  playa  ')).toBeNull();
  });

  it('rechaza vacío, solo espacios y caracteres de control', () => {
    expect(renameProblem('')).not.toBeNull();
    expect(renameProblem('   ')).not.toBeNull();
    expect(renameProblem('a\u0007b')).not.toBeNull();
    expect(renameProblem('a\u0085b')).not.toBeNull();
  });

  it('el límite son 255 caracteres (code points), no unidades UTF-16', () => {
    expect(renameProblem('a'.repeat(255))).toBeNull();
    expect(renameProblem('a'.repeat(256))).not.toBeNull();
    expect(renameProblem('😀'.repeat(255))).toBeNull();
    expect(renameProblem('😀'.repeat(256))).not.toBeNull();
  });
});
