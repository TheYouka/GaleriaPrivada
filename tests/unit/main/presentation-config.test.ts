// Ajustes de la presentación en main (docs/DESIGN.md §10.2, §10.3, §17.2; PLAN.md 4.3) con perfil,
// bóveda, DB, prefs y SessionManager reales bajo tests/.tmp/ (KDF rápido): guardar y leer los
// predeterminados; ajustes propios de una playlist con pistas en orden; `settings: null` vuelve a
// los predeterminados y borra playlist_music; las pistas borradas se descartan al componer; las
// pistas solo están en la DB (nunca en presentation_json ni en prefs); slideMs fuera de pasos de
// 500 → VALIDATION; trackIds inexistentes → NOT_FOUND.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { KV_DEFAULT_TRACKS, kvGet } from '../../../src/main/db/repos/kv-repo';
import { deleteTrack, insertTrack } from '../../../src/main/db/repos/music-repo';
import { createPlaylist, playlistPresentation } from '../../../src/main/db/repos/playlist-repo';
import { presentationHandlers } from '../../../src/main/ipc/handlers/presentation';
import { SCHEMAS } from '../../../src/main/ipc/schemas';
import {
  DEFAULT_PREFS,
  PRESENTATION_PLAIN_SCHEMA,
} from '../../../src/main/settings/settings-store';
import { PRESENTATION_LIMITS } from '../../../src/shared/constants';
import { DEFAULT_PRESENTATION } from '../../../src/shared/presentation';
import type { PresentationSettings } from '../../../src/shared/types';
import { appErrorOf } from '../helpers/crypto';
import { importHarness, type ImportHarness } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.setConfig({ testTimeout: 30_000 });

const tmp = makeTmpDir('presentation-config');
const open: ImportHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

async function setup() {
  const h = await importHarness(tmp);
  open.push(h);
  const handlers = presentationHandlers({ session: h.session, prefs: h.prefs, now: () => 42 });
  const track = (title: string) => {
    const id = randomBytes(16).toString('hex');
    return insertTrack(h.db(), {
      id,
      fileName: `${id}.mp3`,
      title,
      ext: 'mp3',
      mime: 'audio/mpeg',
      sizeBytes: 10,
      durationMs: 1000,
      importedAt: 1,
    });
  };
  return { h, handlers, track };
}

const settings = (over: Partial<PresentationSettings> = {}): PresentationSettings => ({
  ...DEFAULT_PRESENTATION,
  randomPool: [...DEFAULT_PRESENTATION.randomPool],
  trackIds: [],
  ...over,
});

describe('DEFAULT_PRESENTATION', () => {
  it('son los valores de §8.4 / §17.2 y los mismos que prefs por defecto', () => {
    expect(DEFAULT_PRESENTATION).toEqual({
      transition: 'fade',
      randomPool: ['fade', 'slide', 'zoom', 'kenburns'],
      transitionMs: 700,
      slideMs: 5000,
      loop: true,
      animations: true,
      startFullscreen: true,
      audioMode: 'video',
      musicEnabled: false,
      musicVolume: 0.7,
      videoVolume: 1.0,
      musicFadeMs: 1500,
    });
    expect(DEFAULT_PREFS.presentationDefaults).toEqual(DEFAULT_PRESENTATION);
    expect(DEFAULT_PREFS.presentationDefaults.randomPool).not.toBe(DEFAULT_PRESENTATION.randomPool);
    // El renderer importa el objeto: ni el objeto ni su array se pueden modificar.
    expect(Object.isFrozen(DEFAULT_PRESENTATION)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PRESENTATION.randomPool)).toBe(true);
  });
});

describe('límites y valores de fábrica del movimiento (nota 191)', () => {
  it('«Animaciones» viene activado de fábrica y la duración mínima de una foto no parpadea', () => {
    expect(DEFAULT_PRESENTATION.animations).toBe(true);
    // Dos cambios automáticos distan al menos slideMsMin: ≥ 1 s, o sea ≤ 1 Hz (< 3 Hz).
    expect(PRESENTATION_LIMITS.slideMsMin).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_PRESENTATION.slideMs).toBeGreaterThanOrEqual(PRESENTATION_LIMITS.slideMsMin);
  });
});

describe('presentation:getConfig / saveDefaults', () => {
  it('sin nada guardado: los predeterminados y sin pistas', async () => {
    const { handlers } = await setup();
    expect(await handlers.getConfig({})).toEqual({ settings: settings(), tracks: [] });
  });

  it('guardar y leer los predeterminados: la parte en claro en prefs y las pistas en kv', async () => {
    const { h, handlers, track } = await setup();
    const a = track('Uno');
    const b = track('Dos');
    const saved = settings({
      transition: 'random',
      randomPool: ['zoom', 'fade'],
      slideMs: 7500,
      loop: false,
      audioMode: 'both',
      musicEnabled: true,
      musicVolume: 0.25,
      trackIds: [b.id, a.id],
    });
    await handlers.saveDefaults({ settings: saved });
    expect(await handlers.getConfig({})).toEqual({ settings: saved, tracks: [b, a] });
    // Las pistas solo en la DB cifrada; prefs (en claro) nunca lleva trackIds ni ids de pista.
    expect(kvGet(h.db(), KV_DEFAULT_TRACKS)).toEqual([b.id, a.id]);
    const prefsText = readFileSync(join(h.root, 'prefs', `${h.profileId}.json`), 'utf8');
    expect(prefsText).not.toContain('trackIds');
    expect(prefsText).not.toContain(a.id);
    expect(prefsText).not.toContain(b.id);
    expect((await h.prefs.get(h.profileId)).presentationDefaults).toMatchObject({
      slideMs: 7500,
      audioMode: 'both',
    });
  });

  it('«animaciones» (nota 178): se guarda y se lee; los ajustes guardados antes de existir valen true', async () => {
    const { h, handlers } = await setup();
    await handlers.saveDefaults({ settings: settings({ animations: false }) });
    expect((await handlers.getConfig({})).settings.animations).toBe(false);
    // Un archivo de prefs o un presentation_json de antes del campo sigue siendo válido.
    const legacy: Record<string, unknown> = { ...DEFAULT_PRESENTATION };
    delete legacy.animations;
    expect(PRESENTATION_PLAIN_SCHEMA.parse(legacy).animations).toBe(true);
    expect(PRESENTATION_PLAIN_SCHEMA.safeParse({ ...legacy, animations: 'sí' }).success).toBe(
      false,
    );
    // Y por IPC un valor que no es booleano se rechaza.
    expect(
      SCHEMAS['presentation:saveDefaults'].safeParse({
        settings: { ...settings(), animations: 1 },
      }).success,
    ).toBe(false);
    void h;
  });

  it('trackIds inexistentes → NOT_FOUND sin escribir nada', async () => {
    const { h, handlers, track } = await setup();
    const a = track('Uno');
    const err = await appErrorOf(() =>
      handlers.saveDefaults({
        settings: settings({ slideMs: 9000, trackIds: [a.id, 'f'.repeat(32)] }),
      }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(kvGet(h.db(), KV_DEFAULT_TRACKS)).toBeNull();
    expect((await h.prefs.get(h.profileId)).presentationDefaults.slideMs).toBe(5000);
  });

  it('las pistas borradas se descartan al componer (en orden)', async () => {
    const { h, handlers, track } = await setup();
    const [a, b, c] = [track('A'), track('B'), track('C')];
    await handlers.saveDefaults({ settings: settings({ trackIds: [c.id, a.id, b.id] }) });
    // Un id que ya no existe (borrado fuera de music:delete, p. ej. a medias): se descarta.
    h.db().prepare('DELETE FROM music_tracks WHERE id = ?').run(a.id);
    const cfg = await handlers.getConfig({});
    expect(cfg.settings.trackIds).toEqual([c.id, b.id]);
    expect(cfg.tracks).toEqual([c, b]);
    // music:delete además lo quita de kv.
    deleteTrack(h.db(), b.id);
    expect(kvGet(h.db(), KV_DEFAULT_TRACKS)).toEqual([c.id, a.id]);
    expect((await handlers.getConfig({})).tracks).toEqual([c]);
  });
});

describe('playlists:setPresentation', () => {
  it('ajustes propios con pistas en orden; null vuelve a los predeterminados y borra playlist_music', async () => {
    const { h, handlers, track } = await setup();
    const [a, b, c] = [track('A'), track('B'), track('C')];
    await handlers.saveDefaults({ settings: settings({ slideMs: 3000, trackIds: [a.id] }) });
    const p = createPlaylist(h.db(), 'Vacaciones', 1);

    // Sin ajustes propios: los predeterminados.
    expect((await handlers.getConfig({ playlistId: p.id })).settings).toEqual(
      settings({ slideMs: 3000, trackIds: [a.id] }),
    );

    const own = settings({ transition: 'kenburns', slideMs: 10_500, trackIds: [c.id, a.id, b.id] });
    handlers.setPresentation({ id: p.id, settings: own });
    expect(await handlers.getConfig({ playlistId: p.id })).toEqual({
      settings: own,
      tracks: [c, a, b],
    });
    // presentation_json sin trackIds; las pistas solo en playlist_music.
    const stored = playlistPresentation(h.db(), p.id);
    expect(stored?.trackIds).toEqual([c.id, a.id, b.id]);
    expect(JSON.parse(stored?.json ?? 'null')).not.toHaveProperty('trackIds');
    expect(stored?.json).not.toContain(a.id);
    expect(
      h.db().prepare('SELECT presentation_json IS NOT NULL AS c, updated_at FROM playlists').get(),
    ).toEqual({ c: 1, updated_at: 42 });

    // Sustituir: la lista nueva reemplaza a la anterior.
    handlers.setPresentation({ id: p.id, settings: { ...own, trackIds: [b.id] } });
    expect((await handlers.getConfig({ playlistId: p.id })).tracks).toEqual([b]);

    // null: vuelve a los predeterminados y vacía playlist_music.
    handlers.setPresentation({ id: p.id, settings: null });
    expect(playlistPresentation(h.db(), p.id)).toEqual({ json: null, trackIds: [] });
    expect((await handlers.getConfig({ playlistId: p.id })).settings).toEqual(
      settings({ slideMs: 3000, trackIds: [a.id] }),
    );
    // Los predeterminados no cambiaron.
    expect((await handlers.getConfig({})).settings.slideMs).toBe(3000);
  });

  it('pistas inexistentes o playlist inexistente → NOT_FOUND sin cambiar nada', async () => {
    const { h, handlers, track } = await setup();
    const a = track('A');
    const p = createPlaylist(h.db(), 'P');
    handlers.setPresentation({ id: p.id, settings: settings({ trackIds: [a.id] }) });
    const err = await appErrorOf(() =>
      handlers.setPresentation({ id: p.id, settings: settings({ trackIds: ['e'.repeat(32)] }) }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(playlistPresentation(h.db(), p.id)?.trackIds).toEqual([a.id]);
    expect(
      (await appErrorOf(() => handlers.setPresentation({ id: 'd'.repeat(32), settings: null })))
        .code,
    ).toBe('NOT_FOUND');
    expect((await appErrorOf(() => handlers.getConfig({ playlistId: 'd'.repeat(32) }))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('un presentation_json dañado se trata como ausente (los predeterminados)', async () => {
    const { h, handlers } = await setup();
    const p = createPlaylist(h.db(), 'P');
    h.db().prepare('UPDATE playlists SET presentation_json = \'{"x":1}\' WHERE id = ?').run(p.id);
    expect((await handlers.getConfig({ playlistId: p.id })).settings).toEqual(settings());
  });
});

describe('esquemas (§10.3)', () => {
  const save = SCHEMAS['presentation:saveDefaults'];
  const set = SCHEMAS['playlists:setPresentation'];

  it('slideMs fuera de pasos de 500 o del rango → VALIDATION', () => {
    for (const slideMs of [5250, 999, 60_500, 1000.5]) {
      expect(save.safeParse({ settings: settings({ slideMs }) }).success).toBe(false);
    }
    for (const slideMs of [1000, 1500, 60_000]) {
      expect(save.safeParse({ settings: settings({ slideMs }) }).success).toBe(true);
    }
  });

  it('resto de reglas: transitionMs, volúmenes, musicFadeMs, randomPool y trackIds', () => {
    const bad: Partial<PresentationSettings>[] = [
      { transitionMs: 3001 },
      { transitionMs: -1 },
      { musicVolume: 1.01 },
      { videoVolume: -0.1 },
      { musicFadeMs: 5001 },
      { randomPool: [] },
      { randomPool: ['fade', 'fade'] },
      { trackIds: ['a'.repeat(32), 'a'.repeat(32)] },
      { trackIds: Array.from({ length: 101 }, () => randomBytes(16).toString('hex')) },
      { trackIds: ['NO-ES-UN-ID'] },
    ];
    for (const over of bad)
      expect(save.safeParse({ settings: settings(over) }).success).toBe(false);
    expect(save.safeParse({ settings: { ...settings(), extra: 1 } }).success).toBe(false);
    expect(set.safeParse({ id: 'a'.repeat(32), settings: null }).success).toBe(true);
    expect(set.safeParse({ id: 'a'.repeat(32), settings: settings() }).success).toBe(true);
  });
});
