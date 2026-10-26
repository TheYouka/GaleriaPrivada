// Pipeline de vídeo (docs/DESIGN.md §12.3 punto 6, §12.4 pasos 0, 2 y 3, §12.5, §12.5.1).
//
// - Sondeo: ffprobe con el demuxer forzado por la firma (`mov` para MP4/MOV, `matroska` para
//   WebM/MKV, `avi` para AVI) y salida validada con zod.
// - Primera pista de vídeo (sin contar portadas, attached_pic = 1; nota 104) y primera de audio.
//   Dimensiones de visualización: width/height de la
//   pista, intercambiadas si la rotación es ±90°/±270° (side_data_list[].rotation de la Display
//   Matrix y, si no existe, tags.rotate).
// - Acción por `codec_name` con la tabla de §12.5. SIN comprobación de pix_fmt: el hallazgo v3-1
//   está descartado por el usuario (riesgo aceptado; una línea en la Ayuda).
// - [H3-11]: si la primera pista de vídeo no tiene codec_name o FFmpeg no tiene decodificador para
//   él (conjunto de `ffmpeg -decoders`, 2.1), UNSUPPORTED_FORMAT sin pasar por la confirmación D8.
// - Procesar (remultiplexar o recodificar, converted = 1): `ffmpeg … pipe:1` → writer cifrado, con
//   progreso. Nada se escribe en claro en disco.
// - Paso 3 de un vídeo procesado: ffprobe del objeto temporal por el loopback; tiene que tener una
//   pista de vídeo y una duración igual a la del original ±max(1 s, 2 %).
import { z } from 'zod';
import { AppErrorException } from '@shared/errors';
import type { VideoContainer } from '@shared/constants';
import {
  FfmpegError,
  probeCommand,
  transcodeCommand,
  type AudioAction,
  type Demuxer,
  type Ffmpeg,
  type FfmpegInput,
  type VideoAction,
} from '../media/ffmpeg';
import { isMainVideoStream } from './sniff';

/** Salida de ffprobe: como mucho esto (JSON de -show_format -show_streams). */
export const PROBE_MAX_BYTES = 16 * 1024 * 1024;

const numberish = z.union([z.number(), z.string()]);

const streamSchema = z.looseObject({
  index: z.number().int().optional(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  duration: numberish.optional(),
  tags: z.looseObject({ rotate: numberish.optional() }).optional(),
  disposition: z.looseObject({ attached_pic: z.number().optional() }).optional(),
  side_data_list: z.array(z.looseObject({ rotation: numberish.optional() })).optional(),
});

/** Esquema zod de la salida de ffprobe (solo lo que se usa; el resto se ignora). */
export const PROBE_SCHEMA = z.looseObject({
  streams: z.array(streamSchema).max(4096),
  format: z
    .looseObject({
      duration: numberish.optional(),
      tags: z.looseObject({ creation_time: z.string().optional() }).optional(),
    })
    .optional(),
});

export type VideoProbe = z.infer<typeof PROBE_SCHEMA>;

export interface VideoSummary {
  hasVideo: boolean;
  /** codec_name de la primera pista de vídeo (null si no tiene). */
  videoCodec: string | null;
  hasAudio: boolean;
  audioCodec: string | null;
  /** Dimensiones de visualización (rotación aplicada). */
  width: number | null;
  height: number | null;
  /** Grados normalizados a [0, 360). */
  rotation: number;
  durationMs: number | null;
  fps: number | null;
  /** format.tags.creation_time (capture-date.ts). */
  creationTime: string | null;
}

/** Valida el JSON de ffprobe. FFMPEG_FAILED { reason: 'probe-output' } si no tiene la forma. */
export function parseProbe(stdout: Buffer | string): VideoProbe {
  let json: unknown;
  try {
    json = JSON.parse(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
  } catch {
    throw new FfmpegError('FFMPEG_FAILED', 'probe-output');
  }
  const parsed = PROBE_SCHEMA.safeParse(json);
  if (!parsed.success) throw new FfmpegError('FFMPEG_FAILED', 'probe-output');
  return parsed.data;
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function rate(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (!m) return null;
  const den = Number(m[2]);
  const fps = den > 0 ? Number(m[1]) / den : NaN;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function normalizeRotation(deg: number): number {
  const r = Math.round(deg) % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * Primera pista de vídeo (las portadas no cuentan: isMainVideoStream) y de audio, dimensiones con
 * rotación, duración y fps.
 */
export function summarizeProbe(probe: VideoProbe): VideoSummary {
  const video = probe.streams.find(isMainVideoStream);
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  let rotation = 0;
  if (video) {
    const fromMatrix = video.side_data_list
      ?.map((d) => toNumber(d.rotation))
      .find((r): r is number => r !== null);
    const fromTag = toNumber(video.tags?.rotate);
    rotation = normalizeRotation(fromMatrix ?? fromTag ?? 0);
  }
  const swap = rotation === 90 || rotation === 270;
  const w = video?.width && video.width > 0 ? video.width : null;
  const h = video?.height && video.height > 0 ? video.height : null;
  const seconds = toNumber(probe.format?.duration) ?? toNumber(video?.duration);
  return {
    hasVideo: video !== undefined,
    videoCodec: video?.codec_name && video.codec_name.length > 0 ? video.codec_name : null,
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name && audio.codec_name.length > 0 ? audio.codec_name : null,
    width: swap ? h : w,
    height: swap ? w : h,
    rotation,
    durationMs: seconds !== null && seconds >= 0 ? Math.round(seconds * 1000) : null,
    fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
    creationTime: probe.format?.tags?.creation_time ?? null,
  };
}

// ── Decisión (§12.5) ───────────────────────────────────────────────────────────────────────────

const COPYABLE_VIDEO: ReadonlySet<string> = new Set(['h264', 'vp9', 'av1']);
const MP4_AUDIO: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'flac']);
const WEBM_VIDEO: ReadonlySet<string> = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO: ReadonlySet<string> = new Set(['vorbis', 'opus']);

export type VideoDecision =
  /** Tal cual (converted = 0): el objeto es el original byte a byte. */
  | { kind: 'store'; mime: 'video/mp4' | 'video/webm' }
  /**
   * Procesar con ffmpeg a MP4 fragmentado (converted = 1). `reencode` = recodifica vídeo o audio
   * (con pérdida): pide confirmación D8. El remultiplexado (`-c copy`) no la pide.
   */
  | {
      kind: 'process';
      mime: 'video/mp4';
      video: VideoAction;
      audio: AudioAction;
      genpts: boolean;
      reencode: boolean;
    }
  /** Sin pista de vídeo: "cualquier otra" (§12.3; dispositionOf de sniff.ts). */
  | { kind: 'no-video' }
  /** [H3-11] Pista sin codec_name o sin decodificador: UNSUPPORTED_FORMAT, fuera de D8. */
  | { kind: 'unsupported'; reason: 'no-codec' | 'no-decoder' };

/**
 * Tabla de §12.5 por codec_name (PLAN.md, nota 98: un WebM que no cumple su fila se trata como
 * MKV). `decoders` es el conjunto de `ffmpeg -decoders` [H3-11].
 */
export function decideVideoAction(
  container: VideoContainer,
  summary: VideoSummary,
  decoders: ReadonlySet<string>,
): VideoDecision {
  if (!summary.hasVideo) return { kind: 'no-video' };
  const v = summary.videoCodec;
  if (v === null) return { kind: 'unsupported', reason: 'no-codec' };
  if (!decoders.has(v)) return { kind: 'unsupported', reason: 'no-decoder' };
  const a = summary.hasAudio ? summary.audioCodec : null;
  const audioOk = (set: ReadonlySet<string>): boolean => a === null || set.has(a);

  if (container === 'mp4' && COPYABLE_VIDEO.has(v) && audioOk(MP4_AUDIO)) {
    return { kind: 'store', mime: 'video/mp4' };
  }
  if (container === 'webm' && WEBM_VIDEO.has(v) && audioOk(WEBM_AUDIO)) {
    return { kind: 'store', mime: 'video/webm' };
  }
  const genpts = container === 'avi';
  const audio: AudioAction = audioOk(MP4_AUDIO) ? 'copy' : 'opus';
  if (COPYABLE_VIDEO.has(v)) {
    // MOV/MKV/AVI (y WebM/MP4 fuera de su fila) con vídeo copiable: remultiplexar; si el audio no
    // cabe en MP4, copiar el vídeo y convertir el audio a Opus.
    return {
      kind: 'process',
      mime: 'video/mp4',
      video: 'copy',
      audio,
      genpts,
      reencode: audio === 'opus',
    };
  }
  return { kind: 'process', mime: 'video/mp4', video: 'vp9', audio, genpts, reencode: true };
}

/** §12.5.1: cuántos vídeos (y bytes de sus originales) se recodificarían con pérdida. */
export function confirmationSummary(
  items: readonly { decision: VideoDecision; sizeBytes: number }[],
): { toConvert: number; toConvertBytes: number } {
  let toConvert = 0;
  let toConvertBytes = 0;
  for (const { decision, sizeBytes } of items) {
    if (decision.kind === 'process' && decision.reencode) {
      toConvert += 1;
      toConvertBytes += sizeBytes;
    }
  }
  return { toConvert, toConvertBytes };
}

// ── Procesos ───────────────────────────────────────────────────────────────────────────────────

type FfmpegLike = Pick<Ffmpeg, 'available' | 'loadDecoders' | 'run' | 'start'>;

/** ffprobe de una entrada (original o loopback) y su resumen. */
export async function probeVideo(
  ffmpeg: Pick<Ffmpeg, 'run'>,
  input: FfmpegInput,
  signal?: AbortSignal,
): Promise<{ probe: VideoProbe; summary: VideoSummary }> {
  const out = await ffmpeg.run(probeCommand(input), { signal, maxStdoutBytes: PROBE_MAX_BYTES });
  const probe = parseProbe(out);
  return { probe, summary: summarizeProbe(probe) };
}

export interface VideoPrescan {
  demuxer: Demuxer;
  /** Salida validada de ffprobe: es el `probe` de `dispositionOf` (sniff.ts) para `no-video`. */
  probe: VideoProbe;
  summary: VideoSummary;
  decision: VideoDecision;
}

/**
 * Preescaneo de un original (§12.3 punto 6 y paso 0): FFMPEG_MISSING sin binarios; FFMPEG_FAILED
 * si -decoders falló o ffprobe falla o devuelve algo inválido. Con `decision.kind === 'no-video'`,
 * quien llama decide con `dispositionOf(sniff, { explicit, probe })` (skipped o UNSUPPORTED_FORMAT).
 */
export async function prescanVideo(
  ffmpeg: FfmpegLike,
  original: { path: string; container: VideoContainer; demuxer: Demuxer },
  signal?: AbortSignal,
): Promise<VideoPrescan> {
  if (!ffmpeg.available) throw new FfmpegError('FFMPEG_MISSING', 'missing');
  const decoders = await ffmpeg.loadDecoders();
  if (!decoders) throw new FfmpegError('FFMPEG_FAILED', 'decoders');
  const { probe, summary } = await probeVideo(
    ffmpeg,
    { kind: 'file', path: original.path, demuxer: original.demuxer },
    signal,
  );
  return {
    demuxer: original.demuxer,
    probe,
    summary,
    decision: decideVideoAction(original.container, summary, decoders),
  };
}

/** Destino de la salida de ffmpeg (el ObjectWriter de tmp/<id>.part). */
export interface ChunkSink {
  write(chunk: Uint8Array): Promise<void>;
}

/**
 * Paso 2 de un vídeo procesado: `ffmpeg … pipe:1` → `sink` con backpressure. `onProgress` recibe
 * la fracción [0, 1] (out_time_us frente a la duración de ffprobe). Si el sink falla, se mata
 * ffmpeg y se relanza el error del sink; si ffmpeg falla, FfmpegError. Quien llama aborta el writer.
 */
export async function transcodeToSink(opts: {
  ffmpeg: Pick<Ffmpeg, 'start'>;
  input: FfmpegInput;
  decision: Extract<VideoDecision, { kind: 'process' }>;
  sink: ChunkSink;
  durationMs: number | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const proc = opts.ffmpeg.start(
    transcodeCommand({
      input: opts.input,
      video: opts.decision.video,
      audio: opts.decision.audio,
      genpts: opts.decision.genpts,
    }),
    {
      signal: opts.signal,
      onProgress: (p) => {
        if (!opts.onProgress) return;
        if (p.done) return opts.onProgress(1);
        if (p.outTimeUs === null || !opts.durationMs) return;
        opts.onProgress(Math.min(1, Math.max(0, p.outTimeUs / 1000 / opts.durationMs)));
      },
    },
  );
  try {
    for await (const chunk of proc.stdout) {
      await opts.sink.write(chunk as Buffer);
    }
  } catch (err) {
    proc.kill();
    await proc.done.catch(() => undefined);
    throw err;
  }
  await proc.done;
}

/** ±max(1 s, 2 %) (§12.4, paso 3). */
export function durationMatches(expectedMs: number, actualMs: number): boolean {
  return Math.abs(actualMs - expectedMs) <= Math.max(1000, expectedMs * 0.02);
}

/**
 * Paso 3 de un vídeo procesado: ffprobe del objeto temporal por el loopback (`url`, MP4
 * fragmentado → demuxer `mov`). INTEGRITY si no tiene pista de vídeo o la duración no coincide.
 */
export async function verifyProcessedVideo(opts: {
  ffmpeg: Pick<Ffmpeg, 'run'>;
  url: string;
  expectedDurationMs: number | null;
  signal?: AbortSignal;
}): Promise<VideoSummary> {
  let summary: VideoSummary;
  try {
    ({ summary } = await probeVideo(
      opts.ffmpeg,
      { kind: 'loopback', url: opts.url, demuxer: 'mov' },
      opts.signal,
    ));
  } catch (err) {
    const code = err instanceof AppErrorException ? err.error.code : null;
    if (code === 'CANCELLED' || code === 'FFMPEG_MISSING' || code === 'LOCKED') throw err;
    throw new AppErrorException({ code: 'INTEGRITY', details: { reason: 'probe' } });
  }
  if (!summary.hasVideo || summary.durationMs === null) {
    throw new AppErrorException({ code: 'INTEGRITY', details: { reason: 'no-video' } });
  }
  if (
    opts.expectedDurationMs !== null &&
    !durationMatches(opts.expectedDurationMs, summary.durationMs)
  ) {
    throw new AppErrorException({ code: 'INTEGRITY', details: { reason: 'duration' } });
  }
  return summary;
}
