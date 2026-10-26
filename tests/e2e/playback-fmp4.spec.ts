// Reproducción de vídeo importado por vault://media con Range (docs/PLAN.md 2.13; docs/DESIGN.md
// §11 y §18.4, versión de F2). Un MOV mpeg4 convertido a MP4 fragmentado (VP9) y los MKV VP9 + Opus y
// VP9 + FLAC remultiplexados se reproducen en un <video> con `duration` finita igual a la de origen
// (± 0,5 s), y buscar al 75 % dispara `seeked` en menos de 3 s. F2 no tiene visor, así que el <video>
// se crea en la página (la CSP deja `media-src vault:`). Si esto falla, el diseño se reabre (R4).
import { expect, test } from '@playwright/test';
import type { GaleriaApi } from '@shared/ipc-contract';
import {
  copyFixture,
  expectItemCount,
  fixture,
  importAndSummarize,
  launchUnlocked,
  newSourceDir,
  removeDir,
  startImportFromMenu,
  waitForSummary,
  closeSummary,
} from './helpers/library';
import type { LaunchedApp } from './helpers/launch';

let launched: LaunchedApp;
let src: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  launched = await launchUnlocked();
  src = newSourceDir();
  const { page, app } = launched;

  // El MOV mpeg4 se recodifica (D8): se confirma la conversión.
  const mov = copyFixture('movMpeg4', src);
  await startImportFromMenu(page, app, [mov]);
  await page
    .getByRole('alertdialog', { name: 'Convertir vídeos' })
    .getByRole('button', { name: 'Convertir y borrar originales' })
    .click();
  expect((await waitForSummary(page, 120_000)).imported).toBe(1);
  await closeSummary(page);

  const mkvs = [copyFixture('mkvVp9Opus', src), copyFixture('mkvVp9Flac', src)];
  expect((await importAndSummarize(page, app, mkvs)).imported).toBe(2);
  await expectItemCount(page, 3);
});

test.afterAll(async () => {
  removeDir(src);
  await launched?.close();
});

interface PlaybackResult {
  name: string;
  mime: string;
  duration: number;
  seekedMs: number;
  seekedTo: number;
  advanced: boolean;
}

const CASES = [
  { name: 'video-mpeg4', fixture: 'movMpeg4', label: 'MOV mpeg4 convertido a MP4 fragmentado VP9' },
  { name: 'video-vp9-opus', fixture: 'mkvVp9Opus', label: 'MKV VP9 + Opus remultiplexado' },
  { name: 'video-vp9-flac', fixture: 'mkvVp9Flac', label: 'MKV VP9 + FLAC remultiplexado' },
] as const;

test('el <video> pide rangos a vault://media y la búsqueda recibe respuestas 206 con Content-Range', async () => {
  const { page } = launched;
  const seen: { status: number; range: string | undefined; contentRange: string | undefined }[] =
    [];
  const onResponse = async (response: import('@playwright/test').Response): Promise<void> => {
    if (!response.url().startsWith('vault://media/')) return;
    const headers = await response.allHeaders();
    seen.push({
      status: response.status(),
      range: response.request().headers()['range'],
      contentRange: headers['content-range'],
    });
  };
  page.on('response', onResponse);
  try {
    await page.evaluate(async () => {
      const listed = await (window as unknown as { galeria: GaleriaApi }).galeria.invoke(
        'media:list',
        {
          kind: 'video',
          sort: { field: 'name', dir: 'asc' },
        },
      );
      const id = listed.ok ? listed.data.items[0]?.id : undefined;
      if (!id) throw new Error('sin vídeos');
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = `vault://media/${id}`;
      document.body.appendChild(video);
      await new Promise<void>((resolve) =>
        video.addEventListener('loadedmetadata', () => resolve(), { once: true }),
      );
      const seeked = new Promise<void>((resolve) =>
        video.addEventListener('seeked', () => resolve(), { once: true }),
      );
      video.currentTime = video.duration * 0.75;
      await seeked;
      video.remove();
    });
  } finally {
    page.off('response', onResponse);
  }
  console.log(`[e2e] respuestas de vault://media: ${JSON.stringify(seen)}`);
  expect(seen.length).toBeGreaterThan(0);
  const ranged = seen.filter((r) => r.range?.startsWith('bytes='));
  expect(ranged.length).toBeGreaterThan(0);
  for (const r of ranged) {
    expect(r.status).toBe(206);
    expect(r.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);
  }
});
for (const c of CASES) {
  test(`${c.label}: duración finita igual a la de origen y búsqueda con Range en menos de 3 s`, async () => {
    const result = await launched.page.evaluate(async (wanted): Promise<PlaybackResult> => {
      const listed = await (window as unknown as { galeria: GaleriaApi }).galeria.invoke(
        'media:list',
        {
          kind: 'video',
          sort: { field: 'name', dir: 'asc' },
        },
      );
      if (!listed.ok) throw new Error(`media:list ${listed.error.code}`);
      const item = listed.data.items.find((i) => i.name === wanted);
      if (!item) throw new Error(`no hay un medio llamado ${wanted}`);
      const detail = await (window as unknown as { galeria: GaleriaApi }).galeria.invoke(
        'media:get',
        { id: item.id },
      );
      if (!detail.ok) throw new Error(`media:get ${detail.error.code}`);

      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';
      video.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;z-index:1';
      const waitFor = (event: string, ms: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${event}: sin respuesta en ${ms} ms`)),
            ms,
          );
          video.addEventListener(
            event,
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          video.addEventListener(
            'error',
            () => {
              clearTimeout(timer);
              reject(new Error(`error de <video>: ${video.error?.code} ${video.error?.message}`));
            },
            { once: true },
          );
        });
      const loaded = waitFor('loadedmetadata', 10_000);
      video.src = `vault://media/${item.id}`;
      document.body.appendChild(video);
      await loaded;
      const duration = video.duration;

      const target = duration * 0.75;
      const seeked = waitFor('seeked', 3_000);
      const t0 = performance.now();
      video.currentTime = target;
      await seeked;
      const seekedMs = performance.now() - t0;
      const seekedTo = video.currentTime;

      // Reproduce un instante desde ahí: el tiempo avanza.
      await video.play();
      const from = video.currentTime;
      await new Promise((r) => setTimeout(r, 400));
      const advanced = video.currentTime > from || video.ended;
      video.pause();
      video.remove();
      return { name: item.name, mime: detail.data.mime, duration, seekedMs, seekedTo, advanced };
    }, c.name);

    const expected = fixture(c.fixture).seconds ?? 4;
    expect(result.mime).toBe('video/mp4');
    expect(Number.isFinite(result.duration)).toBe(true);
    expect(Math.abs(result.duration - expected)).toBeLessThanOrEqual(0.5);
    expect(result.seekedMs).toBeLessThan(3_000);
    expect(Math.abs(result.seekedTo - result.duration * 0.75)).toBeLessThan(0.6);
    expect(result.advanced).toBe(true);
  });
}
