// Cabecera Range (docs/DESIGN.md §11.2), pura. P = tamaño del plaintext.
//
// - Formas aceptadas: `bytes=a-b`, `bytes=a-` y `bytes=-n`, con enteros decimales sin signo.
// - Varios rangos o sintaxis inválida (incluido a > b): se ignora la cabecera → 200 completo.
// - P = 0 con un Range válido → 416 (`bytes */0`).
// - a ≥ P → 416; `bytes=-0` → 416.
// - `bytes=-n` con n > P → [0, P − 1]; b ≥ P se recorta a P − 1.

export type RangeResult =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

const SINGLE = /^bytes=(\d*)-(\d*)$/;

/** Interpreta `header` para un cuerpo de `size` bytes. `end` es inclusivo. */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('tamaño inválido');
  if (header === null || header === undefined) return { kind: 'full' };
  const m = SINGLE.exec(header.trim());
  if (!m) return { kind: 'full' }; // sintaxis inválida o varios rangos
  const [, first = '', last = ''] = m;
  if (first === '' && last === '') return { kind: 'full' };

  if (first === '') {
    // bytes=-n: los últimos n bytes.
    const n = Number(last);
    if (size === 0 || n === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: n >= size ? 0 : size - n, end: size - 1 };
  }

  const a = Number(first);
  const b = last === '' ? null : Number(last);
  if (b !== null && a > b) return { kind: 'full' };
  if (size === 0 || a >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start: a, end: b === null || b >= size ? size - 1 : b };
}

/** `Content-Range` de una respuesta 206. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** `Content-Range` de una respuesta 416. */
export function unsatisfiedRange(size: number): string {
  return `bytes */${size}`;
}
