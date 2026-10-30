// dual-store (docs/PLAN.md 5.4): audio por defecto (suena el izquierdo), elegir y abrir vídeos, y el
// ciclo de la fusión (merge:start, merge:progress, merge:done) con el IPC simulado: éxito, «Ya existía
// un vídeo idéntico», BUSY y VALIDATION de merge:start, los errores de merge:done mapeados a español,
// cancelar (también antes de que responda merge:start) y merge:done antes que la respuesta de
// merge:start.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@shared/errors';
import type { MediaDetail, MergeDone, MergeProgress } from '@shared/types';

type Handler = (payload: never) => void;
const handlers = new Map<string, Handler>();
const calls: { channel: string; args: unknown[] }[] = [];
let responders: Record<string, (...args: unknown[]) => Promise<Result<unknown>> | Result<unknown>> =
  {};

vi.mock('@renderer/lib/ipc', () => ({
  invoke: async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    const responder = responders[channel];
    return responder ? responder(...args) : { ok: true, data: undefined };
  },
  on: (event: string, cb: Handler) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  },
}));

const store = await import('@renderer/stores/dual-store');
const { useNavStore } = await import('@renderer/stores/nav-store');
const { useToastStore } = await import('@renderer/lib/toast');

const detail = (id: string, kind: 'photo' | 'video' = 'video'): MediaDetail =>
  ({
    id,
    kind,
    name: `Nombre ${id}`,
    ext: 'mp4',
    capturedAt: 0,
    importedAt: 0,
    sizeBytes: 1,
    durationMs: 12_000,
    width: 320,
    height: 180,
    thumbRev: 0,
    mime: 'video/mp4',
    originalSizeBytes: 1,
    converted: false,
    hasAudio: true,
    fps: 15,
    videoCodec: 'vp9',
    audioCodec: 'opus',
    exif: null,
    edits: [],
  }) satisfies MediaDetail;

const emit = (event: string, payload: unknown): void => {
  const h = handlers.get(event);
  if (!h) throw new Error(`nadie escucha ${event}`);
  h(payload as never);
};

const request = {
  leftId: 'L',
  rightId: 'R',
  audio: 'mix',
  duration: 'shortest',
  resolution: 'auto',
  name: 'Fusión de prueba',
} as const;

const state = () => store.useDualStore.getState();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

let off: () => void = () => undefined;

beforeEach(() => {
  off();
  store.resetDual();
  calls.length = 0;
  handlers.clear();
  responders = {};
  useToastStore.setState({ items: [], next: 1 });
  useNavStore.setState({ active: 'gallery-all' });
  off = store.subscribeMerge();
});

describe('estado inicial', () => {
  it('controles sincronizados; suena el izquierdo y el derecho está silenciado', () => {
    const s = state();
    expect(s.synced).toBe(true);
    expect(s.muted).toEqual({ left: false, right: true });
    expect(s.volume).toEqual({ left: 1, right: 1 });
    expect(s.speed).toEqual({ left: 1, right: 1 });
    expect(s.loop).toEqual({ left: false, right: false });
    expect(s.left).toBeNull();
    expect(s.right).toBeNull();
    expect(s.picking).toBeNull();
    expect(s.merge).toEqual({ name: 'idle' });
  });

  it('volumen, silencio, velocidad y bucle por lado (y "both" en sincronizado)', () => {
    store.setVolume('right', 0.4);
    store.setVolume('left', 5);
    store.setMuted('right', false);
    expect(state().volume).toEqual({ left: 1, right: 0.4 });
    expect(state().muted.right).toBe(false);
    store.setSpeed('left', 2);
    expect(state().speed).toEqual({ left: 2, right: 1 });
    store.setSpeed('both', 0.5);
    expect(state().speed).toEqual({ left: 0.5, right: 0.5 });
    store.setSpeed('both', 3); // no es una de las velocidades del menú
    expect(state().speed).toEqual({ left: 0.5, right: 0.5 });
    store.setLoop('both', true);
    expect(state().loop).toEqual({ left: true, right: true });
    store.setLoop('right', false);
    expect(state().loop).toEqual({ left: true, right: false });
    store.setSynced(false);
    expect(state().synced).toBe(false);
  });
});

describe('elegir vídeos', () => {
  it('chooseVideo pone el detalle en su lado y cierra el selector', async () => {
    responders['media:get'] = (args) => ({ ok: true, data: detail((args as { id: string }).id) });
    store.requestPick('right');
    expect(state().picking).toBe('right');
    await store.chooseVideo('right', 'R');
    expect(state().right?.id).toBe('R');
    expect(state().left).toBeNull();
    expect(state().picking).toBeNull();
    store.clearSide('right');
    expect(state().right).toBeNull();
  });

  it('elegir o quitar un vídeo (aunque sea el mismo) cambia la época de su lado', async () => {
    responders['media:get'] = (args) => ({ ok: true, data: detail((args as { id: string }).id) });
    expect(state().epoch).toEqual({ left: 0, right: 0 });
    await store.chooseVideo('left', 'A');
    expect(state().epoch).toEqual({ left: 1, right: 0 });
    await store.chooseVideo('left', 'A');
    expect(state().epoch.left).toBe(2);
    store.clearSide('left');
    expect(state().epoch.left).toBe(3);
    await store.openDual('A', 'B');
    expect(state().epoch).toEqual({ left: 4, right: 1 });
    // refreshSides no reinicia el reproductor: la época no cambia.
    await store.refreshSides();
    expect(state().epoch).toEqual({ left: 4, right: 1 });
  });

  it('una foto o un vídeo que ya no existe no se elige y avisa', async () => {
    responders['media:get'] = () => ({ ok: true, data: detail('P', 'photo') });
    await store.chooseVideo('left', 'P');
    expect(state().left).toBeNull();
    expect(useToastStore.getState().items.at(-1)?.message).toBe('Solo se pueden elegir vídeos.');
    responders['media:get'] = () => ({ ok: false, error: { code: 'NOT_FOUND' } });
    await store.chooseVideo('left', 'X');
    expect(state().left).toBeNull();
    expect(useToastStore.getState().items.at(-1)?.message).toBe('Ese vídeo ya no está disponible.');
  });

  it('openDual carga los dos, el primero a la izquierda, y navega a la pantalla', async () => {
    responders['media:get'] = (args) => ({ ok: true, data: detail((args as { id: string }).id) });
    await store.openDual('A', 'B');
    expect(state().left?.id).toBe('A');
    expect(state().right?.id).toBe('B');
    expect(useNavStore.getState().active).toBe('dual');
  });

  it('openDual no navega si alguno falla', async () => {
    responders['media:get'] = (args) =>
      (args as { id: string }).id === 'B'
        ? { ok: false, error: { code: 'NOT_FOUND' } }
        : { ok: true, data: detail('A') };
    await store.openDual('A', 'B');
    expect(state().left).toBeNull();
    expect(useNavStore.getState().active).toBe('gallery-all');
  });

  it('refreshSides quita el lado cuyo vídeo se borró', async () => {
    responders['media:get'] = (args) => ({ ok: true, data: detail((args as { id: string }).id) });
    await store.openDual('A', 'B');
    responders['media:get'] = (args) =>
      (args as { id: string }).id === 'B'
        ? { ok: false, error: { code: 'NOT_FOUND' } }
        : { ok: true, data: detail('A') };
    await store.refreshSides();
    expect(state().left?.id).toBe('A');
    expect(state().right).toBeNull();
    expect(useToastStore.getState().items.at(-1)?.message).toContain('derecho');
  });
});

describe('fusión', () => {
  beforeEach(async () => {
    responders['media:get'] = (args) => ({ ok: true, data: detail((args as { id: string }).id) });
    await store.openDual('L', 'R');
  });

  it('no se abre el diálogo sin los dos vídeos', () => {
    store.clearSide('right');
    store.openMergeDialog();
    expect(state().merge).toEqual({ name: 'idle' });
  });

  it('abrir y cerrar el diálogo', () => {
    store.openMergeDialog();
    expect(state().merge).toEqual({ name: 'form', error: null });
    store.closeMergeDialog();
    expect(state().merge).toEqual({ name: 'idle' });
  });

  it('éxito: running con progreso → done con el id nuevo', async () => {
    responders['merge:start'] = () => ({ ok: true, data: { jobId: 'job1' } });
    store.openMergeDialog();
    await store.startMerge(request);
    expect(calls.find((c) => c.channel === 'merge:start')?.args[0]).toEqual(request);
    expect(state().merge).toEqual({
      name: 'running',
      jobId: 'job1',
      fraction: 0,
      cancelling: false,
    });
    emit('merge:progress', { jobId: 'job1', fraction: 0.4 } satisfies MergeProgress);
    expect(state().merge).toMatchObject({ name: 'running', fraction: 0.4 });
    // Progreso de otro trabajo: se ignora.
    emit('merge:progress', { jobId: 'otro', fraction: 0.9 } satisfies MergeProgress);
    expect(state().merge).toMatchObject({ fraction: 0.4 });
    emit('merge:done', {
      jobId: 'job1',
      result: { ok: true, data: { mediaId: 'M', existed: false } },
    } satisfies MergeDone);
    expect(state().merge).toEqual({ name: 'done', mediaId: 'M', existed: false });
  });

  it('un vídeo idéntico: done con existed true', async () => {
    responders['merge:start'] = () => ({ ok: true, data: { jobId: 'job1' } });
    await store.startMerge(request);
    emit('merge:done', {
      jobId: 'job1',
      result: { ok: true, data: { mediaId: 'ya', existed: true } },
    } satisfies MergeDone);
    expect(state().merge).toEqual({ name: 'done', mediaId: 'ya', existed: true });
  });

  it('no se puede cerrar el diálogo mientras la fusión está en curso', async () => {
    responders['merge:start'] = () => ({ ok: true, data: { jobId: 'job1' } });
    await store.startMerge(request);
    store.closeMergeDialog();
    expect(state().merge.name).toBe('running');
    expect(store.isMerging()).toBe(true);
    // Una segunda petición mientras tanto no lanza otra fusión.
    await store.startMerge(request);
    expect(calls.filter((c) => c.channel === 'merge:start')).toHaveLength(1);
  });

  it('BUSY de merge:start → vuelve al formulario con el mensaje', async () => {
    responders['merge:start'] = () => ({ ok: false, error: { code: 'BUSY' } });
    await store.startMerge(request);
    expect(state().merge).toEqual({
      name: 'form',
      error: 'Ya hay una fusión en curso. Espera a que termine.',
    });
    expect(store.isMerging()).toBe(false);
  });

  it('VALIDATION de merge:start → mensaje según el motivo', async () => {
    responders['merge:start'] = () => ({
      ok: false,
      error: { code: 'VALIDATION', details: { reason: 'audio' } },
    });
    await store.startMerge(request);
    expect(state().merge).toEqual({
      name: 'form',
      error: 'El lado elegido no tiene audio. Elige otra opción de audio.',
    });
  });

  it('errores de merge:done → failed con el mensaje en español', async () => {
    const cases: [string, string][] = [
      ['FFMPEG_FAILED', 'No se pudo crear el vídeo fusionado. Inténtalo de nuevo.'],
      ['DISK_FULL', 'No queda espacio suficiente en el disco para el vídeo fusionado.'],
      [
        'INTEGRITY',
        'El vídeo fusionado no pasó la verificación, así que no se ha guardado. Inténtalo de nuevo.',
      ],
    ];
    for (const [code, message] of cases) {
      responders['merge:start'] = () => ({ ok: true, data: { jobId: `job-${code}` } });
      await store.startMerge(request);
      emit('merge:done', {
        jobId: `job-${code}`,
        result: { ok: false, error: { code } },
      } as MergeDone);
      expect(state().merge).toEqual({ name: 'failed', message });
      store.closeMergeDialog();
    }
  });

  it('CANCELLED → de vuelta al formulario con un aviso', async () => {
    responders['merge:start'] = () => ({ ok: true, data: { jobId: 'job1' } });
    await store.startMerge(request);
    emit('merge:done', {
      jobId: 'job1',
      result: { ok: false, error: { code: 'CANCELLED' } },
    } satisfies MergeDone);
    expect(state().merge).toEqual({ name: 'form', error: null });
    expect(useToastStore.getState().items.at(-1)?.message).toBe('Fusión cancelada.');
  });

  it('cancelMerge pide merge:cancel con el jobId y marca "Cancelando…" una sola vez', async () => {
    responders['merge:start'] = () => ({ ok: true, data: { jobId: 'job1' } });
    await store.startMerge(request);
    await store.cancelMerge();
    await store.cancelMerge();
    expect(calls.filter((c) => c.channel === 'merge:cancel')).toEqual([
      { channel: 'merge:cancel', args: [{ jobId: 'job1' }] },
    ]);
    expect(state().merge).toMatchObject({ name: 'running', cancelling: true });
  });

  it('cancelar antes de que responda merge:start: se cancela en cuanto hay jobId', async () => {
    let release: (r: Result<unknown>) => void = () => undefined;
    responders['merge:start'] = () =>
      new Promise<Result<unknown>>((resolve) => (release = resolve));
    const started = store.startMerge(request);
    await flush();
    expect(state().merge).toMatchObject({ name: 'running', jobId: null });
    await store.cancelMerge();
    expect(calls.some((c) => c.channel === 'merge:cancel')).toBe(false);
    release({ ok: true, data: { jobId: 'job9' } });
    await started;
    expect(calls.find((c) => c.channel === 'merge:cancel')?.args[0]).toEqual({ jobId: 'job9' });
    expect(state().merge).toMatchObject({ jobId: 'job9', cancelling: true });
  });

  it('merge:done antes de la respuesta de merge:start se aplica al responder', async () => {
    let release: (r: Result<unknown>) => void = () => undefined;
    responders['merge:start'] = () =>
      new Promise<Result<unknown>>((resolve) => (release = resolve));
    const started = store.startMerge(request);
    await flush();
    emit('merge:done', {
      jobId: 'rapido',
      result: { ok: true, data: { mediaId: 'M2', existed: false } },
    } satisfies MergeDone);
    expect(state().merge.name).toBe('running'); // todavía no se sabe de quién es
    release({ ok: true, data: { jobId: 'rapido' } });
    await started;
    expect(state().merge).toEqual({ name: 'done', mediaId: 'M2', existed: false });
  });

  it('un merge:done de otro trabajo no cambia nada', async () => {
    responders['merge:start'] = () => ({ ok: true, data: { jobId: 'job1' } });
    await store.startMerge(request);
    emit('merge:done', {
      jobId: 'otro',
      result: { ok: true, data: { mediaId: 'X', existed: false } },
    } satisfies MergeDone);
    expect(state().merge.name).toBe('running');
  });
});
