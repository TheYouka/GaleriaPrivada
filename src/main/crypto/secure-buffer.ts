// Búferes para claves (docs/DESIGN.md §6.7). Ninguna clave sale de Buffer.allocUnsafe ni de
// Buffer.from(string), que usan el pool compartido: ponerlas a cero borraría solo una vista y otros
// datos podrían compartir esa memoria. Buffer.alloc() siempre reserva memoria propia.
//
// Límites (documentados en §6.7): el GC puede haber copiado los bytes antes de ponerlos a cero, no
// hay mlock y OpenSSL guarda su propia copia de la clave en cada contexto hasta que el GC lo libera.
import { randomFillSync } from 'node:crypto';

export const KEY_LEN = 32;

/** 32 bytes a cero con memoria propia (fuera del pool). */
export function alloc32(): Buffer {
  return Buffer.alloc(KEY_LEN);
}

/** n bytes aleatorios con memoria propia (fuera del pool). */
export function randomOwned(n: number): Buffer {
  return randomFillSync(Buffer.alloc(n));
}

/** Copia `src` a un búfer propio y pone `src` a cero (salida de decipher.update, §6.7). */
export function takeOwned(src: Buffer): Buffer {
  const out = Buffer.alloc(src.length);
  src.copy(out);
  src.fill(0);
  return out;
}

/** Pone a cero todos los búferes que reciba; tolera null/undefined (rutas de error). */
export function zeroize(...bufs: (Uint8Array | null | undefined)[]): void {
  for (const b of bufs) b?.fill(0);
}

/** true si todos los bytes son cero (tests y comprobaciones defensivas). */
export function isZeroed(buf: Uint8Array): boolean {
  for (const byte of buf) if (byte !== 0) return false;
  return true;
}
