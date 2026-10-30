// Capturas de los temas para revisar a mano (docs/PLAN.md 6.5; anexo §10: no se versionan referencias
// de `toHaveScreenshot`). Para cada tema y esquema (Clásico claro y oscuro, Mosaico, Ondas, Cristal
// claro y oscuro, Cine) guarda, en tests/.tmp/screenshots/fase-6/<tema>-<esquema>/, estas pantallas:
// 01-picker (en Cristal también 01-picker-password), 02-unlock, 03-gallery, 04-gallery-selection,
// 05-playlists, 06-playlist-detail, 07-viewer, 08-editor, 09-player, 10-presentation-setup, 11-dual,
// 12-merge-dialog (con el grupo «Resolución de salida» y sus opciones a la vista) y 13-settings
// (Ajustes → Apariencia). `GALERIA_SHOTS_DIR` cambia la carpeta de salida. Perfil de prueba con
// `prefs.contentProtection = false` (si no, las capturas salen negras), animaciones desactivadas en
// cada captura, ventana discreta (nota 135) y datos solo bajo tests/.tmp/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT } from './helpers/launch';
import {
  controls,
  importDualFixtures,
  LEFT_NAME,
  openDualFromNav,
  pickVideo,
  RIGHT_NAME,
  waitVideosReady,
} from './helpers/dual';
import {
  addSelectionToNewPlaylist,
  imagesLoaded,
  openPlaylistDetail,
  openPlaylistsScreen,
  selectionBar,
} from './helpers/playlists';
import {
  expectItemCount,
  gridCells,
  importAndSummarize,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  writePhoto,
} from './helpers/library';

const OUT = process.env.GALERIA_SHOTS_DIR ?? join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-6');
const CASES = [
  { id: 'fotos', name: 'Clásico', scheme: 'light', folder: 'fotos-claro' },
  { id: 'fotos', name: 'Clásico', scheme: 'dark', folder: 'fotos-oscuro' },
  { id: 'xbox', name: 'Mosaico', scheme: 'dark', folder: 'xbox-oscuro' },
  { id: 'ps3', name: 'Ondas', scheme: 'dark', folder: 'ps3-oscuro' },
  { id: 'macos', name: 'Cristal', scheme: 'light', folder: 'macos-claro' },
  { id: 'macos', name: 'Cristal', scheme: 'dark', folder: 'macos-oscuro' },
  { id: 'cine', name: 'Cine', scheme: 'dark', folder: 'cine-oscuro' },
] as const;

/** Cierra los avisos («Se añadieron…») para que no salgan en la captura. */
async function dismissToasts(page: Page): Promise<void> {
  const close = page
    .getByRole('region', { name: /^Notificaciones/ })
    .getByRole('button', { name: 'Cerrar' });
  for (let i = 0; i < 8 && (await close.count()) > 0; i += 1) {
    await close.first().click();
    await page.waitForTimeout(150);
  }
  await expect(close).toHaveCount(0);
}

const player = (page: Page): Locator => page.locator('[data-player]');
const viewerRoot = (page: Page): Locator => page.locator('[data-viewer]');

for (const c of CASES) {
  test(`capturas del tema ${c.name} (${c.scheme})`, async () => {
    test.setTimeout(420_000);
    const dir = join(OUT, c.folder);
    mkdirSync(dir, { recursive: true });
    const launched = await launchApp();
    const src = newSourceDir();
    try {
      const { page, app } = launched;
      const snap = async (name: string, wait = 600): Promise<void> => {
        await dismissToasts(page);
        await page.mouse.move(5, 5);
        // El fundido del tema y las animaciones de entrada ya han terminado.
        await page.waitForTimeout(wait);
        await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' });
      };
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
      });
      await page.emulateMedia({ colorScheme: c.scheme, reducedMotion: 'no-preference' });
      await createProfile(page, PROFILE, PASSWORD);
      await choosePickerTheme(page, c.name);
      await expect(page.locator('html')).toHaveAttribute('data-theme', c.id);
      // El selector `fluent` fuerza el fondo oscuro (§15.10): el esquema se comprueba al entrar.
      if (c.id !== 'fotos')
        await expect(page.locator('html')).toHaveAttribute('data-scheme', c.scheme);
      await snap('01-picker');

      // Desbloqueo: diálogo (o formulario en línea en Cristal) con el foco en la contraseña.
      await page.getByRole('button', { name: PROFILE, exact: true }).click();
      const form = page
        .getByRole('dialog', { name: PROFILE })
        .or(page.getByRole('group', { name: `Contraseña de ${PROFILE}` }));
      await expect(form).toBeVisible();
      if (c.id === 'macos') await snap('01-picker-password');
      await form.getByLabel('Contraseña', { exact: true }).fill('clave-incorrecta');
      await form.getByLabel('Contraseña', { exact: true }).press('Enter');
      await expect(form.getByText('Contraseña incorrecta').first()).toBeVisible({
        timeout: 20_000,
      });
      await snap('02-unlock');
      await form.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
      await form.getByLabel('Contraseña', { exact: true }).press('Enter');
      await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-scheme', c.scheme);

      // Sin protección de contenido, las capturas de pantalla no salen en negro.
      const prefs = await page.evaluate(() =>
        (
          window as unknown as {
            galeria: { invoke(c: string, a: unknown): Promise<{ ok: boolean }> };
          }
        ).galeria.invoke('prefs:set', { contentProtection: false }),
      );
      expect(prefs.ok).toBe(true);

      // 14 fotos con fechas repartidas y los dos vídeos del vídeo dual.
      const paths: string[] = [];
      for (let i = 0; i < 14; i += 1) {
        const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
        await writePhoto(path, i + 5, { mtime: new Date(2025, i % 4, 3 + i, 12) });
        paths.push(path);
      }
      expect((await importAndSummarize(page, app, paths, 'files', 120_000)).imported).toBe(14);
      await importDualFixtures(page, app, src);
      await expectItemCount(page, 16);
      await imagesLoaded(page.getByRole('grid', { name: 'Galería' }));
      await snap('03-gallery');

      // Dos elementos seleccionados con un clic simple cada uno (anexo §9).
      const cells = gridCells(page);
      await cells.nth(2).click();
      await cells.nth(4).click();
      await expect(page.getByText('2 seleccionados', { exact: true })).toBeVisible();
      await snap('04-gallery-selection');

      // Cuatro playlists para ver los mosaicos de tamaños distintos, su pantalla y un detalle.
      await addSelectionToNewPlaylist(page, 'Vacaciones');
      await page.getByRole('button', { name: 'Cancelar selección' }).click();
      for (const [i, name] of ['Familia', 'Paisajes', 'Favoritas'].entries()) {
        await cells.nth(5 + i).click();
        await addSelectionToNewPlaylist(page, name);
        await page.getByRole('button', { name: 'Cancelar selección' }).click();
      }
      await openPlaylistsScreen(page);
      await snap('05-playlists');
      await openPlaylistDetail(page, 'Vacaciones');
      await expect(
        page.getByRole('list', { name: /^Elementos de «/ }).getByRole('listitem'),
      ).toHaveCount(2);
      await imagesLoaded(page.getByRole('list', { name: /^Elementos de «/ }));
      await snap('06-playlist-detail');
      await page.keyboard.press('Control+f');
      await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
      await expect(cells.first()).toBeVisible();

      // Visor: un doble clic abre una foto.
      const photo = page.getByRole('gridcell', { name: /^Foto 03/ });
      await photo.dblclick();
      await expect(viewerRoot(page)).toHaveAttribute('data-viewer-state', 'open', {
        timeout: 15_000,
      });
      await expect(page.locator('[data-edited-image="viewer"] img')).toBeVisible();
      await snap('07-viewer');

      // Editor: «E» en el visor.
      await page.keyboard.press('e');
      await expect(page.locator('[data-editor]')).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('[data-edited-image="editor"] img')
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
      await snap('08-editor');
      for (let i = 0; i < 3 && (await viewerRoot(page).count()) > 0; i += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      await expect(viewerRoot(page)).toHaveCount(0);

      // Reproductor: un vídeo en pausa en el segundo 5, con los controles a la vista.
      await page.getByRole('gridcell', { name: new RegExp(`^${LEFT_NAME}`) }).dblclick();
      await expect(viewerRoot(page)).toHaveAttribute('data-viewer-state', 'open', {
        timeout: 15_000,
      });
      await expect(player(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
      await expect(player(page)).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
      await page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('[data-player-video]');
        if (v) v.currentTime = 5;
      });
      await page.keyboard.press('k');
      await expect(player(page)).toHaveAttribute('data-playing', 'false');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.querySelector<HTMLVideoElement>('[data-player-video]')?.currentTime ?? 0,
          ),
        )
        .toBeGreaterThan(4.9);
      await expect(player(page)).toHaveAttribute('data-controls-visible', 'true');
      await snap('09-player', 300);
      await page.keyboard.press('Escape');
      await expect(viewerRoot(page)).toHaveCount(0);

      // Configuración de la presentación (con tres fotos seleccionadas).
      await cells.nth(2).click();
      await cells.nth(3).click();
      await cells.nth(4).click();
      await selectionBar(page).getByRole('button', { name: 'Presentación' }).click();
      await expect(page.locator('[data-presentation-setup]')).toBeVisible();
      await snap('10-presentation-setup');
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-presentation-setup]')).toBeHidden();
      await page.getByRole('button', { name: 'Cancelar selección' }).click();

      // Vídeo dual: los dos vídeos cargados.
      await openDualFromNav(page);
      await pickVideo(page, 'left', LEFT_NAME);
      await pickVideo(page, 'right', RIGHT_NAME);
      await waitVideosReady(page);
      await expect(controls(page, 'sync')).toBeVisible();
      await snap('11-dual');

      // Diálogo de fusión con el grupo «Resolución de salida» a la vista. La ventana es discreta y
      // puede ser más alta que la pantalla; se alarga para que el diálogo quepa entero.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 1000 });
      });
      await page
        .locator('[data-dual-screen]')
        .getByRole('button', { name: 'Crear vídeo fusionado', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Crear vídeo fusionado' });
      await expect(dialog).toBeVisible();
      const resolution = dialog.getByRole('radiogroup', { name: 'Resolución de salida' });
      await expect(resolution).toBeVisible();
      for (const label of ['Automática (recomendada)', '360 px', '480 px', '720 px', '1080 px']) {
        await expect(
          resolution.getByRole('radio', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }),
        ).toBeVisible();
        await expect(
          resolution.getByRole('radio', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }),
        ).toBeInViewport();
      }
      await snap('12-merge-dialog');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
      });

      // Ajustes → Apariencia (la pestaña por defecto).
      await page.keyboard.press('Control+Comma');
      await expect(page.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeVisible();
      await expect(page.getByRole('radio', { name: c.name })).toBeChecked();
      await snap('13-settings');
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
