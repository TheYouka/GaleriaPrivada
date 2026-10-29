// Ayudantes de los E2E de la fusión (docs/PLAN.md 5.1, 5.3 y 5.5; docs/DESIGN.md §18). La pantalla
// de vídeo dual (5.4) todavía no existe: la fusión se lanza con el preload real
// (`galeria.invoke('merge:start')`) y su resultado se espera con `galeria.on('merge:done')`, el mismo
// camino que usará MergeDialog.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Result } from '@shared/errors';
import type { GaleriaApi } from '@shared/ipc-contract';
import type { MergeRequest } from '@shared/types';
import { filesUnder, writeLongVideo } from './library';

type Api = { galeria: GaleriaApi };

export interface MergeOutcome {
  jobId: string | null;
  /** Respuesta de merge:start (BUSY, VALIDATION…). */
  start: Result<{ jobId: string }>;
  /** Payload de merge:done (null si no llegó en `timeoutMs`). */
  result: Result<{ mediaId: string; existed: boolean }> | null;
  progress: number[];
}

/** Id del medio con ese nombre (media:list de vídeos). */
export async function mediaIdByName(page: Page, name: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const listed = await (window as unknown as Api).galeria.invoke('media:list', {
      kind: 'all',
      sort: { field: 'name', dir: 'asc' },
    });
    if (!listed.ok) throw new Error(`media:list ${listed.error.code}`);
    const item = listed.data.items.find((i) => i.name === wanted);
    if (!item) throw new Error(`no hay un medio llamado ${wanted}`);
    return item.id;
  }, name);
}

/**
 * Empieza a escuchar merge:progress y merge:done en la página (antes de merge:start, para no perder
 * nada). `window.__mergeEvents` es solo del test.
 */
export async function listenMergeEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Api & {
      __mergeEvents?: { progress: number[]; done: unknown[] };
    };
    if (w.__mergeEvents) return;
    const store = { progress: [] as number[], done: [] as unknown[] };
    w.__mergeEvents = store;
    w.galeria.on('merge:progress', (p) => store.progress.push(p.fraction));
    w.galeria.on('merge:done', (d) => store.done.push(d));
  });
}

/** merge:start con el preload real. */
export async function startMerge(
  page: Page,
  req: MergeRequest,
): Promise<Result<{ jobId: string }>> {
  await listenMergeEvents(page);
  return page.evaluate(
    (r: MergeRequest) => (window as unknown as Api).galeria.invoke('merge:start', r),
    req,
  );
}

/** Espera el merge:done de `jobId` (null si no llega en `timeoutMs`). */
export async function waitMergeDone(
  page: Page,
  jobId: string,
  timeoutMs: number,
): Promise<{ result: Result<{ mediaId: string; existed: boolean }> | null; progress: number[] }> {
  return page.evaluate(
    async ({ id, ms }) => {
      const w = window as unknown as {
        __mergeEvents: {
          progress: number[];
          done: { jobId: string; result: Result<{ mediaId: string; existed: boolean }> }[];
        };
      };
      const t0 = Date.now();
      for (;;) {
        const hit = w.__mergeEvents.done.find((d) => d.jobId === id);
        if (hit) return { result: hit.result, progress: [...w.__mergeEvents.progress] };
        if (Date.now() - t0 > ms) return { result: null, progress: [...w.__mergeEvents.progress] };
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    { id: jobId, ms: timeoutMs },
  );
}

/** merge:start y espera su merge:done. */
export async function mergeAndWait(
  page: Page,
  req: MergeRequest,
  timeoutMs = 240_000,
): Promise<MergeOutcome> {
  const start = await startMerge(page, req);
  if (!start.ok) return { jobId: null, start, result: null, progress: [] };
  const { result, progress } = await waitMergeDone(page, start.data.jobId, timeoutMs);
  return { jobId: start.data.jobId, start, result, progress };
}

export interface Playback {
  mime: string;
  duration: number;
  width: number;
  height: number;
  seekedMs: number;
  seekedTo: number;
  advanced: boolean;
}

/**
 * Reproduce `vault://media/<id>` en un <video> creado en la página (la CSP deja `media-src vault:`):
 * duración, dimensiones, y cuánto tarda `currentTime = 0,75·D` en disparar `seeked` (§18.4).
 */
export async function playAndSeek(page: Page, id: string): Promise<Playback> {
  return page.evaluate(async (mediaId): Promise<Playback> => {
    const detail = await (window as unknown as Api).galeria.invoke('media:get', { id: mediaId });
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
    const loaded = waitFor('loadedmetadata', 15_000);
    video.src = `vault://media/${mediaId}`;
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
    await video.play();
    const from = video.currentTime;
    await new Promise((r) => setTimeout(r, 400));
    const advanced = video.currentTime > from || video.ended;
    video.pause();
    const out = {
      mime: detail.data.mime,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      seekedMs,
      seekedTo,
      advanced,
    };
    video.remove();
    return out;
  }, id);
}

/**
 * Primeros 64 bytes DESCIFRADOS de un medio, pedidos desde el proceso main a `vault://media/<id>`
 * con la sesión `galeria` (solo el test: Playwright evalúa en main; la app no expone nada nuevo).
 */
export async function decryptedHead(app: ElectronApplication, id: string): Promise<Buffer> {
  const hex = await app.evaluate(async ({ session }, mediaId) => {
    const res = await session.fromPartition('galeria').fetch(`vault://media/${mediaId}`, {
      headers: { Range: 'bytes=0-63' },
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`vault:// ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, 64);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }, id);
  return Buffer.from(hex, 'hex');
}

/** Primeros 64 bytes de un archivo (los fixtures antes de importarlos: la importación los borra). */
export function headOf(path: string): Buffer {
  return readFileSync(path).subarray(0, 64);
}

/** Los `.part` que queden en tmp/ de la bóveda del perfil. */
export function partsIn(dataDir: string, profileId: string): string[] {
  return filesUnder(join(dataDir, 'vaults', profileId, 'tmp')).filter((f) => f.endsWith('.part'));
}

/** Dos vídeos sintéticos (testsrc2 + sine, VP9 + Opus, baja resolución) para fusionar. */
export function writeMergeInputs(
  dir: string,
  spec: {
    left: { name: string; seconds: number; size?: string };
    right: { name: string; seconds: number; size?: string };
  },
): { left: string; right: string } {
  const left = join(dir, `${spec.left.name}.mp4`);
  const right = join(dir, `${spec.right.name}.mp4`);
  writeLongVideo(left, spec.left.seconds, { size: spec.left.size ?? '320x180', frequency: 440 });
  writeLongVideo(right, spec.right.seconds, { size: spec.right.size ?? '240x180', frequency: 660 });
  return { left, right };
}

/** El resultado tiene que ser ok; si no, falla con el código. */
export function expectMerged(outcome: MergeOutcome): { mediaId: string; existed: boolean } {
  expect(outcome.start.ok, JSON.stringify(outcome.start)).toBe(true);
  expect(outcome.result, 'merge:done no llegó').not.toBeNull();
  const result = outcome.result as Result<{ mediaId: string; existed: boolean }>;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; data: { mediaId: string; existed: boolean } }).data;
}
