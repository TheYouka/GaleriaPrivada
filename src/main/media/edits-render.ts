// Render de ediciones en main para las miniaturas (docs/DESIGN.md §16.3). Todo en memoria: entra
// el original descifrado (buffer) y sale el WebP de la miniatura; libvips no escribe temporales
// (sharp-loader.ts fija VIPS_DISC_THRESHOLD antes de cargarlo y aquí todo es toBuffer()).
//
// PLAN B DE DOS PASADAS (PLAN.md, nota 139). La cadena documentada
//   autoOrient().flop(flip).rotate(q2·90).extract(región).resize(512, 512, inside).webp(78)
// no da el orden documentado con sharp 0.35.5 / libvips 8.18.7: con q2 = 0 y flip, sharp aplica el
// `extract` ANTES del `flop` (el test de píxeles de 4×2 lo detecta: 24 de las 30 regiones de ese
// estado salen espejadas). Por eso se hace en dos pasadas, como prevé §16.3:
//   1. autoOrient().flop(flip).rotate(q2·90) → PNG sin pérdida en memoria (sin extract, el orden
//      flop → rotación de sharp coincide con F ∘ R^q = R^(−q) ∘ F en los 8 estados y con las 8
//      orientaciones EXIF);
//   2. extract(región en píxeles del marco orientado) + resize(512, 512, inside, sin ampliar) →
//      WebP q78.
// El PNG intermedio (píxeles descifrados) se pone a cero en cuanto se ha usado. Sin ediciones
// (estado identidad) basta una pasada, igual que la miniatura de la importación.
import { AppErrorException } from '@shared/errors';
import { MAX_INPUT_PIXELS } from '@shared/constants';
import { cropRegion, isIdentity, sharpParams, type EditState } from '@shared/edits';
import { getSharp } from './sharp-loader';
import { THUMB_SIZE_PX, THUMB_WEBP_QUALITY } from './thumbnails';

export interface RenderEditsOptions {
  /** Solo para los tests de píxeles: WebP sin pérdida en lugar de q78. */
  lossless?: boolean;
}

const INPUT = { sequentialRead: true, limitInputPixels: MAX_INPUT_PIXELS } as const;
const RESIZE = { fit: 'inside', withoutEnlargement: true } as const;

/** Compresión del PNG intermedio: 1 es la más rápida con deflate (es solo memoria). */
const INTERMEDIATE_PNG_LEVEL = 1;

function renderFailed(): AppErrorException {
  // §16.5: sharp no decodifica o no renderiza → INTERNAL (sin cambios; el llamador registra warn).
  return new AppErrorException({ code: 'INTERNAL', details: { reason: 'render' } });
}

/** Miniatura WebP de la foto `buffer` con las ediciones `state` (§16.3, render en main). */
export async function renderEdits(
  buffer: Buffer,
  state: EditState,
  options: RenderEditsOptions = {},
): Promise<Buffer> {
  const sharp = await getSharp();
  const webp = options.lossless ? { lossless: true } : { quality: THUMB_WEBP_QUALITY };

  if (isIdentity(state)) {
    try {
      return await sharp(buffer, INPUT)
        .autoOrient()
        .resize(THUMB_SIZE_PX, THUMB_SIZE_PX, RESIZE)
        .webp(webp)
        .toBuffer();
    } catch {
      throw renderFailed();
    }
  }

  const { flop, angle } = sharpParams(state);
  let oriented: { data: Buffer; info: { width: number; height: number } };
  try {
    // Pasada 1: orientación (EXIF, después flop y después la rotación) a PNG sin pérdida.
    oriented = await sharp(buffer, INPUT)
      .autoOrient()
      .flop(flop)
      .rotate(angle)
      .png({ compressionLevel: INTERMEDIATE_PNG_LEVEL })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw renderFailed();
  }
  try {
    // Pasada 2: recorte en píxeles del marco orientado (W' × H' = el PNG) y miniatura.
    const region = cropRegion(state.crop, oriented.info.width, oriented.info.height);
    return await sharp(oriented.data, INPUT)
      .extract(region)
      .resize(THUMB_SIZE_PX, THUMB_SIZE_PX, RESIZE)
      .webp(webp)
      .toBuffer();
  } catch {
    throw renderFailed();
  } finally {
    oriented.data.fill(0);
  }
}
