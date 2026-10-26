// Proceso hijo de no-temp-leak.test.ts (docs/DESIGN.md §12.4 "sharp sin temporales en disco").
// Se empaqueta con Vite a tests/.tmp/ y se lanza con TMP, TEMP y TMPDIR apuntando a una carpeta
// vacía y vigilada con fs.watch. Usa los módulos reales de la app: media/thumbnails.ts (miniatura
// de importación, vía sharp-loader.ts) y profiles/avatars.ts (foto de avatar). F3 añade
// edits-render. Escribe un JSON con lo observado en stdout.
import { readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  avatarBytes: number;
}

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
  for (const path of cfg.images) {
    const thumb = await photoThumbnail(readFileSync(path));
    thumbBytes.push(thumb.length);
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
    avatarBytes: avatar.length,
  };
  process.stdout.write(JSON.stringify(report));
}

main().catch((err: unknown) => {
  process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
