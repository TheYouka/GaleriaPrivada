// Música (docs/PLAN.md 4.2; docs/DESIGN.md §8.6.1, §11, §22) por el camino real de main: music:import
// con el diálogo simulado copia la pista a music/ con un nombre neutro (<trackId>.wav) y el original
// sigue en su sitio con el mismo SHA-256; la pista suena por vault://music con CORS (lo necesita Web
// Audio en la presentación); y tras bloquear y cerrar, ni el nombre del original ni el de la playlist
// que la usa aparecen en ningún archivo ni en ningún nombre de archivo de la raíz de datos (tampoco
// en music/, que va en claro pero con nombres neutros). Tono sintético, nunca música real.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { lockAndGetNewWindow, readProfilesJson } from './helpers/launch';
import {
  filesUnder,
  importMusic,
  launchUnlocked,
  newSourceDir,
  PROFILE,
  removeDir,
  sha256File,
  writeTone,
} from './helpers/library';

type Invoke = (channel: string, req?: unknown) => Promise<{ ok: boolean; data?: unknown }>;

test('importar música: copia neutra, original intacto, se oye por vault://music y nada del nombre en disco', async () => {
  test.setTimeout(180_000);
  const launched = await launchUnlocked();
  const src = newSourceDir();
  try {
    const { app, dataDir } = launched;
    const page = launched.page;
    const marker = `CancionPrivada${randomBytes(6).toString('hex')}`;
    const original = join(src, `${marker}.wav`);
    writeTone(original, 2);
    const before = sha256File(original);

    const res = await importMusic(app, page, [original]);
    expect(res.failed).toEqual([]);
    expect(res.imported).toHaveLength(1);
    const track = res.imported[0]!;
    expect(track.title).toBe(marker);
    expect(track.durationMs).toBeGreaterThan(1900);

    // El original: en su sitio y con el mismo contenido.
    expect(readdirSync(src)).toEqual([`${marker}.wav`]);
    expect(sha256File(original)).toBe(before);
    // La copia: un único <trackId>.wav, byte a byte igual.
    const profileId = readProfilesJson(dataDir).profiles.find((p) => p.name === PROFILE)?.id ?? '';
    const musicDir = join(dataDir, 'vaults', profileId, 'music');
    expect(readdirSync(musicDir)).toEqual([`${track.id}.wav`]);
    expect(sha256File(join(musicDir, `${track.id}.wav`))).toBe(before);

    // Se carga por vault://music con crossOrigin (CORS, §11.3).
    const duration = await page.evaluate(async (id) => {
      const audio = document.createElement('audio');
      audio.crossOrigin = 'anonymous';
      audio.preload = 'metadata';
      audio.src = `vault://music/${id}`;
      await new Promise<void>((resolve, reject) => {
        audio.onloadedmetadata = () => resolve();
        audio.onerror = () => reject(new Error(`audio error ${audio.error?.code ?? '?'}`));
      });
      return audio.duration;
    }, track.id);
    expect(duration).toBeGreaterThan(1.9);
    expect(duration).toBeLessThan(2.1);

    // Una playlist que usa la pista en su presentación (todo en la DB cifrada).
    const playlistName = `ListaPrivada${randomBytes(6).toString('hex')}`;
    const cfg = await page.evaluate(
      async ({ name, trackId }) => {
        const invoke = (window as unknown as { galeria: { invoke: Invoke } }).galeria.invoke;
        const created = (await invoke('playlists:create', { name })) as {
          ok: boolean;
          data: { id: string };
        };
        const defaults = (await invoke('presentation:getConfig', {})) as {
          data: { settings: Record<string, unknown> };
        };
        const set = await invoke('playlists:setPresentation', {
          id: created.data.id,
          settings: { ...defaults.data.settings, musicEnabled: true, trackIds: [trackId] },
        });
        const got = await invoke('presentation:getConfig', { playlistId: created.data.id });
        return { set: set.ok, got: got.data };
      },
      { name: playlistName, trackId: track.id },
    );
    expect(cfg.set).toBe(true);
    expect(cfg.got).toMatchObject({ settings: { trackIds: [track.id] }, tracks: [track] });

    // Bloquear, cerrar y analizar todo lo que queda en disco.
    await lockAndGetNewWindow(app, () => page.keyboard.press('Control+L'));
    await launched.quit();

    const needles = [marker, playlistName].flatMap((text) => [
      { label: `${text} utf8`, bytes: Buffer.from(text, 'utf8') },
      { label: `${text} utf16le`, bytes: Buffer.from(text, 'utf16le') },
    ]);
    const roots = [dataDir, `${dataDir}.electron`];
    const hits: string[] = [];
    let scanned = 0;
    let musicScanned = false;
    let profileNameFound = false;
    for (const file of roots.flatMap(filesUnder)) {
      const rel = relative(dataDir, file);
      const data = readFileSync(file);
      scanned += 1;
      if (file.startsWith(musicDir)) musicScanned = true;
      if (data.includes(Buffer.from(PROFILE, 'utf8'))) profileNameFound = true;
      for (const text of [marker, playlistName]) {
        if (rel.toLowerCase().includes(text.toLowerCase())) hits.push(`nombre de archivo ${rel}`);
      }
      for (const n of needles) if (data.includes(n.bytes)) hits.push(`${n.label} en ${rel}`);
    }
    console.log(`[e2e] archivos analizados: ${scanned}`);
    expect(musicScanned).toBe(true); // music/ también se analiza (control positivo)
    expect(profileNameFound).toBe(true); // el nombre del perfil sí está en claro (por diseño)
    expect(hits).toEqual([]);
  } finally {
    launched.cleanup();
    removeDir(src);
  }
});
