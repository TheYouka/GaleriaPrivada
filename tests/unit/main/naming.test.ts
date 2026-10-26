// naming.ts (docs/DESIGN.md §12.4.1): los 6 casos del diseño y el pliegue de búsqueda.
import { describe, expect, it } from 'vitest';
import { cleanName, deriveName, foldName } from '../../../src/main/import/naming';

describe('deriveName (§12.4.1)', () => {
  it('".jpg" → "Sin nombre" + jpg', () => {
    expect(deriveName('.jpg', 'jpg')).toEqual({ name: 'Sin nombre', originalExt: 'jpg' });
  });

  it('un nombre de 300 code points con emojis → 255 code points sin pares rotos', () => {
    const stem = '😀a'.repeat(150); // 300 code points, 450 unidades UTF-16
    const { name, originalExt } = deriveName(`${stem}.png`, 'png');
    expect(originalExt).toBe('png');
    expect([...name]).toHaveLength(255);
    expect(name).toBe([...stem].slice(0, 255).join(''));
    expect(name.isWellFormed()).toBe(true);
  });

  it('"a\\nb.png" → "ab" + png (sin caracteres de control)', () => {
    expect(deriveName('a\nb.png', 'png')).toEqual({ name: 'ab', originalExt: 'png' });
    expect(deriveName('a\tb\u0007c.png', 'png').name).toBe('abc');
  });

  it('"archivo" (JPEG por firma) → "archivo" + jpg', () => {
    expect(deriveName('archivo', 'jpg')).toEqual({ name: 'archivo', originalExt: 'jpg' });
  });

  it('"foto.versión final" → el nombre entero + la extensión detectada', () => {
    expect(deriveName('foto.versión final', 'webp')).toEqual({
      name: 'foto.versión final',
      originalExt: 'webp',
    });
  });

  it('"IMG_0001.JPG" → "IMG_0001" + jpg', () => {
    expect(deriveName('IMG_0001.JPG', 'jpg')).toEqual({ name: 'IMG_0001', originalExt: 'jpg' });
  });

  it('otros: punto final, sufijo de más de 16, NFC y trim', () => {
    expect(deriveName('foto.', 'jpg')).toEqual({ name: 'foto.', originalExt: 'jpg' });
    expect(deriveName('x.abcdefghijklmnopq', 'mp4')).toEqual({
      name: 'x.abcdefghijklmnopq',
      originalExt: 'mp4',
    });
    expect(deriveName('  a\u0301lbum .MKV', 'mkv')).toEqual({ name: 'álbum', originalExt: 'mkv' });
    expect(deriveName('   .png', 'png').name).toBe('Sin nombre');
    expect(cleanName('\n')).toBe('Sin nombre');
  });
});

describe('foldName (§9.2)', () => {
  it('minúsculas y sin diacríticos, en NFC', () => {
    expect(foldName('Ñandú en el JARDÍN')).toBe('nandu en el jardin');
    expect(foldName('A\u0301rbol')).toBe('arbol');
  });
});
