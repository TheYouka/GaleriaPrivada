// Proceso hijo de no-temp-leak.test.ts (docs/DESIGN.md §12.4 "sharp sin temporales en disco").
// Se empaqueta con Vite a tests/.tmp/ y se lanza con TMP, TEMP y TMPDIR apuntando a una carpeta
// vacía y vigilada con fs.watch. Usa los módulos reales de la app: media/thumbnails.ts (miniatura
// de importación, vía sharp-loader.ts), media/edits-render.ts (miniatura con ediciones, F3) y
// profiles/avatars.ts (foto de avatar). Escribe un JSON con lo observado en stdout.
import { readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldEdits } from '../../../src/shared/edits';
import { renderEdits } from '../../../src/main/media/edits-render';
import { photoThumbnail } from '../../../src/main/media/thumbnails';
import { processAvatarPhoto } from '../../../src/main/profiles/avatars';

interface ChildConfig {
  watchDir: string;
  images: string[];
  avatar: string;
}

export interface ChildReport {
  tmpdir: string;
  controlSeen: boolean;
  seen: string[];
  entries: string[];
  thumbBytes: number[];
  /** edits-render: EDIT_STATES.length por imagen. */
  editBytes: number[];
  avatarBytes: number;
}

/** Giro + volteo + recorte (las dos pasadas) e identidad (una pasada). */
export const EDIT_STATES = [
  foldEdits([{ t: 'rotate', q: 1 }, { t: 'flipH' }, { t: 'crop', x: 0.1, y: 0.2, w: 0.7, h: 0.6 }]),
  foldEdits([{ t: 'flipV' }, { t: 'crop', x: 0, y: 0, w: 0.5, h: 0.5 }]),
  foldEdits([]),
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = JSON.parse(process.argv[2] as string) as ChildConfig;
  const seen: string[] = [];
  const watcher = watch(cfg.watchDir, { recursive: true }, (_event, name) => {
    seen.push(String(name));
  });

  // Control positivo: un archivo de 1 MiB creado y borrado en milisegundos se ve.
  const probe = join(cfg.watchDir, 'control-positivo.bin');
  writeFileSync(probe, Buffer.alloc(1024 * 1024));
  unlinkSync(probe);
  const deadline = Date.now() + 5000;
  while (seen.length === 0 && Date.now() < deadline) await sleep(20);
  const controlSeen = seen.length > 0;
  await sleep(300);
  seen.length = 0;

  const thumbBytes: number[] = [];
  const editBytes: number[] = [];
  for (const path of cfg.images) {
    const input = readFileSync(path);
    const thumb = await photoThumbnail(input);
    thumbBytes.push(thumb.length);
    // edits-render (F3): las dos pasadas del plan B (PNG intermedio en memoria) y la de identidad.
    for (const state of EDIT_STATES) {
      const edited = await renderEdits(input, state);
      editBytes.push(edited.length);
    }
  }
  const avatar = await processAvatarPhoto(cfg.avatar);
  await sleep(500); // eventos rezagados del vigilante
  watcher.close();

  const report: ChildReport = {
    tmpdir: tmpdir(),
    controlSeen,
    seen,
    entries: readdirSync(cfg.watchDir),
    thumbBytes,
    editBytes,
    avatarBytes: avatar.length,
  };
  process.stdout.write(JSON.stringify(report));
}

main().catch((err: unknown) => {
  process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
