// Recorrido funcional solo con teclado, repetido en los 5 temas (docs/PLAN.md 6.5; docs/DESIGN.md
// §22: «los temas no bifurcan funcionalidad»): crear perfil, desbloquear, importar, buscar, seleccionar,
// abrir el visor, lanzar una presentación y bloquear. Ni un clic del ratón: solo `page.keyboard`, y el
// orden de Tab se recorre hasta llegar al control (cambia de un shell a otro). El tema global se
// guarda de antemano en settings.json de la raíz de datos de la prueba (la elección en vivo la cubren
// themes-basic.spec.ts y themes-structural.spec.ts), de modo que desde la pantalla de bienvenida
// hasta el bloqueo todo ocurre dentro del tema. Ventana discreta (nota 135), pantalla completa
// simulada y datos solo bajo tests/.tmp/.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, lockAndGetNewWindow, newDataDir, type LaunchedApp } from './helpers/launch';
import { tabTo, typeInto } from './helpers/keyboard';
import {
  expectItemCount,
  gridCells,
  importPanel,
  mockOpenDialog,
  newSourceDir,
  PASSWORD,
  PROFILE,
  removeDir,
  waitForSummary,
  writePhoto,
} from './helpers/library';
import { installFullscreenDouble, presentation, setupDialog } from './helpers/presentation';
import { selectionBar } from './helpers/playlists';

const THEMES = [
  { id: 'fotos', name: 'Clásico', picker: 'fluent' },
  { id: 'xbox', name: 'Mosaico', picker: 'tiles' },
  { id: 'ps3', name: 'Ondas', picker: 'xmb-row' },
  { id: 'macos', name: 'Cristal', picker: 'login' },
  { id: 'cine', name: 'Cine', picker: 'showcase' },
] as const;

const PHOTO_COUNT = 6;
const heading = (page: Page, name: string): Locator =>
  page.getByRole('heading', { level: 1, name });

for (const t of THEMES) {
  test(`${t.name} (${t.id}): recorrido completo solo con teclado`, async () => {
    test.setTimeout(300_000);
    const dataDir = newDataDir();
    // Tema global de partida (settings.json válido para el esquema de main).
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({ formatVersion: 1, pickerThemeId: t.id, colorScheme: 'dark' }),
      'utf8',
    );
    const launched: LaunchedApp = await launchApp({ dataDir });
    const src = newSourceDir();
    try {
      let { page } = launched;
      const { app } = launched;
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
      });
      await expect(page.locator('html')).toHaveAttribute('data-theme', t.id);

      // 1. Crear perfil (bienvenida → formulario → selector), solo con Tab, texto, Espacio e Intro.
      const welcome = page.getByRole('button', { name: 'Crear perfil', exact: true });
      await tabTo(page, welcome);
      await page.keyboard.press('Enter');
      await expect(heading(page, 'Crear perfil')).toBeVisible();
      await typeInto(page, page.getByLabel('Nombre', { exact: true }), PROFILE);
      await typeInto(page, page.getByLabel('Contraseña', { exact: true }), PASSWORD);
      await typeInto(page, page.getByLabel('Repetir contraseña', { exact: true }), PASSWORD);
      const acknowledge = page.getByRole('checkbox', {
        name: 'Entiendo que si olvido la contraseña perderé el acceso para siempre',
      });
      await tabTo(page, acknowledge);
      await page.keyboard.press('Space');
      await expect(acknowledge).toBeChecked();
      const submit = page.getByRole('button', { name: 'Crear perfil', exact: true });
      await expect(submit).toBeEnabled();
      await tabTo(page, submit);
      await page.keyboard.press('Enter');
      await expect(heading(page, '¿Quién eres?')).toBeVisible({ timeout: 20_000 });
      const avatar = page.getByRole('button', { name: PROFILE, exact: true });
      await expect(avatar).toBeFocused();
      await expect(page.locator('[data-picker]')).toHaveAttribute('data-picker', t.picker);

      // 2. Desbloquear: Intro en el avatar, la contraseña ya tiene el foco, Intro.
      await page.keyboard.press('Enter');
      const form = page
        .getByRole('dialog', { name: PROFILE })
        .or(page.getByRole('group', { name: `Contraseña de ${PROFILE}` }));
      await expect(form).toBeVisible();
      await expect(form.getByLabel('Contraseña', { exact: true })).toBeFocused();
      await page.keyboard.type(PASSWORD);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(heading(page, 'Galería')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', t.id);
      await installFullscreenDouble(app);

      // 3. Importar con Ctrl+I (diálogo nativo simulado) y cerrar el resumen con el teclado.
      const paths: string[] = [];
      for (let i = 0; i < PHOTO_COUNT; i += 1) {
        const path = join(src, `Foto ${String(i + 1).padStart(2, '0')}.jpg`);
        await writePhoto(path, i + 3, { mtime: new Date(2025, 2, 10 + i, 12) });
        paths.push(path);
      }
      await mockOpenDialog(app, paths);
      await page.keyboard.press('Control+i');
      const counts = await waitForSummary(page, 120_000);
      expect(counts.imported).toBe(PHOTO_COUNT);
      await tabTo(page, importPanel(page).getByRole('button', { name: 'Cerrar' }));
      await page.keyboard.press('Enter');
      await expect(importPanel(page)).toBeHidden();
      await expectItemCount(page, PHOTO_COUNT);

      // 4. Buscar: Ctrl+F lleva el foco al campo; Esc lo limpia.
      await page.keyboard.press('Control+f');
      const search = page.getByRole('searchbox', { name: 'Buscar' });
      await expect(search).toBeFocused();
      await page.keyboard.type('Foto 02');
      await expectItemCount(page, 1);
      await expect(gridCells(page)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(search).toHaveValue('');
      await expectItemCount(page, PHOTO_COUNT);

      // 5. Seleccionar: Tab hasta la rejilla, Espacio, → y Espacio.
      const tabStop = page.locator('[data-gallery-grid] [role="gridcell"][tabindex="0"]');
      await tabTo(page, tabStop);
      await page.keyboard.press('Space');
      await expect(page.getByText('1 seleccionado', { exact: true })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await expect(page.getByText('2 seleccionados', { exact: true })).toBeVisible();
      await expect(selectionBar(page)).toBeVisible();

      // 6. Visor: Intro abre el elemento con el foco, → pasa al siguiente y Esc vuelve a la galería.
      await page.keyboard.press('Enter');
      const viewer = page.locator('[data-viewer]');
      await expect(viewer).toHaveAttribute('data-viewer-state', 'open', { timeout: 15_000 });
      const viewerImage = page.locator('[data-edited-image="viewer"] img');
      await expect(viewerImage).toBeVisible();
      const firstSrc = await viewerImage.getAttribute('src');
      await page.keyboard.press('ArrowRight');
      // Durante el cambio conviven las dos imágenes; al terminar queda solo la siguiente.
      await expect
        .poll(
          async () => {
            const srcs = await viewerImage.evaluateAll((els) =>
              els.map((el) => el.getAttribute('src')),
            );
            return srcs.length === 1 && srcs[0] !== firstSrc;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);
      // La selección sigue intacta tras abrir y cerrar con el teclado.
      await expect(page.getByText('2 seleccionados', { exact: true })).toBeVisible();

      // 7. Presentación: «Presentación» de la barra de selección → «Iniciar presentación» → Esc.
      const startButton = selectionBar(page).getByRole('button', { name: 'Presentación' });
      await expect(startButton).toBeEnabled();
      await tabTo(page, startButton);
      await page.keyboard.press('Enter');
      await expect(setupDialog(page)).toBeVisible();
      await tabTo(page, setupDialog(page).getByRole('button', { name: 'Iniciar presentación' }));
      await page.keyboard.press('Enter');
      await expect(presentation(page)).toBeVisible();
      await expect(setupDialog(page)).toBeHidden();
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await expect(presentation(page)).toHaveCount(0);

      // 8. Bloquear con Ctrl+L: ventana nueva con el selector en el mismo tema.
      page = await lockAndGetNewWindow(app, () => page.keyboard.press('Control+L'));
      await expect(page.locator('html')).toHaveAttribute('data-theme', t.id);
      await expect(page.locator('[data-picker]')).toHaveAttribute('data-picker', t.picker);
      await expect(page.getByRole('button', { name: PROFILE, exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0);
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
