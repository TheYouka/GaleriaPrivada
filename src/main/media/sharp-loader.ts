// Único punto de carga de sharp (docs/DESIGN.md §12.4, paso 4). En el resto de src/ ESLint prohíbe
// importarlo (salvo los tipos) y el import() dinámico.
//
// libvips descomprime a un archivo temporal (%TEMP%/$TMPDIR, "vips-*.v") cuando una carga necesita
// acceso aleatorio y la imagen descomprimida supera VIPS_DISC_THRESHOLD (100 MB por defecto).
// 4g > 268 MP × 4 canales × 2 B ≈ 2,1 GB, el máximo que admite limitInputPixels: nunca usa disco.
//
// Se carga de forma perezosa con import() porque Rollup coloca los require() estáticos de los
// módulos externos al principio del bundle de main, y así no se podría garantizar que la variable
// esté puesta antes de cargar libvips. Todas las llamadas pasan
// { sequentialRead: true, limitInputPixels: MAX_INPUT_PIXELS } de forma explícita.
import type SharpModule from 'sharp';

export type Sharp = typeof SharpModule;

let loading: Promise<Sharp> | undefined;

async function load(): Promise<Sharp> {
  process.env.VIPS_DISC_THRESHOLD = '4g'; // antes de cargar libvips
  const mod = (await import('sharp')).default;
  mod.cache(false); // sin caché de operaciones con píxeles descifrados (§6.7)
  return mod;
}

/** Siempre la misma instancia; la primera llamada fija VIPS_DISC_THRESHOLD y desactiva la caché. */
export function getSharp(): Promise<Sharp> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined; // permite reintentar si la carga falló
    throw err;
  });
  return loading;
}
