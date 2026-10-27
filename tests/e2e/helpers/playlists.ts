// Ayudantes de los E2E de playlists y música (docs/PLAN.md 4.4 y 4.7): llamar a canales IPC desde el
// renderer, ir a la pantalla Playlists, añadir la selección a una playlist por el menú de la barra de
// selección y leer el orden de una playlist tanto en la interfaz como en main.
import { expect, type Locator, type Page } from '@playwright/test';
import { gridCells } from './library';

type Raw = { ok: boolean; data?: unknown; error?: { code: string } };

/** Llama a un canal IPC con el preload real y devuelve `data` (falla si main devuelve un error). */
export async function invokeIpc<T>(page: Page, channel: string, req?: unknown): Promise<T> {
  const res = await page.evaluate(
    async ({ c, r }) => {
      const api = (
        window as unknown as { galeria: { invoke(c: string, r?: unknown): Promise<unknown> } }
      ).galeria;
      return (await api.invoke(c, r)) as Raw;
    },
    { c: channel, r: req },
  );
  if (!res.ok) throw new Error(`${channel} falló: ${JSON.stringify(res.error)}`);
  return res.data as T;
}

export function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Navegación principal' });
}

/** Navegación → Playlists (la lista de tarjetas). */
export async function openPlaylistsScreen(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'Playlists', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Playlists' })).toBeVisible();
}

/** Navegación → Galería → Todo. */
export async function openGallery(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'Todo', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
}

/** Selecciona las celdas por índice con Ctrl+clic. */
export async function ctrlSelect(page: Page, indexes: number[]): Promise<void> {
  for (const i of indexes)
    await gridCells(page)
      .nth(i)
      .click({ modifiers: ['Control'] });
}

export function selectionBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Selección' });
}

/** "Añadir a playlist" → "Nueva playlist…" → nombre → crear (y añadir la selección). */
export async function addSelectionToNewPlaylist(page: Page, name: string): Promise<void> {
  await selectionBar(page).getByRole('button', { name: 'Añadir a playlist' }).click();
  await page.getByRole('menuitem', { name: 'Nueva playlist…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva playlist' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Nombre', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: /^Crear/ }).click();
  await expect(dialog).toBeHidden();
}

/** "Añadir a playlist" → una playlist existente. */
export async function addSelectionToPlaylist(page: Page, name: string): Promise<void> {
  await selectionBar(page).getByRole('button', { name: 'Añadir a playlist' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${escapeRegExp(name)}`) }).click();
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** La tarjeta de una playlist en la pantalla Playlists. */
export function playlistCard(page: Page, name: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}, \\d+ elementos?$`) });
}

/** Abre una playlist desde su tarjeta y espera a su detalle. */
export async function openPlaylistDetail(page: Page, name: string): Promise<void> {
  await openPlaylistsScreen(page);
  await playlistCard(page, name).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

export function detailList(page: Page): Locator {
  return page.getByRole('list', { name: /^Elementos de «/ });
}

/** Nombres de las filas del detalle de la playlist, en el orden mostrado. */
export async function detailNames(page: Page): Promise<string[]> {
  return detailList(page)
    .getByRole('listitem')
    .evaluateAll((els) => els.map((el) => el.querySelector('p')?.textContent ?? ''));
}

export function handleOf(page: Page, name: string): Locator {
  return detailList(page).getByRole('button', {
    name: new RegExp(`^Mover «${escapeRegExp(name)}», posición`),
  });
}

interface PlaylistRow {
  id: string;
  name: string;
}

/** Nombres de los medios de una playlist según main (media:list por `position`), en su orden. */
export async function playlistOrderInMain(page: Page, playlistName: string): Promise<string[]> {
  const all = await invokeIpc<PlaylistRow[]>(page, 'playlists:list');
  const found = all.find((p) => p.name === playlistName);
  if (!found) throw new Error(`no hay una playlist «${playlistName}»`);
  const list = await invokeIpc<{ items: { id: string; name: string }[] }>(page, 'media:list', {
    kind: 'all',
    playlistId: found.id,
    sort: { field: 'position', dir: 'asc' },
  });
  return list.items.map((i) => i.name);
}

/** Ids de los medios de una playlist en su orden (para buscarlos en disco). */
export async function playlistIdsInMain(page: Page, playlistName: string): Promise<string[]> {
  const all = await invokeIpc<PlaylistRow[]>(page, 'playlists:list');
  const found = all.find((p) => p.name === playlistName);
  if (!found) throw new Error(`no hay una playlist «${playlistName}»`);
  const list = await invokeIpc<{ items: { id: string }[] }>(page, 'media:list', {
    kind: 'all',
    playlistId: found.id,
    sort: { field: 'position', dir: 'asc' },
  });
  return list.items.map((i) => i.id);
}

/** Espera a que las imágenes de un contenedor estén cargadas. */
export async function imagesLoaded(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((root) => {
        const imgs = Array.from(root.querySelectorAll('img'));
        return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
      }),
    )
    .toBe(true);
}
