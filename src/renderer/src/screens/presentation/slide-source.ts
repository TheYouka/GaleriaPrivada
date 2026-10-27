// De dónde sale lo que se ve en cada diapositiva (docs/DESIGN.md §17.5; PLAN.md notas 147 y 152).
// Puro. Igual que el visor: el original se pide a `vault://media/<id>` y las ediciones de la Fase 3
// se aplican con CSS (`EditedImage` con `foldEdits(media:get.edits)`); el original no se toca. Un
// vídeo usa `vault://media/<id>` y su póster, `vault://thumb/<id>`.
import { foldEdits, identityState, isIdentity, type EditState } from '@shared/edits';
import type { EditOp, Id, MediaKind } from '@shared/types';
import { mediaUrl, thumbUrl } from '../../lib/vault-url';
import { editedAspect, fitContain, type Size } from '../viewer/zoom-math';
import type { SlideSpec } from './scheduler';

/** Lo que la presentación necesita de un elemento de la lista. */
export interface SlideItem {
  id: Id;
  kind: MediaKind;
  thumbRev: number;
  /** Dimensiones tras EXIF (null si no se conocen). */
  width: number | null;
  height: number | null;
}

export interface ResolvedSlide {
  id: Id;
  kind: MediaKind;
  /** `vault://media/<id>` (foto original o vídeo). */
  mediaUrl: string;
  /** `vault://thumb/<id>?rev=…`: póster del vídeo. */
  posterUrl: string;
  /** Ediciones guardadas (identidad en vídeos o si aún no hay `media:get`). */
  editState: EditState;
  /** La foto tiene ediciones que cambian la imagen: se dibuja con `EditedImage`. */
  edited: boolean;
  /** Las ediciones solo se conocen con `media:get`: las fotos lo piden antes de mostrarse. */
  needsDetail: boolean;
  /** Proporción mostrada (ancho/alto) con las ediciones; null si faltan las dimensiones. */
  aspect: number | null;
}

/**
 * `edits` = `MediaDetail.edits` (de `media:get`); null si todavía no se tiene o falló: la foto se
 * muestra sin editar, como hace el visor.
 */
export function resolveSlide(item: SlideItem, edits: readonly EditOp[] | null): ResolvedSlide {
  const photo = item.kind === 'photo';
  const editState = photo && edits ? foldEdits(edits) : identityState();
  const hasSize = item.width !== null && item.height !== null && item.width > 0 && item.height > 0;
  return {
    id: item.id,
    kind: item.kind,
    mediaUrl: mediaUrl(item.id),
    posterUrl: thumbUrl(item.id, item.thumbRev),
    editState,
    edited: photo && !isIdentity(editState),
    needsDetail: photo,
    aspect: hasSize ? editedAspect(editState, item.width as number, item.height as number) : null,
  };
}

/** Caja en px (la que recibe `EditedImage`) de la foto ajustada al escenario. */
export function slideBox(slide: Pick<ResolvedSlide, 'aspect'>, stage: Size): Size {
  return slide.aspect === null ? { w: 0, h: 0 } : fitContain(slide.aspect, stage);
}

/**
 * Entrada del planificador. `durations` da una duración propia (ms) a fotos concretas por id; el
 * resto usa `slideMs`.
 */
export function slideSpecs(
  items: readonly Pick<SlideItem, 'id' | 'kind'>[],
  durations?: ReadonlyMap<Id, number>,
): SlideSpec[] {
  return items.map((item) => {
    const own = item.kind === 'photo' ? durations?.get(item.id) : undefined;
    return own === undefined ? { kind: item.kind } : { kind: item.kind, durationMs: own };
  });
}
