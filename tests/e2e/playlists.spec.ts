// Playlists y música en la interfaz (docs/PLAN.md 4.4 y 4.7; docs/DESIGN.md §14.6, §14.8, §14.9, §22):
// crear una playlist desde una selección, añadir más, reordenar con teclado (Alt+↑/↓ y arrastre con
// Espacio y flechas, con anuncios) y con ratón, quitar, filtrar la galería por la playlist (y su
// orden), renombrar, importar música (el original sigue en su sitio con el mismo SHA-256 y la copia
// va a music/ con nombre neutro), asignarla a la playlist, borrar la playlist sin borrar los medios y,
// al final, comprobar que ningún nombre (medios, playlists, música original) ni el orden de la
// playlist aparecen en claro bajo la raíz de datos. Ventana discreta (nota 135). Solo fotos
// sintéticas y tonos de ffmpeg bajo tests/.tmp/.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { lockAndGetNewWindow, readProfilesJson } from './helpers/launch';
import {
  cellNames,
  expectItemCount,
  filesUnder,
  gridCells,
  importAndSummarize,
  launchUnlocked,
  mockOpenDialog,
  newSourceDir,
  PROFILE,
  removeDir,
  sha256File,
  writePhoto,
  writeTone,
} from './helpers/library';
import {
  addSelectionToNewPlaylist,
  addSelectionToPlaylist,
  clickSelect,
  detailList,
  detailNames,
  handleOf,
  invokeIpc,
  openGallery,
  openPlaylistDetail,
  openPlaylistsScreen,
  playlistCard,
  playlistIdsInMain,
  playlistOrderInMain,
  selectionBar,
} from './helpers/playlists';

test('playlists: crear desde la selección, reordenar, filtrar, música y nada en claro en disco', async () => {
  test.setTimeout(600_000);
  const launched = await launchUnlocked({}, { width: 1280, height: 900 });
  const src = newSourceDir();
  try {
    const { app, dataDir, page } = launched;
    const tag = randomBytes(5).toString('hex');
    // Fotos sintéticas con fechas distintas: en la galería (captura descendente) salen
    // Delta, Gamma, Beta, Alfa.
    const names = ['Alfa', 'Beta', 'Gamma', 'Delta'].map((n) => `Medio${tag}${n}`);
    const [alfa, beta, gamma, delta] = names as [string, string, string, string];
    const paths: string[] = [];
    for (const [i, name] of names.entries()) {
      const path = join(src, `${name}.jpg`);
      await writePhoto(path, i + 3, { mtime: new Date(2021 + i, 5, 10, 12) });
      paths.push(path);
    }
    expect((await importAndSummarize(page, app, paths)).imported).toBe(4);
    await expectItemCount(page, 4);
    expect(await cellNames(page)).toEqual([delta, gamma, beta, alfa]);

    // ── Crear una playlist desde la selección (Beta y Delta; se añaden en el orden de la galería).
    const list1 = `Lista${tag}Uno`;
    await clickSelect(page, [2, 0]);
    await expect(page.getByText('2 seleccionados', { exact: true })).toBeVisible();
    await addSelectionToNewPlaylist(page, list1);
    await expect(page.getByText(`Se añadieron 2 elementos a «${list1}».`).first()).toBeVisible();
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([delta, beta]);

    // ── Añadir todo a la misma: los dos que ya estaban cuentan como tales.
    await gridCells(page).first().focus();
    await page.keyboard.press('Control+A');
    await expect(page.getByText('4 seleccionados', { exact: true })).toBeVisible();
    await addSelectionToPlaylist(page, list1);
    await expect(
      page.getByText(`Se añadieron 2 elementos a «${list1}». 2 ya estaban.`).first(),
    ).toBeVisible();
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([delta, beta, gamma, alfa]);

    // ── Pantalla Playlists: la tarjeta con su recuento y el detalle.
    await openPlaylistsScreen(page);
    await expect(playlistCard(page, list1)).toHaveAccessibleName(`${list1}, 4 elementos`);
    await playlistCard(page, list1).click();
    await expect(detailList(page).getByRole('listitem')).toHaveCount(4);
    expect(await detailNames(page)).toEqual([delta, beta, gamma, alfa]);

    // ── Reordenar con Alt+↓ sobre el asa: Delta baja una posición, conserva el foco y se anuncia.
    const live = page.locator('[id^="DndLiveRegion"]');
    await handleOf(page, delta).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => detailNames(page)).toEqual([beta, delta, gamma, alfa]);
    await expect(handleOf(page, delta)).toBeFocused();
    await expect(
      page.getByText(`«${delta}» movido a la posición 2 de 4.`, { exact: false }).first(),
    ).toBeAttached();
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([beta, delta, gamma, alfa]);
    // En el extremo no cambia nada.
    await handleOf(page, beta).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByText(`«${beta}» ya está en la posición 1 de 4`).first()).toBeAttached();
    expect(await detailNames(page)).toEqual([beta, delta, gamma, alfa]);

    // ── Reordenar con el teclado al estilo dnd-kit: Espacio levanta, ↑ mueve, Espacio suelta.
    // dnd-kit anuncia «levantado» y enseguida «sobre…»: un observador recoge todos los textos.
    await page.evaluate(() => {
      const w = window as unknown as { __announced: string[] };
      w.__announced = [];
      new MutationObserver(() => {
        const text = document.querySelector('[id^="DndLiveRegion"]')?.textContent ?? '';
        if (text && w.__announced[w.__announced.length - 1] !== text) w.__announced.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await handleOf(page, alfa).focus();
    await page.keyboard.press('Space');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __announced: string[] }).__announced))
      .toContain(`Elemento «${alfa}» levantado, posición 4 de 4.`);
    // dnd-kit mide las filas tras levantar; una flecha demasiado pronto se ignora (una persona tarda más).
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowUp');
    await expect(live).toContainText(`«${alfa}» está sobre la posición 3 de 4.`);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await expect(live).toContainText(`«${alfa}» soltado en la posición 2 de 4.`);
    await expect.poll(() => detailNames(page)).toEqual([beta, alfa, delta, gamma]);
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([beta, alfa, delta, gamma]);
    await expect(handleOf(page, alfa)).toBeFocused();

    // Esc cancela el movimiento: el orden no cambia.
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await expect(live).toContainText('Movimiento cancelado.');
    expect(await detailNames(page)).toEqual([beta, alfa, delta, gamma]);
    expect(await playlistOrderInMain(page, list1)).toEqual([beta, alfa, delta, gamma]);

    // ── Reordenar arrastrando con el ratón: Gamma (última) pasa a la primera posición.
    const from = await handleOf(page, gamma).boundingBox();
    const to = await handleOf(page, beta).boundingBox();
    if (!from || !to) throw new Error('sin cajas de los asas');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 6, { steps: 20 });
    await page.mouse.up();
    await expect.poll(() => detailNames(page)).toEqual([gamma, beta, alfa, delta]);
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([gamma, beta, alfa, delta]);

    // ── Quitar «Delta» de la playlist: sigue en la galería.
    // Con la CPU saturada el clic puede caer mientras la fila aún se asienta tras soltar: se
    // reintenta mientras «Delta» siga en la lista (solo del test).
    await expect(async () => {
      const remove = detailList(page).getByRole('button', {
        name: `Quitar «${delta}» de la playlist`,
      });
      if ((await remove.count()) > 0) await remove.click();
      await expect.poll(() => detailNames(page), { timeout: 5000 }).toEqual([gamma, beta, alfa]);
    }).toPass({ timeout: 45_000 });
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([gamma, beta, alfa]);

    // ── Filtrar la galería por la playlist (desde el detalle): su orden y el chip.
    await page.getByRole('button', { name: 'Ver en la galería' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Filtros activos' })).toContainText(
      `Playlist: ${list1}`,
    );
    await expectItemCount(page, 3);
    await expect.poll(() => cellNames(page)).toEqual([gamma, beta, alfa]);
    // El menú Ordenar ofrece «Orden de la playlist», marcado; con otro orden la rejilla cambia.
    await page.getByRole('button', { name: 'Ordenar', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Orden de la playlist' })).toBeChecked();
    await page.getByRole('menuitemradio', { name: 'Nombre', exact: true }).click();
    await page.getByRole('button', { name: 'Ordenar', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Ascendente' }).click();
    await expect.poll(() => cellNames(page)).toEqual([alfa, beta, gamma]);
    await page.getByRole('button', { name: 'Ordenar', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Orden de la playlist' }).click();
    await expect.poll(() => cellNames(page)).toEqual([gamma, beta, alfa]);
    // «Quitar de la playlist» desde la galería filtrada (la selección de antes se conserva: se limpia).
    await selectionBar(page).getByRole('button', { name: 'Cancelar selección' }).click();
    await gridCells(page)
      .nth(1)
      .click({ modifiers: ['Control'] });
    await selectionBar(page).getByRole('button', { name: 'Quitar de la playlist' }).click();
    await expect.poll(() => cellNames(page)).toEqual([gamma, alfa]);
    await expect.poll(() => playlistOrderInMain(page, list1)).toEqual([gamma, alfa]);
    // Quitar el chip devuelve toda la biblioteca (Beta nunca se borró).
    await page.getByRole('button', { name: `Quitar filtro: Playlist: ${list1}` }).click();
    await expectItemCount(page, 4);

    // ── Filtro de playlist desde el popover «Filtros» (Select).
    await page.getByRole('button', { name: /^Filtros/ }).click();
    await page.getByRole('combobox', { name: 'Playlist' }).click();
    await page.getByRole('option', { name: list1 }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => cellNames(page)).toEqual([gamma, alfa]);
    await page.getByRole('button', { name: `Quitar filtro: Playlist: ${list1}` }).click();
    await expectItemCount(page, 4);

    // ── Renombrar desde el menú de la tarjeta.
    const renamed = `Lista${tag}Final`;
    await openPlaylistsScreen(page);
    await page.getByRole('button', { name: `Opciones de «${list1}»` }).click();
    await page.getByRole('menuitem', { name: 'Renombrar' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Renombrar playlist' });
    await renameDialog.getByLabel('Nombre', { exact: true }).fill(renamed);
    await renameDialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(renameDialog).toBeHidden();
    await expect(playlistCard(page, renamed)).toBeVisible();
    await expect(playlistCard(page, list1)).toHaveCount(0);

    // ── Música: importar desde Ajustes → Música. El original sigue en su sitio y la copia es neutra.
    const markerA = `Cancion${tag}Uno`;
    const markerB = `Cancion${tag}Dos`;
    const trackA = join(src, `${markerA}.wav`);
    const trackB = join(src, `${markerB}.wav`);
    writeTone(trackA, 2);
    writeTone(trackB, 3);
    const shaA = sha256File(trackA);
    const shaB = sha256File(trackB);
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
    await page.getByRole('tab', { name: 'Música' }).click();
    const notice = page.getByRole('note');
    await expect(notice).toContainText('La música se guarda sin cifrar.');
    await expect(notice).toContainText('el original no se borra');
    await mockOpenDialog(app, [trackA, trackB]);
    await page.getByRole('button', { name: 'Importar música…' }).click();
    const summary = page.getByRole('region', { name: 'Resumen de la importación de música' });
    await expect(summary).toContainText('Se añadieron 2 pistas.');
    await expect(summary).toContainText('Los archivos originales siguen en su carpeta.');
    const tracks = page.getByRole('list', { name: 'Pistas de música' });
    await expect(tracks.getByRole('listitem')).toHaveCount(2);
    await expect(tracks).toContainText(markerA);
    await expect(tracks).toContainText(markerB);
    // Originales intactos.
    expect(
      readdirSync(src)
        .filter((f) => f.endsWith('.wav'))
        .sort(),
    ).toEqual([`${markerA}.wav`, `${markerB}.wav`].sort());
    expect(sha256File(trackA)).toBe(shaA);
    expect(sha256File(trackB)).toBe(shaB);
    // Copias: nombre neutro (<id>.wav), mismos bytes.
    const profileId = readProfilesJson(dataDir).profiles.find((p) => p.name === PROFILE)?.id ?? '';
    const musicDir = join(dataDir, 'vaults', profileId, 'music');
    const copies = readdirSync(musicDir);
    expect(copies).toHaveLength(2);
    for (const file of copies) expect(file).toMatch(/^[0-9a-f]{32}\.wav$/);
    expect(copies.map((f) => sha256File(join(musicDir, f))).sort()).toEqual([shaA, shaB].sort());

    // Escuchar un fragmento y parar.
    const preview = page.getByRole('button', { name: `Escuchar un fragmento de «${markerA}»` });
    await preview.click();
    await expect(
      page.getByRole('button', { name: `Parar el fragmento de «${markerA}»` }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const a = document.querySelector('audio');
          return a ? a.currentSrc.startsWith('vault://music/') && !a.error : false;
        }),
      )
      .toBe(true);
    await page.getByRole('button', { name: `Parar el fragmento de «${markerA}»` }).click();
    await expect(
      page.getByRole('button', { name: `Escuchar un fragmento de «${markerA}»` }),
    ).toHaveAttribute('aria-pressed', 'false');

    // Eliminar la pista B desde la interfaz: desaparece su copia; el original (B) sigue en su sitio.
    await page.getByRole('button', { name: `Eliminar «${markerB}»` }).click();
    const delTrack = page.getByRole('alertdialog', { name: 'Eliminar pista' });
    await expect(delTrack.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await delTrack.getByRole('button', { name: 'Eliminar pista' }).click();
    await expect(tracks.getByRole('listitem')).toHaveCount(1);
    await expect.poll(() => readdirSync(musicDir).length).toBe(1);
    expect(existsSync(trackB)).toBe(true);
    expect(sha256File(trackB)).toBe(shaB);

    // ── Asignar la pista A a la playlist (diálogo «Música» del detalle).
    await openPlaylistDetail(page, renamed);
    await page.getByRole('button', { name: 'Música', exact: true }).click();
    const musicDialog = page.getByRole('dialog', { name: `Música de «${renamed}»` });
    await musicDialog.getByRole('checkbox', { name: new RegExp(markerA) }).check();
    await musicDialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(musicDialog).toBeHidden();
    const playlists = await invokeIpc<
      { id: string; name: string; hasCustomPresentation: boolean }[]
    >(page, 'playlists:list');
    const mine = playlists.find((p) => p.name === renamed);
    expect(mine?.hasCustomPresentation).toBe(true);
    const cfg = await invokeIpc<{
      settings: { trackIds: string[]; musicEnabled: boolean };
      tracks: { title: string }[];
    }>(page, 'presentation:getConfig', { playlistId: mine?.id });
    expect(cfg.tracks.map((t) => t.title)).toEqual([markerA]);
    expect(cfg.settings.trackIds).toHaveLength(1);
    expect(cfg.settings.musicEnabled).toBe(true);
    // Y se puede quitar.
    await page.getByRole('button', { name: 'Música', exact: true }).click();
    await musicDialog.getByRole('checkbox', { name: new RegExp(markerA) }).uncheck();
    await musicDialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(musicDialog).toBeHidden();
    const cfg2 = await invokeIpc<{ tracks: unknown[] }>(page, 'presentation:getConfig', {
      playlistId: mine?.id,
    });
    expect(cfg2.tracks).toEqual([]);

    // ── «Ajustes de presentación» del detalle: «Usar los ajustes predeterminados» (§14.8, §17.2).
    const hasCustom = async (): Promise<boolean | undefined> =>
      (
        await invokeIpc<{ name: string; hasCustomPresentation: boolean }[]>(page, 'playlists:list')
      ).find((p) => p.name === renamed)?.hasCustomPresentation;
    const settingsDialog = page.getByRole('dialog', {
      name: `Ajustes de presentación de «${renamed}»`,
    });
    const useDefaults = settingsDialog.getByRole('switch', {
      name: 'Usar los ajustes predeterminados',
    });
    expect(await hasCustom()).toBe(true); // «Música» dejó ajustes propios
    await page.getByRole('button', { name: 'Ajustes de presentación', exact: true }).click();
    await expect(useDefaults).toBeEnabled();
    await expect(useDefaults).not.toBeChecked();
    await useDefaults.click();
    await expect(useDefaults).toBeChecked();
    await settingsDialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(settingsDialog).toBeHidden();
    await expect.poll(hasCustom).toBe(false); // vuelve a seguir los predeterminados
    // Y se pueden volver a tener ajustes propios.
    await page.getByRole('button', { name: 'Ajustes de presentación', exact: true }).click();
    await expect(useDefaults).toBeEnabled();
    await expect(useDefaults).toBeChecked();
    await useDefaults.click();
    await settingsDialog.getByRole('switch', { name: 'Repetir en bucle' }).click();
    await settingsDialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(settingsDialog).toBeHidden();
    await expect.poll(hasCustom).toBe(true);
    const own = await invokeIpc<{ settings: { loop: boolean } }>(page, 'presentation:getConfig', {
      playlistId: mine?.id,
    });
    expect(own.settings.loop).toBe(false);

    // Para la comprobación de disco: el orden final de la playlist que tuvo cuatro elementos.
    const finalIds = await playlistIdsInMain(page, renamed);
    expect(finalIds).toHaveLength(2);

    // ── Eliminar la playlist: confirmación con el foco en «Cancelar»; los medios siguen.
    await openPlaylistsScreen(page);
    await page.getByRole('button', { name: `Opciones de «${renamed}»` }).click();
    await page.getByRole('menuitem', { name: 'Eliminar' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Eliminar playlist' });
    await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(playlistCard(page, renamed)).toBeVisible();
    await page.getByRole('button', { name: `Opciones de «${renamed}»` }).click();
    await page.getByRole('menuitem', { name: 'Eliminar' }).click();
    await confirm.getByRole('button', { name: 'Eliminar playlist' }).click();
    await expect(playlistCard(page, renamed)).toHaveCount(0);
    await expect(page.getByText('Todavía no hay playlists.')).toBeVisible();
    await openGallery(page);
    await expectItemCount(page, 4);

    // ── Disco: ni los nombres ni el orden aparecen en claro. Se recrea una playlist con un orden
    // conocido para buscar también sus ids concatenados.
    const lastList = `Lista${tag}Ultima`;
    await clickSelect(page, [0, 1, 2]);
    await addSelectionToNewPlaylist(page, lastList);
    const orderIds = await playlistIdsInMain(page, lastList);
    expect(orderIds).toHaveLength(3);

    await lockAndGetNewWindow(app, () => page.keyboard.press('Control+L'));
    await launched.quit();

    const texts = [...names, list1, renamed, lastList, markerA, markerB];
    const needles = [
      ...texts.flatMap((text) => [
        { label: `${text} utf8`, bytes: Buffer.from(text, 'utf8') },
        { label: `${text} utf16le`, bytes: Buffer.from(text, 'utf16le') },
      ]),
      { label: 'ids en orden', bytes: Buffer.from(orderIds.join(''), 'utf8') },
      { label: 'ids en orden (coma)', bytes: Buffer.from(orderIds.join(','), 'utf8') },
      { label: 'ids en orden (JSON)', bytes: Buffer.from(JSON.stringify(orderIds), 'utf8') },
    ];
    const hits: string[] = [];
    let scanned = 0;
    let profileNameFound = false;
    for (const file of [dataDir, `${dataDir}.electron`].flatMap(filesUnder)) {
      const rel = relative(dataDir, file);
      const data = readFileSync(file);
      scanned += 1;
      if (data.includes(Buffer.from(PROFILE, 'utf8'))) profileNameFound = true;
      for (const text of texts) {
        if (rel.toLowerCase().includes(text.toLowerCase())) hits.push(`nombre de archivo ${rel}`);
      }
      for (const n of needles) if (data.includes(n.bytes)) hits.push(`${n.label} en ${rel}`);
    }
    console.log(`[e2e] archivos analizados: ${scanned}`);
    expect(scanned).toBeGreaterThan(10);
    expect(profileNameFound).toBe(true); // control positivo: el nombre del perfil sí está en claro
    expect(hits).toEqual([]);
    // music/ solo tiene música con nombres neutros (queda la pista A).
    const left = readdirSync(musicDir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^[0-9a-f]{32}\.wav$/);
  } finally {
    // Si el test falló antes de cerrar la app, cerrarla primero (si no, Windows no deja borrar).
    await launched.app.close().catch(() => undefined);
    launched.cleanup();
    removeDir(src);
  }
});

test('detalle de playlist: modo selección con las reglas de la galería, asas intactas y visor con el orden de la playlist', async () => {
  test.setTimeout(600_000);
  const launched = await launchUnlocked({}, { width: 1280, height: 900 });
  const src = newSourceDir();
  try {
    const { app, page } = launched;
    const tag = randomBytes(5).toString('hex');
    const names = ['Alfa', 'Beta', 'Gamma', 'Delta'].map((n) => `Sel${tag}${n}`);
    const [alfa, beta, gamma, delta] = names as [string, string, string, string];
    const paths: string[] = [];
    for (const [i, name] of names.entries()) {
      const path = join(src, `${name}.jpg`);
      await writePhoto(path, i + 3, { mtime: new Date(2021 + i, 5, 10, 12) });
      paths.push(path);
    }
    expect((await importAndSummarize(page, app, paths)).imported).toBe(4);
    await expectItemCount(page, 4);
    expect(await cellNames(page)).toEqual([delta, gamma, beta, alfa]); // orden de la galería

    // La playlist con un orden distinto del de la galería: Beta, Delta, Alfa, Gamma.
    const list = `Sel${tag}Lista`;
    await clickSelect(page, [0, 1, 2, 3]);
    await addSelectionToNewPlaylist(page, list);
    const all = await invokeIpc<{ id: string; name: string }[]>(page, 'playlists:list');
    const playlistId = all.find((p) => p.name === list)?.id ?? '';
    const ids = await playlistIdsInMain(page, list); // delta, gamma, beta, alfa
    await invokeIpc(page, 'playlists:reorder', {
      id: playlistId,
      mediaIds: [ids[2], ids[0], ids[3], ids[1]],
    });
    await expect.poll(() => playlistOrderInMain(page, list)).toEqual([beta, delta, alfa, gamma]);

    await openPlaylistDetail(page, list);
    await expect.poll(() => detailNames(page)).toEqual([beta, delta, alfa, gamma]);
    const rows = detailList(page).getByRole('listitem');
    const row = (name: string): Locator => rows.filter({ hasText: name });
    const box = (name: string): Locator => row(name).getByRole('checkbox');
    const marked = detailList(page).locator('li[data-selected]');
    const viewer = page.locator('[data-viewer]');
    const closeViewer = async (): Promise<void> => {
      await expect(viewer).toHaveAttribute('data-viewer-state', 'open', { timeout: 10_000 });
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);
    };

    // ── Sin selección, un clic marca la fila (no abre) y aparece la barra con «1»; otro clic la quita.
    await row(delta).locator('img').click();
    await expect(marked).toHaveCount(1);
    await expect(row(delta)).toHaveAttribute('data-selected', '');
    await expect(selectionBar(page).getByText('1 seleccionado', { exact: true })).toBeVisible();
    await expect(viewer).toHaveCount(0);
    await row(delta).locator('img').click();
    await expect(marked).toHaveCount(0);
    await expect(selectionBar(page)).toBeHidden();
    await expect(viewer).toHaveCount(0);

    // ── Sin selección, un doble clic abre el visor con la lista de la playlist (←/→ siguen su
    // orden) y deja la selección vacía.
    await row(delta).locator('img').dblclick();
    await expect(viewer).toHaveAccessibleName(delta);
    await expect(viewer).toHaveAttribute('data-viewer-state', 'open', { timeout: 10_000 });
    await page.keyboard.press('ArrowRight');
    await expect(viewer).toHaveAccessibleName(alfa); // en la galería, tras Delta iría Gamma
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(viewer).toHaveAccessibleName(beta);
    await closeViewer();
    await expect(marked).toHaveCount(0);

    // ── La casilla entra en el modo selección; un clic en cualquier parte de otra fila la marca.
    await box(beta).click();
    await expect(box(beta)).toHaveAttribute('aria-checked', 'true');
    await expect(selectionBar(page).getByText('1 seleccionado', { exact: true })).toBeVisible();
    await row(alfa).locator('p').first().click();
    await expect(marked).toHaveCount(2);
    await expect(viewer).toHaveCount(0);
    for (const n of names) {
      await expect
        .poll(() => box(n).evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)))
        .toBe(1);
    }
    // Clic en el asa: no marca ni desmarca la fila.
    await handleOf(page, gamma).click();
    await expect(marked).toHaveCount(2);
    await expect(row(gamma)).not.toHaveAttribute('data-selected', '');

    // Ctrl+clic alterna y Mayús+clic marca el rango en el orden de la playlist (Beta..Gamma).
    await row(delta)
      .locator('img')
      .click({ modifiers: ['Control'] });
    await expect(marked).toHaveCount(3);
    await row(delta)
      .locator('img')
      .click({ modifiers: ['Control'] });
    await expect(marked).toHaveCount(2);
    // El ancla pasa a Beta (primera fila); Mayús+clic en Gamma marca las cuatro.
    await row(beta)
      .locator('img')
      .click({ modifiers: ['Control'] });
    await expect(marked).toHaveCount(1);
    await row(gamma)
      .locator('img')
      .click({ modifiers: ['Shift'] });
    await expect(marked).toHaveCount(4);
    await expect(selectionBar(page).getByText('4 seleccionados', { exact: true })).toBeVisible();

    // ── Doble clic: abre (con la lista de la playlist) y deja la selección como estaba.
    await row(delta).locator('img').dblclick();
    await expect(viewer).toHaveAccessibleName(delta);
    await closeViewer();
    await expect(marked).toHaveCount(4);
    await expect(box(delta)).toBeFocused();

    // ── Con filas marcadas, el reorden sigue funcionando y no cambia la selección.
    await handleOf(page, delta).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => detailNames(page)).toEqual([delta, beta, alfa, gamma]);
    await expect(marked).toHaveCount(4);
    const from = await handleOf(page, gamma).boundingBox();
    const to = await handleOf(page, delta).boundingBox();
    if (!from || !to) throw new Error('sin cajas de los asas');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 6, { steps: 20 });
    await page.mouse.up();
    await expect.poll(() => detailNames(page)).toEqual([gamma, delta, beta, alfa]);
    await expect.poll(() => playlistOrderInMain(page, list)).toEqual([gamma, delta, beta, alfa]);
    await expect(marked).toHaveCount(4);
    await expect(viewer).toHaveCount(0);

    // Con el teclado: Espacio levanta, Esc solo cancela el arrastre (la selección sigue).
    await handleOf(page, alfa).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('Movimiento cancelado.');
    expect(await detailNames(page)).toEqual([gamma, delta, beta, alfa]);
    await expect(marked).toHaveCount(4);

    // Fuera de un arrastre, Esc limpia la selección (y vuelve el modo normal).
    await box(gamma).focus();
    await page.keyboard.press('Escape');
    await expect(marked).toHaveCount(0);
    await expect(selectionBar(page)).toBeHidden();

    // ── Teclado: Espacio marca la casilla enfocada, Intro abre ese elemento, Ctrl+A marca todo.
    await box(delta).focus();
    await page.keyboard.press('Space');
    await expect(box(delta)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Enter');
    await expect(viewer).toHaveAccessibleName(delta);
    await closeViewer();
    await expect(marked).toHaveCount(1);
    await page.keyboard.press('Control+A');
    await expect(marked).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(marked).toHaveCount(0);

    // ── «Quitar de la playlist» por lote: solo lo marcado, y los medios siguen en la galería.
    await box(delta).click();
    await row(alfa).locator('img').click();
    await expect(marked).toHaveCount(2);
    await selectionBar(page).getByRole('button', { name: 'Quitar de la playlist' }).click();
    await expect.poll(() => detailNames(page)).toEqual([gamma, beta]);
    await expect.poll(() => playlistOrderInMain(page, list)).toEqual([gamma, beta]);
    await expect(selectionBar(page)).toBeHidden();
    await openGallery(page);
    await expectItemCount(page, 4);

    // ── «Quitar» de una fila sin selección no abre el visor ni marca nada.
    await openPlaylistDetail(page, list);
    await detailList(page)
      .getByRole('button', { name: `Quitar «${beta}» de la playlist` })
      .click();
    await expect.poll(() => detailNames(page)).toEqual([gamma]);
    await expect(viewer).toHaveCount(0);
    await expect(marked).toHaveCount(0);
  } finally {
    await launched.app.close().catch(() => undefined);
    launched.cleanup();
    removeDir(src);
  }
});
