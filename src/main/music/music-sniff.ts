// Formato de una pista de música por firma (docs/DESIGN.md §8.6.1): se miran como mucho los primeros
// 64 bytes y la extensión del archivo del usuario no cuenta. Puro (sin E/S): lo prueba
// tests/unit/main/music-sniff.test.ts.
//
//   | Firma                                                         | Formato  | ext  | MIME       |
//   | `ID3`, o FF + b1 con (b1 & 0xE0) == 0xE0 y capa (b1>>1)&3 == 1 | MP3      | mp3  | audio/mpeg |
//   | FF + b1 con (b1 & 0xF6) == 0xF0 (sync de 12 bits y capa 00)    | AAC ADTS | aac  | audio/aac  |
//   | caja `ftyp` con brand mayor o compatible `M4A ` o `M4B `       | M4A      | m4a  | audio/mp4  |
//   | caja `ftyp` con otro brand: ffprobe decide (audio y sin vídeo) | M4A      | m4a  | audio/mp4  |
//   | `OggS`                                                        | Ogg      | ogg  | audio/ogg  |
//   | `fLaC`                                                        | FLAC     | flac | audio/flac |
//   | `RIFF....WAVE`                                                | WAV      | wav  | audio/wav  |
//
// Cualquier otra firma: UNSUPPORTED_FORMAT.
import { MUSIC_SNIFF_BYTES } from '@shared/constants';

export type MusicFormat = 'mp3' | 'aac' | 'm4a' | 'ogg' | 'flac' | 'wav';

/** Demuxer que se fuerza en ffprobe (`-f`, §8.6.1). */
export type MusicDemuxer = 'mp3' | 'aac' | 'mov' | 'ogg' | 'flac' | 'wav';

export const MUSIC_FORMATS: Readonly<
  Record<MusicFormat, { ext: MusicFormat; mime: string; demuxer: MusicDemuxer }>
> = Object.freeze({
  mp3: { ext: 'mp3', mime: 'audio/mpeg', demuxer: 'mp3' },
  aac: { ext: 'aac', mime: 'audio/aac', demuxer: 'aac' },
  m4a: { ext: 'm4a', mime: 'audio/mp4', demuxer: 'mov' },
  ogg: { ext: 'ogg', mime: 'audio/ogg', demuxer: 'ogg' },
  flac: { ext: 'flac', mime: 'audio/flac', demuxer: 'flac' },
  wav: { ext: 'wav', mime: 'audio/wav', demuxer: 'wav' },
});

/** Nombre de un archivo de music/: `<trackId>.<ext>` (§8.5), sin nada del original. */
export const MUSIC_FILE_NAME = /^([0-9a-f]{32})\.(mp3|aac|m4a|ogg|flac|wav)$/;
/** Copia en curso: `<trackId>.<ext>.part` (§8.6.1). */
export const MUSIC_PART_NAME = /^([0-9a-f]{32})\.(mp3|aac|m4a|ogg|flac|wav)\.part$/;

export type MusicSniff =
  | {
      kind: 'audio';
      format: MusicFormat;
      ext: MusicFormat;
      mime: string;
      demuxer: MusicDemuxer;
      /** `ftyp` con otro brand: solo vale si ffprobe ve una pista de audio y ninguna de vídeo. */
      needsProbe: boolean;
    }
  | { kind: 'unknown' };

function audio(format: MusicFormat, needsProbe = false): MusicSniff {
  return { kind: 'audio', format, ...MUSIC_FORMATS[format], needsProbe };
}

function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

const M4A_BRANDS: ReadonlySet<string> = new Set(['M4A ', 'M4B ']);

/** Clasifica los primeros bytes de una pista (solo se miran los 64 primeros). */
export function sniffMusic(input: Uint8Array): MusicSniff {
  const b = input.subarray(0, MUSIC_SNIFF_BYTES);
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') return audio('mp3');
  if (b.length >= 2 && b[0] === 0xff) {
    const b1 = b[1] as number;
    if ((b1 & 0xe0) === 0xe0 && ((b1 >> 1) & 3) === 1) return audio('mp3');
    if ((b1 & 0xf6) === 0xf0) return audio('aac');
    return { kind: 'unknown' };
  }
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const end = Math.min(view.getUint32(0), b.length);
    const brands = [ascii(b, 8, 12)];
    for (let off = 16; off + 4 <= end; off += 4) brands.push(ascii(b, off, off + 4));
    return brands.some((brand) => M4A_BRANDS.has(brand)) ? audio('m4a') : audio('m4a', true);
  }
  if (b.length >= 4) {
    const head = ascii(b, 0, 4);
    if (head === 'OggS') return audio('ogg');
    if (head === 'fLaC') return audio('flac');
    if (head === 'RIFF' && b.length >= 12 && ascii(b, 8, 12) === 'WAVE') return audio('wav');
  }
  return { kind: 'unknown' };
}
