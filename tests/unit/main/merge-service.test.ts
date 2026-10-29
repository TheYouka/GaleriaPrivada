// Servicio de fusión (docs/DESIGN.md §18.2–§18.7, §12.11, §13.3; PLAN.md 5.3). Parámetros y
// argumentos exactos de ffmpeg (§18.3) con funciones puras; el resto con perfil, bóveda, DB y
// SessionManager reales bajo tests/.tmp/ (KDF rápido): VALIDATION, BUSY, D18 con reloj falso,
// suspender a mitad (kill, loopback cerrado, .part borrado, claves a cero), errores de §18.7 y, con
// el ffmpeg empaquetado, una fusión real (incluida una entrada rotada) y la fusión idéntica.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException, type AppError } from '@shared/errors';
import type { MergeDone, MergeProgress, MergeRequest } from '@shared/types';
import { KIND_MEDIA } from '../../../src/main/crypto/file-format';
import {
  findByHmac,
  insertPending,
  listMedia,
  markReady,
  type MergeSourceRow,
  type NewMedia,
} from '../../../src/main/db/repos/media-repo';
import { SCHEMAS } from '../../../src/main/ipc/schemas';
import { mergeHandlers } from '../../../src/main/ipc/handlers/merge';
import {
  FfmpegError,
  mergeCommand,
  minimalEnv,
  type FfmpegCommand,
  type RunningFfmpeg,
  type StartOptions,
} from '../../../src/main/media/ffmpeg';
import { LoopbackServer } from '../../../src/main/media/loopback-server';
import {
  MERGE_PROGRESS_INTERVAL_MS,
  MergeService,
  mergeCommandFor,
  mergeHeight,
  mergeParams,
  scaledWidth,
  type MergeFfmpeg,
} from '../../../src/main/media/merge-service';
import { installLockTriggers } from '../../../src/main/session/session-manager';
import { ObjectStore } from '../../../src/main/vault/object-store';
import {
  haveFfmpeg,
  importHarness,
  realFfmpeg,
  realFfmpegPaths,
  vaultFiles,
  type ImportHarness,
} from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../src/main/window', () => ({
  getMainWindow: () => null,
  getRendererOrigin: () => 'app://bundle',
}));

// Cifrado, E/S y ffmpeg reales: margen de sobra con la CPU cargada (PLAN.md, nota 112).
vi.setConfig({ testTimeout: 60_000 });

const tmp = makeTmpDir('merge-service');
const open: ImportHarness[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

/** El AppError que lanza `fn` (síncrono); falla si no lanza un AppErrorException. */
function appErrorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppErrorException);
    return (err as AppErrorException).error;
  }
  throw new Error('se esperaba un AppError y no hubo error');
}

// ── Parámetros y argumentos (§18.2, §18.3) ──────────────────────────────────────────────────

const ID_L = 'a'.repeat(32);
const ID_R = 'b'.repeat(32);
const TOKEN = 'T'.repeat(43);
const URLS = {
  left: `http://127.0.0.1:50000/${TOKEN}/l`,
  right: `http://127.0.0.1:50000/${TOKEN}/r`,
};

function row(over: Partial<MergeSourceRow>): MergeSourceRow {
  return {
    id: ID_L,
    kind: 'video',
    mime: 'video/mp4',
    width: 320,
    height: 180,
    durationMs: 12_000,
    fps: 15,
    hasAudio: true,
    ...over,
  };
}

/** Izquierdo de 12 s (más corto) a 320×180 y 15 fps; derecho de 20 s a 240×180 y 30 fps. */
const LEFT = row({ id: ID_L });
const RIGHT = row({ id: ID_R, width: 240, durationMs: 20_000, fps: 30 });

function req(over: Partial<MergeRequest> = {}): MergeRequest {
  return {
    leftId: ID_L,
    rightId: ID_R,
    audio: 'mix',
    duration: 'shortest',
    name: 'Fusión',
    ...over,
  };
}

function argsFor(
  r: Partial<MergeRequest>,
  left: MergeSourceRow = LEFT,
  right: MergeSourceRow = RIGHT,
): readonly string[] {
  return mergeCommandFor(mergeParams(req(r), left, right), URLS).args;
}

const CHAIN_L = '[0:v]scale=-2:180:flags=bicubic,setsar=1,fps=30.000,format=yuv420p';
const CHAIN_R = '[1:v]scale=-2:180:flags=bicubic,setsar=1,fps=30.000,format=yuv420p';
const STACK = '[l][r]hstack=inputs=2:shortest=1[v]';
const A_LEFT = ';[0:a:0]aresample=48000,apad[a]';
const A_RIGHT = ';[1:a:0]aresample=48000,apad[a]';
const A_MIX =
  ';[0:a:0]aresample=48000[a0];[1:a:0]aresample=48000[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=1,apad[a]';

/** La línea exacta de §18.3 con el grafo, la duración y el audio dados. */
function expected(graph: string, t: string, audio: boolean): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-progress',
    'pipe:2',
    '-nostats',
    '-protocol_whitelist',
    'http,tcp,pipe',
    '-seekable',
    '1',
    '-f',
    'mov',
    '-i',
    URLS.left,
    '-seekable',
    '1',
    '-f',
    'mov',
    '-i',
    URLS.right,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    ...(audio ? ['-map', '[a]'] : ['-an']),
    '-t',
    t,
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'good',
    '-cpu-used',
    '5',
    '-row-mt',
    '1',
    '-crf',
    '32',
    '-b:v',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-force_key_frames',
    'expr:gte(t,n_forced*4)',
    ...(audio ? ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2'] : []),
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-f',
    'mp4',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
}

const SHORT = `${CHAIN_L}[l];${CHAIN_R}[r];${STACK}`;
/** duration = longest: el izquierdo (12 s) es el más corto y se alarga Δ = 8 s con tpad. */
const LONG_PAD_LEFT = `${CHAIN_L},tpad=stop_mode=clone:stop_duration=8.000[l];${CHAIN_R}[r];${STACK}`;

describe('argumentos exactos de §18.3: 4 opciones de audio × 2 duraciones', () => {
  const cases = [
    ['left', 'shortest', SHORT + A_LEFT, '12.000', true],
    ['right', 'shortest', SHORT + A_RIGHT, '12.000', true],
    ['mix', 'shortest', SHORT + A_MIX, '12.000', true],
    ['none', 'shortest', SHORT, '12.000', false],
    ['left', 'longest', LONG_PAD_LEFT + A_LEFT, '20.000', true],
    ['right', 'longest', LONG_PAD_LEFT + A_RIGHT, '20.000', true],
    ['mix', 'longest', LONG_PAD_LEFT + A_MIX, '20.000', true],
    ['none', 'longest', LONG_PAD_LEFT, '20.000', false],
  ] as const;

  it.each(cases)('audio %s + %s', (audio, duration, graph, t, withAudio) => {
    expect(argsFor({ audio, duration })).toEqual(expected(graph, t, withAudio));
  });

  it('izquierdo con tpad: solo el más corto y solo con duration = longest', () => {
    const long = argsFor({ duration: 'longest' }).join(' ');
    expect(long).toContain('format=yuv420p,tpad=stop_mode=clone:stop_duration=8.000[l]');
    expect(long).not.toContain('tpad=stop_mode=clone:stop_duration=8.000[r]');
    expect(argsFor({ duration: 'shortest' }).join(' ')).not.toContain('tpad');
    // Con el derecho más corto, el tpad pasa a la entrada 1.
    const swapped = argsFor(
      { duration: 'longest' },
      row({ id: ID_L, durationMs: 20_000 }),
      row({ id: ID_R, width: 240, durationMs: 12_000, fps: 30 }),
    );
    expect(swapped[swapped.indexOf('-filter_complex') + 1]).toBe(
      `${CHAIN_L}[l];${CHAIN_R},tpad=stop_mode=clone:stop_duration=8.000[r];${STACK}${A_MIX}`,
    );
    // Misma duración: nadie se alarga.
    const same = argsFor({ duration: 'longest' }, LEFT, row({ id: ID_R, width: 240, fps: 30 }));
    expect(same.join(' ')).not.toContain('tpad');
  });

  it('mezcla con un solo lado con audio = ese lado; sin audio en ningún lado = -an', () => {
    const onlyLeft = row({ id: ID_R, width: 240, durationMs: 20_000, fps: 30, hasAudio: false });
    expect(argsFor({ audio: 'mix' }, LEFT, onlyLeft)).toEqual(
      expected(SHORT + A_LEFT, '12.000', true),
    );
    const onlyRight = row({ id: ID_L, hasAudio: false });
    expect(argsFor({ audio: 'mix', duration: 'longest' }, onlyRight, RIGHT)).toEqual(
      expected(LONG_PAD_LEFT + A_RIGHT, '20.000', true),
    );
    const mute = (r: MergeSourceRow): MergeSourceRow => ({ ...r, hasAudio: false });
    for (const audio of ['left', 'right', 'mix', 'none'] as const) {
      expect(argsFor({ audio }, mute(LEFT), mute(RIGHT))).toEqual(expected(SHORT, '12.000', false));
    }
  });

  it('el lado elegido sin audio (y el otro con audio) → VALIDATION { reason: audio }', () => {
    const noLeft = row({ id: ID_L, hasAudio: false });
    expect(appErrorOf(() => mergeParams(req({ audio: 'left' }), noLeft, RIGHT))).toEqual({
      code: 'VALIDATION',
      details: { reason: 'audio' },
    });
    const noRight = row({ id: ID_R, width: 240, durationMs: 20_000, hasAudio: false });
    expect(appErrorOf(() => mergeParams(req({ audio: 'right' }), LEFT, noRight))).toEqual({
      code: 'VALIDATION',
      details: { reason: 'audio' },
    });
  });

  it('WebM → -f matroska; FPS = min(60, max(fpsL ?? 30, fpsR ?? 30)) con 3 decimales', () => {
    const webm = row({ id: ID_R, mime: 'video/webm', width: 240, durationMs: 20_000, fps: null });
    const args = argsFor({}, row({ id: ID_L, fps: 29.97002997 }), webm);
    expect(args.slice(15, 21)).toEqual(['-seekable', '1', '-f', 'matroska', '-i', URLS.right]);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('fps=30.000');
    const fast = mergeParams(req(), row({ id: ID_L, fps: 120 }), row({ id: ID_R, fps: 24 }));
    expect(fast.fps).toBe(60);
    const ntsc = mergeParams(
      req(),
      row({ id: ID_L, fps: 59.94005994 }),
      row({ id: ID_R, fps: 24 }),
    );
    expect(ntsc.fps).toBe(59.94);
    expect(mergeCommandFor(ntsc, URLS).args.join(' ')).toContain('fps=59.940');
  });

  it('D y Δ con 3 decimales', () => {
    const p = mergeParams(
      req({ duration: 'longest' }),
      row({ id: ID_L, durationMs: 4_321 }),
      row({ id: ID_R, durationMs: 10_007 }),
    );
    expect(p).toMatchObject({ durationS: 10.007, durationMs: 10_007, deltaS: 5.686, pad: 'left' });
    const args = mergeCommandFor(p, URLS).args;
    expect(args[args.indexOf('-t') + 1]).toBe('10.007');
    expect(args.join(' ')).toContain('stop_duration=5.686[l]');
  });

  it('el constructor congelado rechaza entradas que no son del loopback y parámetros fuera de rango', () => {
    const base = {
      left: { kind: 'loopback' as const, url: URLS.left, demuxer: 'mov' as const },
      right: { kind: 'loopback' as const, url: URLS.right, demuxer: 'mov' as const },
      height: 180,
      fps: 30,
      durationS: 12,
      deltaS: 0,
      pad: null,
      audio: 'mix' as const,
    };
    expect(Object.isFrozen(mergeCommand(base))).toBe(true);
    expect(Object.isFrozen(mergeCommand(base).args)).toBe(true);
    expect(() =>
      mergeCommand({ ...base, left: { kind: 'file', path: 'C:\\x.mp4', demuxer: 'mov' } as never }),
    ).toThrow(RangeError);
    expect(() =>
      mergeCommand({ ...base, right: { ...base.right, url: 'http://evil.example/x' } }),
    ).toThrow(RangeError);
    for (const height of [181, 0, 1082, 1.5]) {
      expect(() => mergeCommand({ ...base, height })).toThrow(RangeError);
    }
    expect(() => mergeCommand({ ...base, fps: 61 })).toThrow(RangeError);
    expect(() => mergeCommand({ ...base, durationS: 0 })).toThrow(RangeError);
    // Nunca un archivo de salida: la última es pipe:1 y no hay -y.
    const args = mergeCommand(base).args;
    expect(args.at(-1)).toBe('pipe:1');
    expect(args).not.toContain('-y');
    expect(args.join(' ')).not.toMatch(/libx264|libopenh264|h264|-passlogfile|-pass /);
  });
});

describe('H par y ≤ 1080 (§18.2), también con vídeos rotados', () => {
  it.each([
    // [hL, hR, H]
    [180, 180, 180],
    [721, 1000, 720],
    [2160, 1440, 1080],
    [1081, 4000, 1080],
    [91, 3, 2],
  ])('min(%i, %i, 1080) → %i', (hL, hR, h) => {
    expect(mergeHeight(hL, hR)).toBe(h);
    expect(h % 2).toBe(0);
  });

  it('las dimensiones de la DB ya tienen la rotación aplicada: un vertical 1080×1920 junto a un 1920×1080', () => {
    // Un móvil en vertical guardado 1920×1080 con rotación 90° queda en la DB como 1080×1920.
    const portrait = row({ id: ID_L, width: 1080, height: 1920, durationMs: 5_000 });
    const landscape = row({ id: ID_R, width: 1920, height: 1080, durationMs: 5_000 });
    const p = mergeParams(req(), portrait, landscape);
    expect(p.height).toBe(1080);
    expect(p.widths).toEqual([608, 1920]);
    expect(p.width).toBe(2528);
    // 4K vertical con un 720p: H = 720.
    const p2 = mergeParams(
      req(),
      row({ id: ID_L, width: 2160, height: 3840 }),
      row({ id: ID_R, width: 1280, height: 720 }),
    );
    expect(p2.height).toBe(720);
    expect(p2.widths).toEqual([406, 1280]);
    for (const q of [p, p2]) {
      expect(q.height % 2).toBe(0);
      expect(q.height).toBeLessThanOrEqual(1080);
      expect(q.widths.every((w) => w % 2 === 0)).toBe(true);
    }
  });

  it('scaledWidth reproduce scale=-2:H del ffmpeg empaquetado (medido)', () => {
    // [w, h, H, ancho que dio ffprobe con testsrc + scale=-2:H]
    const measured = [
      [100, 75, 74, 98],
      [160, 90, 74, 132],
      [333, 250, 180, 240],
      [1080, 1920, 1080, 608],
      [101, 57, 56, 100],
      [150, 100, 114, 172],
      [123, 77, 76, 122],
      [97, 99, 98, 96],
      [640, 481, 480, 638],
      [176, 144, 90, 110],
    ] as const;
    for (const [w, h, H, out] of measured) expect(scaledWidth(w, h, H)).toBe(out);
  });
});

describe('VALIDATION de las entradas (§10.3)', () => {
  it('leftId === rightId, foto, fila no `ready`, sin dimensiones o sin duración', () => {
    const v = (reason: string) => ({ code: 'VALIDATION', details: { reason } });
    expect(appErrorOf(() => mergeParams(req({ rightId: ID_L }), LEFT, LEFT))).toEqual(
      v('same-video'),
    );
    expect(appErrorOf(() => mergeParams(req(), LEFT, null))).toEqual(v('not-ready'));
    expect(appErrorOf(() => mergeParams(req(), row({ id: ID_L, kind: 'photo' }), RIGHT))).toEqual(
      v('not-video'),
    );
    expect(appErrorOf(() => mergeParams(req(), row({ id: ID_L, mime: 'video/x' }), RIGHT))).toEqual(
      v('mime'),
    );
    expect(appErrorOf(() => mergeParams(req(), row({ id: ID_L, height: null }), RIGHT))).toEqual(
      v('metadata'),
    );
    expect(appErrorOf(() => mergeParams(req(), LEFT, row({ id: ID_R, durationMs: 0 })))).toEqual(
      v('metadata'),
    );
  });

  it('esquema de merge:start: ids distintos, opciones cerradas, nombre de 1–255 y sin claves extra', () => {
    const schema = SCHEMAS['merge:start'];
    expect(schema.safeParse(req()).success).toBe(true);
    const same = schema.safeParse(req({ rightId: ID_L }));
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.path).toEqual(['rightId']);
    expect(schema.safeParse({ ...req(), audio: 'both' }).success).toBe(false);
    expect(schema.safeParse({ ...req(), duration: 'avg' }).success).toBe(false);
    expect(schema.safeParse({ ...req(), name: '   ' }).success).toBe(false);
    expect(schema.safeParse({ ...req(), name: 'x'.repeat(256) }).success).toBe(false);
    expect(schema.safeParse({ ...req(), extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...req(), leftId: 'no-es-un-id' }).success).toBe(false);
    expect(schema.parse({ ...req(), name: '  Fusio\u0301n  ' }).name).toBe('Fusión');
    expect(SCHEMAS['merge:cancel'].safeParse({ jobId: ID_L }).success).toBe(true);
    expect(SCHEMAS['merge:cancel'].safeParse({}).success).toBe(false);
  });
});

// ── Servicio con sesión real ─────────────────────────────────────────────────────────────────

interface FakeProc {
  proc: RunningFfmpeg;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  onProgress: StartOptions['onProgress'];
  finish(): void;
  fail(err: Error): void;
}

/** Proceso ffmpeg falso: stdout controlable; kill() (o la señal) lo termina con CANCELLED. */
function fakeProc(o: StartOptions = {}): FakeProc {
  const signal = o.signal;
  const stdout = new PassThrough();
  let resolveDone: () => void = () => undefined;
  let rejectDone: (err: Error) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => undefined);
  let settled = false;
  const settle = (err: Error | null): void => {
    if (settled) return;
    settled = true;
    stdout.end();
    if (err) rejectDone(err);
    else resolveDone();
  };
  const kill = vi.fn(() => settle(new FfmpegError('CANCELLED', 'aborted')));
  signal?.addEventListener('abort', () => kill(), { once: true });
  return {
    proc: { stdout, done, kill },
    kill,
    stdout,
    onProgress: o.onProgress,
    finish: () => settle(null),
    fail: (err) => settle(err),
  };
}

interface Recorder {
  progress: MergeProgress[];
  done: MergeDone[];
  library: unknown[];
}

interface MergeBench {
  h: ImportHarness;
  service: MergeService;
  events: Recorder;
  servers: LoopbackServer[];
  /** Procesos falsos lanzados (si `start` es el falso). */
  procs: FakeProc[];
  /** Se resuelve con el siguiente proceso falso lanzado. */
  nextProc(): Promise<FakeProc>;
  commands: FfmpegCommand[];
}

async function bench(
  opts: { ffmpeg?: 'fake' | 'real' | 'real-probe'; harness?: ImportHarness } = {},
): Promise<MergeBench> {
  const h = opts.harness ?? (await importHarness(tmp));
  if (!opts.harness) open.push(h);
  const events: Recorder = { progress: [], done: [], library: [] };
  const servers: LoopbackServer[] = [];
  const procs: FakeProc[] = [];
  const commands: FfmpegCommand[] = [];
  let waiters: ((p: FakeProc) => void)[] = [];
  const fakeStart = (cmd: FfmpegCommand, o: StartOptions = {}): RunningFfmpeg => {
    commands.push(cmd);
    const p = fakeProc(o);
    procs.push(p);
    const w = waiters;
    waiters = [];
    for (const f of w) f(p);
    return p.proc;
  };
  let ffmpeg: MergeFfmpeg;
  const mode = opts.ffmpeg ?? 'fake';
  if (mode === 'fake') {
    ffmpeg = {
      available: true,
      run: async () => {
        throw new Error('sin ffprobe en este test');
      },
      start: fakeStart,
    };
  } else {
    const real = await realFfmpeg();
    ffmpeg =
      mode === 'real'
        ? {
            available: true,
            run: (c, o) => real.run(c, o),
            start: (c, o) => {
              commands.push(c);
              return real.start(c, o);
            },
          }
        : { available: true, run: (c, o) => real.run(c, o), start: fakeStart };
  }
  const service = new MergeService({
    session: h.session,
    ffmpeg,
    events: {
      progress: (p) => events.progress.push(p),
      done: (d) => events.done.push(d),
    },
    library: {
      beginJob: () => () => undefined,
      changed: (reason, ids) => events.library.push({ reason, ids }),
    },
    inFlight: h.inFlight,
    startLoopback: async (o) => {
      const s = await LoopbackServer.start(o);
      servers.push(s);
      return s;
    },
  });
  return {
    h,
    service,
    events,
    servers,
    procs,
    commands,
    nextProc: () =>
      new Promise((resolve) => {
        waiters.push(resolve);
      }),
  };
}

/** Fila de vídeo `ready` insertada directamente (sin objeto: solo para validar y para ffmpeg falso). */
function insertVideo(h: ImportHarness, over: Partial<NewMedia> = {}, ready = true): string {
  const id = randomBytes(16).toString('hex');
  insertPending(h.db(), {
    id,
    kind: 'video',
    source: 'import',
    name: `v-${id.slice(0, 6)}`,
    originalExt: 'mp4',
    mime: 'video/mp4',
    sizeBytes: 1,
    originalSizeBytes: 1,
    width: 320,
    height: 180,
    durationMs: 4_000,
    fps: 15,
    hasAudio: true,
    videoCodec: 'vp9',
    audioCodec: 'opus',
    converted: false,
    capturedAt: 0,
    capturedAtSource: 'file_mtime',
    importedAt: 0,
    contentHmac: randomBytes(32),
    thumbId: null,
    ...over,
  });
  if (ready) markReady(h.db(), id);
  return id;
}

function rowCount(h: ImportHarness): number {
  return (h.db().prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n;
}

describe('merge:start: VALIDATION y BUSY', () => {
  it('leftId === rightId, una foto, una fila pending o inexistente → VALIDATION sin reservar el trabajo', async () => {
    const b = await bench();
    const video = insertVideo(b.h);
    const other = insertVideo(b.h);
    const photo = insertVideo(b.h, { kind: 'photo', mime: 'image/jpeg', durationMs: null });
    const pending = insertVideo(b.h, {}, false);
    const missing = randomBytes(16).toString('hex');
    const reasons: Record<string, string> = {};
    for (const [label, r] of [
      ['same', req({ leftId: video, rightId: video })],
      ['photo', req({ leftId: video, rightId: photo })],
      ['pending', req({ leftId: pending, rightId: video })],
      ['missing', req({ leftId: video, rightId: missing })],
    ] as const) {
      const err = appErrorOf(() => b.service.start(r));
      expect(err.code, label).toBe('VALIDATION');
      reasons[label] = String(err.details?.reason);
    }
    expect(reasons).toEqual({
      same: 'same-video',
      photo: 'not-video',
      pending: 'not-ready',
      missing: 'not-ready',
    });
    // Nada empezó: una fusión válida sigue pudiendo reservar el trabajo.
    expect(b.h.session.autoLockPauseReasons).not.toContain('job');
    const ok = b.service.start(req({ leftId: video, rightId: other }));
    const p = await b.nextProc();
    b.service.cancel(ok.jobId);
    expect(p.kill).toHaveBeenCalled();
    expect((await ok.done)?.ok).toBe(false);
  });

  it('sin ffmpeg → FFMPEG_MISSING; con la sesión bloqueada → LOCKED', async () => {
    const h = await importHarness(tmp);
    open.push(h);
    const a = insertVideo(h);
    const c = insertVideo(h);
    const service = new MergeService({
      session: h.session,
      ffmpeg: { available: false, run: vi.fn(), start: vi.fn() },
      events: { progress: vi.fn(), done: vi.fn() },
      library: { beginJob: () => () => undefined, changed: vi.fn() },
      inFlight: h.inFlight,
    });
    expect(appErrorOf(() => service.start(req({ leftId: a, rightId: c }))).code).toBe(
      'FFMPEG_MISSING',
    );
    await h.session.lock('manual');
    expect(appErrorOf(() => service.start(req({ leftId: a, rightId: c }))).code).toBe('LOCKED');
  });

  it('una segunda fusión mientras hay otra → BUSY; una importación puede coexistir', async () => {
    const b = await bench();
    const a = insertVideo(b.h);
    const c = insertVideo(b.h);
    const first = mergeHandlers({ service: b.service }).start(req({ leftId: a, rightId: c }));
    const p = await b.nextProc();
    expect(appErrorOf(() => b.service.start(req({ leftId: c, rightId: a }))).code).toBe('BUSY');
    // §12.11: merge e import coexisten.
    const importJob = b.h.session.startJob('import');
    importJob.done();
    // merge:cancel con un id desconocido no hace nada; con el de la fusión, CANCELLED.
    mergeHandlers({ service: b.service }).cancel({ jobId: 'c'.repeat(32) });
    expect(p.kill).not.toHaveBeenCalled();
    mergeHandlers({ service: b.service }).cancel({ jobId: first.jobId });
    await vi.waitFor(() => expect(b.events.done).toHaveLength(1));
    expect(b.events.done[0]).toEqual({
      jobId: first.jobId,
      result: { ok: false, error: { code: 'CANCELLED' } },
    });
    expect(p.kill).toHaveBeenCalled();
    expect(b.servers[0]?.closed).toBe(true);
    expect(vaultFiles(b.h.vaultDir).tmp).toEqual([]);
    expect(b.h.inFlight.size).toBe(0);
    // Ya se puede fusionar otra vez.
    const again = b.service.start(req({ leftId: c, rightId: a }));
    b.service.cancel(again.jobId);
    await again.done;
  });
});

describe('D18 y bloqueo a mitad (reloj falso)', () => {
  const FAKE: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  };

  /** Disparadores de §13.2 con un powerMonitor falso (sin tocar `process`). */
  function triggers(b: MergeBench): EventEmitter {
    const powerMonitor = Object.assign(new EventEmitter(), {
      getSystemIdleState: () => 'active' as const,
    });
    installLockTriggers(b.h.session, {
      app: Object.assign(new EventEmitter(), { quit: () => undefined }) as never,
      powerMonitor: powerMonitor as never,
      dialog: { showMessageBox: vi.fn() } as never,
      platform: 'win32',
      proc: new EventEmitter() as never,
    });
    return powerMonitor;
  }

  it('sin bloqueo por inactividad tras 10 min de fusión; un suspend simulado bloquea y cancela al momento', async () => {
    vi.useFakeTimers(FAKE);
    const b = await bench();
    const powerMonitor = triggers(b);
    const a = insertVideo(b.h);
    const c = insertVideo(b.h);
    const keyRing = b.h.session.getKeyRing(b.h.session.epoch);
    const kWrap = keyRing.kWrap;
    const job = b.service.start(req({ leftId: a, rightId: c }));
    const p = await b.nextProc();
    p.stdout.write(randomBytes(200_000)); // ya hay salida cifrada en tmp/<id>.part
    await vi.waitFor(() => expect(vaultFiles(b.h.vaultDir).tmp).toHaveLength(1));

    // D18: motivo 'job' y ningún bloqueo por inactividad (prefs.autoLockMinutes = 5).
    expect(b.h.session.autoLockPauseReasons).toContain('job');
    vi.advanceTimersByTime(10 * 60_000);
    expect(b.h.session.state).toBe('unlocked');

    // Suspender: bloqueo inmediato y fusión cancelada.
    powerMonitor.emit('suspend');
    expect(b.h.session.state).toBe('locked');
    expect(keyRing.zeroized).toBe(true);
    expect(kWrap.every((x) => x === 0)).toBe(true);
    expect(b.h.session.lastZeroizeMs).not.toBeNull();
    expect(p.kill).toHaveBeenCalled();
    expect(b.servers[0]?.closed).toBe(true);
    expect(await job.done).toBeNull();
    await b.h.session.cleanup.idle();
    expect(vaultFiles(b.h.vaultDir)).toEqual({ objects: [], thumbs: [], tmp: [] });
    expect(b.events.done).toEqual([]);
    expect(b.h.inFlight.size).toBe(0);
    expect(b.h.session.autoLockPauseReasons).toEqual([]);

    // Al volver a entrar, nada de la fusión: ni filas nuevas ni objetos.
    vi.useRealTimers();
    await b.h.unlock();
    expect(rowCount(b.h)).toBe(2);
  });

  it('el bloqueo manual tampoco espera los 2 s: el trabajo llama a done() al abortarse', async () => {
    const b = await bench();
    const a = insertVideo(b.h);
    const c = insertVideo(b.h);
    const job = b.service.start(req({ leftId: a, rightId: c }));
    const p = await b.nextProc();
    p.stdout.write(randomBytes(100_000));
    await vi.waitFor(() => expect(vaultFiles(b.h.vaultDir).tmp).toHaveLength(1));
    const t0 = performance.now();
    await b.h.session.lock('manual');
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(b.h.session.lastZeroizeMs as number).toBeLessThan(1_000);
    expect(p.kill).toHaveBeenCalled();
    expect(await job.done).toBeNull();
    await b.h.session.cleanup.idle();
    expect(vaultFiles(b.h.vaultDir).tmp).toEqual([]);
    expect(b.events.done).toEqual([]);
  });
});

describe('errores de §18.7 (ffmpeg falso)', () => {
  it('ffmpeg sale con código ≠ 0 → merge:done con FFMPEG_FAILED y sin .part', async () => {
    const b = await bench();
    const job = b.service.start(req({ leftId: insertVideo(b.h), rightId: insertVideo(b.h) }));
    const p = await b.nextProc();
    p.stdout.write(randomBytes(50_000));
    await vi.waitFor(() => expect(vaultFiles(b.h.vaultDir).tmp).toHaveLength(1));
    p.fail(new FfmpegError('FFMPEG_FAILED', 'exit', 'tail'));
    expect(await job.done).toEqual({
      ok: false,
      error: { code: 'FFMPEG_FAILED', details: { reason: 'exit' } },
    });
    expect(b.events.done).toHaveLength(1);
    expect(vaultFiles(b.h.vaultDir)).toEqual({ objects: [], thumbs: [], tmp: [] });
    expect(b.servers[0]?.closed).toBe(true);
    expect(b.h.session.autoLockPauseReasons).not.toContain('job');
  });

  it.skipIf(!haveFfmpeg)(
    'la salida no es un MP4 válido → INTEGRITY (verificación con ffprobe por loopback) y sin .part',
    async () => {
      const b = await bench({ ffmpeg: 'real-probe' });
      const before = rowCount(b.h);
      const job = b.service.start(req({ leftId: insertVideo(b.h), rightId: insertVideo(b.h) }));
      const p = await b.nextProc();
      p.stdout.write(randomBytes(300_000));
      p.finish();
      expect(await job.done).toEqual({
        ok: false,
        error: { code: 'INTEGRITY', details: { reason: 'probe' } },
      });
      expect(vaultFiles(b.h.vaultDir)).toEqual({ objects: [], thumbs: [], tmp: [] });
      expect(rowCount(b.h)).toBe(before + 2);
      expect(b.events.progress.at(-1)?.fraction).toBe(1);
    },
  );

  it('merge:progress: fraction = out_time_us / (D·10⁶), como mucho cada 250 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(MERGE_PROGRESS_INTERVAL_MS).toBe(250);
    const b = await bench();
    // shortest: D = 10 s.
    const a = insertVideo(b.h, { durationMs: 10_000 });
    const c = insertVideo(b.h, { durationMs: 20_000 });
    const job = b.service.start(req({ leftId: a, rightId: c }));
    const p = await b.nextProc();
    expect(b.commands[0]?.progress).toBe(true);
    const progress = p.onProgress as NonNullable<StartOptions['onProgress']>;
    const fractions = (): number[] => b.events.progress.map((e) => e.fraction);
    progress({ outTimeUs: 1_000_000, done: false });
    expect(fractions()).toEqual([0.1]);
    vi.advanceTimersByTime(100);
    progress({ outTimeUs: 2_000_000, done: false });
    progress({ outTimeUs: null, done: false }); // N/A: se ignora
    progress({ outTimeUs: 2_500_000, done: false });
    expect(fractions()).toEqual([0.1]);
    vi.advanceTimersByTime(150);
    expect(fractions()).toEqual([0.1, 0.25]);
    vi.advanceTimersByTime(1_000);
    progress({ outTimeUs: 99_000_000, done: false }); // nunca pasa de 1
    expect(fractions()).toEqual([0.1, 0.25, 1]);
    expect(b.events.progress.every((e) => e.jobId === job.jobId)).toBe(true);
    b.service.cancel(job.jobId);
    expect((await job.done)?.ok).toBe(false);
  });
});

// ── Con el ffmpeg empaquetado ─────────────────────────────────────────────────────────────────

/** Vídeo sintético VP9 (+ Opus) en MP4 con el ffmpeg empaquetado; `rotate` = matriz de rotación. */
function writeVideo(
  path: string,
  o: { seconds: number; size: string; audio?: boolean; rotate?: number; frequency?: number },
): void {
  const env = minimalEnv(realFfmpegPaths);
  const run = (args: string[]): void => {
    execFileSync(
      realFfmpegPaths.ffmpeg,
      ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args],
      {
        env,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 120_000,
      },
    );
  };
  const base = o.rotate ? `${path}.base.mp4` : path;
  const audio = o.audio !== false;
  run([
    ...['-f', 'lavfi', '-i', `testsrc2=size=${o.size}:rate=15:duration=${o.seconds}`],
    ...(audio
      ? [
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${o.frequency ?? 440}:sample_rate=48000:duration=${o.seconds}`,
        ]
      : []),
    ...[
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '200k',
      '-g',
      '15',
    ],
    ...(audio ? ['-c:a', 'libopus', '-b:a', '48k'] : []),
    ...['-movflags', '+faststart', '-f', 'mp4', base],
  ]);
  if (o.rotate) {
    run([
      ...['-display_rotation:v:0', String(o.rotate), '-f', 'mov', '-i', base],
      ...['-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', path],
    ]);
    rmSync(base, { force: true });
  }
}

async function idsByName(h: ImportHarness): Promise<Record<string, string>> {
  const items = listMedia(h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } });
  return Object.fromEntries(items.map((i) => [i.name, i.id]));
}

describe.skipIf(!haveFfmpeg)('fusión real con el ffmpeg empaquetado', () => {
  it('izquierdo 160×90 de 2 s + derecho rotado (160×120 → 120×160) de 3 s sin audio: mezcla + más largo', async () => {
    const b = await bench({ ffmpeg: 'real' });
    const left = join(b.h.src, 'Izquierdo.mp4');
    const right = join(b.h.src, 'Derecho rotado.mp4');
    writeVideo(left, { seconds: 2, size: '160x90' });
    writeVideo(right, { seconds: 3, size: '160x120', audio: false, rotate: 90 });
    expect((await b.h.run([left, right]))?.imported).toBe(2);
    const ids = await idsByName(b.h);
    const rot = b.h
      .db()
      .prepare('SELECT width, height, has_audio FROM media WHERE id = ?')
      .get(ids['Derecho rotado']);
    expect(rot).toEqual({ width: 120, height: 160, has_audio: 0 });

    const job = b.service.start(
      req({
        leftId: ids.Izquierdo as string,
        rightId: ids['Derecho rotado'] as string,
        audio: 'mix',
        duration: 'longest',
        name: 'Fusión de prueba',
      }),
    );
    const result = await job.done;
    expect(result?.ok, JSON.stringify(result)).toBe(true);
    const data = (result as { ok: true; data: { mediaId: string; existed: boolean } }).data;
    expect(data.existed).toBe(false);
    // Comando: mezcla con un solo lado con audio = el izquierdo; tpad en el izquierdo (2 s < 3 s).
    const args = b.commands[0]?.args.join(' ') ?? '';
    expect(args).toContain('stop_duration=1.000[l]');
    expect(args).toContain(';[0:a:0]aresample=48000,apad[a]');
    expect(args).not.toContain('amix');

    const media = b.h
      .db()
      .prepare(
        `SELECT kind, state, source, name, original_ext, mime, width, height, duration_ms,
           has_audio, video_codec, audio_codec, converted, captured_at_source, thumb_id
         FROM media WHERE id = ?`,
      )
      .get(data.mediaId) as Record<string, unknown>;
    // H = min(90, 160) = 90; anchos 160 y scale(120×160 → H 90) = 68.
    expect(media).toMatchObject({
      kind: 'video',
      state: 'ready',
      source: 'merge',
      name: 'Fusión de prueba',
      original_ext: 'mp4',
      mime: 'video/mp4',
      width: 228,
      height: 90,
      has_audio: 1,
      video_codec: 'vp9',
      audio_codec: 'opus',
      converted: 1,
      captured_at_source: 'generated',
    });
    expect(Math.abs((media.duration_ms as number) - 3_000)).toBeLessThanOrEqual(500);
    expect(media.thumb_id).toMatch(/^[0-9a-f]{32}$/);

    // El objeto descifra y es un MP4 fragmentado (ftyp + moov vacío + moof).
    const keys = b.h.session.getKeyRing(b.h.session.epoch);
    const reader = await new ObjectStore(b.h.vaultDir).open(data.mediaId, KIND_MEDIA, keys.kWrap);
    const plain = await reader.readAll();
    await reader.close();
    expect(plain.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(plain.includes(Buffer.from('moof'))).toBe(true);

    expect(vaultFiles(b.h.vaultDir).tmp).toEqual([]);
    expect(b.h.inFlight.size).toBe(0);
    expect(b.servers.every((s) => s.closed)).toBe(true);
    expect(b.events.library).toEqual([{ reason: 'merge', ids: [data.mediaId] }]);
    expect(b.events.progress.length).toBeGreaterThan(0);
    expect(b.events.progress.at(-1)?.fraction).toBe(1);
    expect(b.events.done).toEqual([{ jobId: job.jobId, result }]);
    expect(b.h.session.autoLockPauseReasons).not.toContain('job');

    // Misma fusión con los mismos parámetros: VP9 con -map_metadata -1 es determinista (§18.6
    // paso 4) → `existed: true` con el mismo mediaId y sin objetos nuevos.
    const objects = vaultFiles(b.h.vaultDir).objects;
    const again = await b.service.start(
      req({
        leftId: ids.Izquierdo as string,
        rightId: ids['Derecho rotado'] as string,
        audio: 'mix',
        duration: 'longest',
        name: 'Otra vez',
      }),
    ).done;
    expect(again).toEqual({ ok: true, data: { mediaId: data.mediaId, existed: true } });
    expect(vaultFiles(b.h.vaultDir).objects).toEqual(objects);
    expect(vaultFiles(b.h.vaultDir).tmp).toEqual([]);
    expect(findByHmac(b.h.db(), randomBytes(32))).toBeNull();
  }, 180_000);

  it('Cancelar a mitad con ffmpeg real → CANCELLED, sin .part ni filas nuevas', async () => {
    const b = await bench({ ffmpeg: 'real' });
    const left = join(b.h.src, 'Largo A.mp4');
    const right = join(b.h.src, 'Largo B.mp4');
    writeVideo(left, { seconds: 30, size: '320x180' });
    writeVideo(right, { seconds: 30, size: '320x180', frequency: 660 });
    expect((await b.h.run([left, right]))?.imported).toBe(2);
    const ids = await idsByName(b.h);
    const job = b.service.start(
      req({ leftId: ids['Largo A'] as string, rightId: ids['Largo B'] as string }),
    );
    await vi.waitFor(() => expect(vaultFiles(b.h.vaultDir).tmp.length).toBeGreaterThan(0), {
      timeout: 30_000,
    });
    b.service.cancel(job.jobId);
    expect(await job.done).toEqual({ ok: false, error: { code: 'CANCELLED' } });
    expect(vaultFiles(b.h.vaultDir).tmp).toEqual([]);
    expect(rowCount(b.h)).toBe(2);
    expect(b.servers.every((s) => s.closed)).toBe(true);
  }, 180_000);
});
