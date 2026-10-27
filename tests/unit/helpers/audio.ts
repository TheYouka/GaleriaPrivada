// Pistas de audio sintéticas (tono senoidal) para los tests de música (PLAN.md 4.2), generadas con
// el ffmpeg empaquetado en la carpeta temporal del test (siempre bajo tests/.tmp/). Nunca se usa
// música real.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { realFfmpegPaths } from './import';

export type ToneFormat =
  /** MP3 con etiqueta ID3v2 (firma `ID3`). */
  | 'mp3'
  /** MP3 sin ID3 ni cabecera Xing: empieza por el sync de una trama de Layer III. */
  | 'mp3-sync'
  /** AAC ADTS. */
  | 'aac'
  /** M4A (`ftyp M4A `). */
  | 'm4a'
  /** MP4 solo audio con brand `isom` (fila de ffprobe). */
  | 'mp4-audio'
  /** MP4 con vídeo y audio (brand `isom`: ffprobe ve vídeo → se rechaza). */
  | 'mp4-video'
  | 'ogg'
  | 'opus'
  | 'flac'
  | 'wav';

const ARGS: Record<ToneFormat, string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3'],
  'mp3-sync': [
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
    '-id3v2_version',
    '0',
    '-write_xing',
    '0',
    '-f',
    'mp3',
  ],
  aac: ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts'],
  m4a: ['-c:a', 'aac', '-b:a', '64k', '-f', 'ipod'],
  'mp4-audio': ['-c:a', 'aac', '-b:a', '64k', '-f', 'mp4'],
  'mp4-video': [
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-f',
    'mp4',
  ],
  ogg: ['-c:a', 'libvorbis', '-f', 'ogg'],
  opus: ['-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg'],
  flac: ['-c:a', 'flac', '-f', 'flac'],
  wav: ['-c:a', 'pcm_s16le', '-f', 'wav'],
};

/** Escribe `dir/name` con un tono de 440 Hz de `seconds` segundos y devuelve la ruta. */
export function writeTone(dir: string, name: string, format: ToneFormat, seconds = 1): string {
  const out = join(dir, name);
  const video =
    format === 'mp4-video'
      ? ['-f', 'lavfi', '-i', `testsrc2=size=64x64:rate=10:duration=${seconds}`]
      : [];
  const win = process.platform === 'win32';
  execFileSync(
    realFfmpegPaths.ffmpeg,
    [
      ...['-hide_banner', '-nostdin', '-v', 'error', '-y'],
      ...['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`],
      ...video,
      ...ARGS[format],
      out,
    ],
    {
      env: win
        ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
        : { LD_LIBRARY_PATH: realFfmpegPaths.libDir ?? '' },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
    },
  );
  return out;
}
