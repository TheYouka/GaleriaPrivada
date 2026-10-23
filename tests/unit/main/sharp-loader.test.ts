// Carga de sharp sin temporales en disco (docs/DESIGN.md §12.4, paso 4).
import { describe, expect, it, vi } from 'vitest';

// El factory se ejecuta cuando sharp se carga de verdad: así se ve el valor de la variable en ese
// momento, no después.
const seen = vi.hoisted(() => ({ envAtLoad: undefined as string | undefined, loads: 0 }));
vi.mock('sharp', async (importOriginal) => {
  seen.envAtLoad = process.env.VIPS_DISC_THRESHOLD;
  seen.loads += 1;
  return importOriginal();
});

import { getSharp } from '../../../src/main/media/sharp-loader';

describe('getSharp', () => {
  it('fija VIPS_DISC_THRESHOLD=4g antes de cargar sharp', async () => {
    delete process.env.VIPS_DISC_THRESHOLD;
    expect(seen.loads).toBe(0); // importar el loader no carga sharp
    await getSharp();
    expect(seen.loads).toBe(1);
    expect(seen.envAtLoad).toBe('4g');
    expect(process.env.VIPS_DISC_THRESHOLD).toBe('4g');
  });

  it('devuelve siempre la misma instancia (también con llamadas simultáneas)', async () => {
    const a = await getSharp();
    const [b, c] = await Promise.all([getSharp(), getSharp()]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(seen.loads).toBe(1);
  });

  it('sharp.cache() informa límites 0 (sin caché de operaciones)', async () => {
    const sharp = await getSharp();
    const cache = sharp.cache();
    expect(cache.memory.max).toBe(0);
    expect(cache.files.max).toBe(0);
    expect(cache.items.max).toBe(0);
  });

  it('la instancia funciona', async () => {
    const sharp = await getSharp();
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const meta = await sharp(png, { sequentialRead: true, limitInputPixels: 268402689 }).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(4);
  });
});
