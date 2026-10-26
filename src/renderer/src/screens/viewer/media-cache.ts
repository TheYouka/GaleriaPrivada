// Datos del visor que se piden una vez por medio abierto: el detalle (media:get: ediciones, EXIF…) y
// la precarga de los vecinos ±1 (§16.1: `decode()` en fotos y solo el póster en vídeos).
import type { Id, MediaDetail } from '@shared/types';
import { invoke } from '../../lib/ipc';

const details = new Map<Id, Promise<MediaDetail | null>>();

/** media:get del medio; null si falla (el visor sigue con los datos de la lista). */
export function loadDetail(id: Id): Promise<MediaDetail | null> {
  let cached = details.get(id);
  if (!cached) {
    cached = invoke('media:get', { id }).then((res) => (res.ok ? res.data : null));
    details.set(id, cached);
    void cached.then((d) => {
      if (d === null && details.get(id) === cached) details.delete(id);
    });
  }
  return cached;
}

/** Tras guardar o revertir: el detalle del medio pasa a ser este (sin volver a pedirlo a main). */
export function primeDetail(detail: MediaDetail): void {
  details.set(detail.id, Promise.resolve(detail));
}

const preloaded = new Map<string, HTMLImageElement>();

/** Precarga y decodifica estas URLs y suelta las que ya no hacen falta. */
export function preloadImages(urls: readonly string[]): void {
  const wanted = new Set(urls);
  for (const url of preloaded.keys()) {
    if (!wanted.has(url)) preloaded.delete(url);
  }
  for (const url of wanted) {
    if (preloaded.has(url)) continue;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    preloaded.set(url, img);
    // Un fallo aquí no importa: el visor lo volverá a pedir y mostrará su propio error.
    img.decode().catch(() => undefined);
  }
}

/** Al cerrar el visor se suelta todo. */
export function clearViewerCache(): void {
  details.clear();
  preloaded.clear();
}
