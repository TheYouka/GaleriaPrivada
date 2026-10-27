// Lógica pura de la lista reordenable de una playlist (docs/DESIGN.md §14.8): mover un elemento,
// validar el nombre y los anuncios en español para el lector de pantalla (`announcements` de
// dnd-kit y el aviso de Alt+↑/↓). Sin React ni IPC, para probarla con Vitest.
import { PLAYLIST_NAME_MAX } from '@shared/constants';
import type { Id } from '@shared/types';

/** Mueve `id` `delta` posiciones (acotado a los extremos). Devuelve la lista nueva y su posición. */
export function moveId(
  ids: readonly Id[],
  id: Id,
  delta: number,
): { ids: Id[]; from: number; to: number } {
  const from = ids.indexOf(id);
  if (from === -1) return { ids: [...ids], from: -1, to: -1 };
  const to = Math.min(ids.length - 1, Math.max(0, from + delta));
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return { ids: next, from, to };
}

/** Pistas marcadas tras pulsar una casilla: se añade al final o se quita (orden de marcado). */
export function toggleTrack(assigned: readonly Id[], id: Id): Id[] {
  return assigned.includes(id) ? assigned.filter((t) => t !== id) : [...assigned, id];
}

/** Mueve el elemento de la posición `from` a `to` (como `arrayMove` de dnd-kit). */
export function moveIndex(ids: readonly Id[], from: number, to: number): Id[] {
  const next = [...ids];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as Id);
  return next;
}

/** `a` y `b` tienen los mismos ids en el mismo orden. */
export function sameOrder(a: readonly Id[], b: readonly Id[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Mensaje de validación del nombre de una playlist (las reglas de main, §10.3), o null. */
export function playlistNameProblem(raw: string): string | null {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0) return 'Escribe un nombre.';
  if ([...name].length > PLAYLIST_NAME_MAX) {
    return `El nombre admite como máximo ${PLAYLIST_NAME_MAX} caracteres.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    return 'El nombre no puede tener caracteres de control.';
  }
  return null;
}

export const REORDER_INSTRUCTIONS =
  'Para reordenar, pulsa Espacio o Intro sobre el asa, mueve el elemento con las flechas arriba y abajo, suéltalo con Espacio o cancela con Esc. También puedes mover una posición con Alt más flecha arriba o abajo.';

const position = (index: number, total: number): string => `posición ${index + 1} de ${total}`;

/** Anuncio de una pulsación de Alt+↑/↓ (o de que ya está en el extremo). */
export function announceMoved(name: string, to: number, total: number, moved: boolean): string {
  return moved
    ? `«${name}» movido a la ${position(to, total)}.`
    : `«${name}» ya está en la ${position(to, total)}; no se puede mover más.`;
}

export interface OrderNames {
  /** Nombre visible de un id (o `Elemento` si no se conoce). */
  nameOf(id: Id): string;
  /** Ids en el orden actual de la lista (sin el arrastre en curso). */
  order(): readonly Id[];
}

/** Los anuncios de dnd-kit: levantar, pasar por encima, soltar y cancelar. */
export function reorderAnnouncements(names: OrderNames) {
  const at = (id: Id): number => names.order().indexOf(id);
  const total = (): number => names.order().length;
  return {
    onDragStart: ({ active }: { active: { id: string | number } }): string =>
      `Elemento «${names.nameOf(String(active.id))}» levantado, ${position(at(String(active.id)), total())}.`,
    onDragOver: ({
      active,
      over,
    }: {
      active: { id: string | number };
      over: { id: string | number } | null;
    }): string | undefined =>
      // dnd-kit llama a onDragOver justo después de onDragStart con el propio elemento: sin
      // anuncio, para que no tape el de «levantado».
      over && over.id === active.id
        ? undefined
        : over
          ? `«${names.nameOf(String(active.id))}» está sobre la ${position(at(String(over.id)), total())}.`
          : `«${names.nameOf(String(active.id))}» ya no está sobre ninguna posición.`,
    onDragEnd: ({
      active,
      over,
    }: {
      active: { id: string | number };
      over: { id: string | number } | null;
    }): string =>
      over
        ? `«${names.nameOf(String(active.id))}» soltado en la ${position(at(String(over.id)), total())}.`
        : `«${names.nameOf(String(active.id))}» soltado sin cambios.`,
    onDragCancel: ({ active }: { active: { id: string | number } }): string =>
      `Movimiento cancelado. «${names.nameOf(String(active.id))}» vuelve a la ${position(at(String(active.id)), total())}.`,
  };
}
