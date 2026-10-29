// Verificación visual del vídeo dual y la fusión (docs/PLAN.md 5.4): capturas en los dos temas, en
// tests/.tmp/screenshots/fase-5/, con el nombre `<pantalla>-<tema>.png` (`fotos` = «Clásico» y `ps3`
// = «Ondas»): dual-empty (los dos huecos «Elegir vídeo…»), dual-picker (el selector), dual-sync (dos
// vídeos con controles sincronizados), dual-independent (una barra por lado, con posiciones
// distintas), merge-dialog (las opciones), merge-progress (la fusión en curso con «Cancelar fusión») y
// merge-done (el resultado). Se revisan a mano; no se comparan con referencias (eso es la Fase 6).
// Ventana discreta (nota 135) y vídeos sintéticos cortos y de baja resolución bajo tests/.tmp/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { choosePickerTheme, createProfile, launchApp, ROOT, unlockProfile } from './helpers/launch';
import {
  controls,
  dualScreen,
  importDualFixtures,
  LEFT_NAME,
  openDualFromNav,
  pickVideo,
  RIGHT_NAME,
  snapVideos,
  waitVideosReady,
} from './helpers/dual';
import { newSourceDir, PASSWORD, PROFILE, removeDir } from './helpers/library';

const OUT = join(ROOT, 'tests', '.tmp', 'screenshots', 'fase-5');

/** Cierra los avisos que dejó la preparación. */
async function dismissToasts(page: Page): Promise<void> {
  const close = page
    .getByRole('region', { name: /^Notificaciones/ })
    .getByRole('button', { name: 'Cerrar' });
  for (let i = 0; i < 6 && (await close.count()) > 0; i += 1) {
    await close.first().click();
    await page.waitForTimeout(150);
  }
  await expect(close).toHaveCount(0);
  await page.mouse.move(5, 5);
}

async function snap(page: Page, name: string): Promise<void> {
  await dismissToasts(page);
  // Las animaciones de entrada y el fundido del tema ya han terminado.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, name) });
}

for (const [theme, displayName] of [
  ['fotos', 'Clásico'],
  ['ps3', 'Ondas'],
] as const) {
  test(`capturas del vídeo dual y la fusión en el tema ${displayName}`, async () => {
    test.setTimeout(420_000);
    mkdirSync(OUT, { recursive: true });
    const launched = await launchApp();
    const src = newSourceDir();
    try {
      const { page, app } = launched;
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 800 });
      });
      await createProfile(page, PROFILE, PASSWORD);
      await choosePickerTheme(page, displayName);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await unlockProfile(page, PROFILE, PASSWORD);
      await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
      await importDualFixtures(page, app, src);

      // Los dos huecos «Elegir vídeo…».
      await openDualFromNav(page);
      await expect(page.locator('[data-dual-empty]')).toHaveCount(2);
      await snap(page, `dual-empty-${theme}.png`);

      // El selector «Elegir vídeo…».
      await page
        .locator('[data-dual-side="left"]')
        .getByRole('button', { name: 'Elegir vídeo…' })
        .click();
      const picker = page.getByRole('dialog', { name: 'Elegir vídeo' });
      await expect(picker.locator('[data-picker-item]')).toHaveCount(2);
      await expect
        .poll(() =>
          picker.evaluate((root) => {
            const imgs = Array.from(root.querySelectorAll('img'));
            return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
          }),
        )
        .toBe(true);
      await snap(page, `dual-picker-${theme}.png`);
      await picker.getByRole('button', { name: new RegExp(`^${LEFT_NAME}`) }).click();
      await expect(picker).toBeHidden();
      await pickVideo(page, 'right', RIGHT_NAME);
      await waitVideosReady(page);

      // Sincronizado: dos vídeos, reproducidos un momento y pausados hacia los 5 s.
      const bar = controls(page, 'sync');
      await bar.getByRole('button', { name: 'Reproducir (K)' }).click();
      await expect
        .poll(async () => (await snapVideos(page)).left?.t, { timeout: 60_000 })
        .toBeGreaterThan(2);
      await bar.getByRole('button', { name: 'Pausar (K)' }).click();
      await expect(bar).toHaveAttribute('data-playing', 'false');
      await page.mouse.move(5, 5);
      await snap(page, `dual-sync-${theme}.png`);

      // Diálogo de fusión con las opciones (duración «La del más largo» para que el progreso se vea).
      await dualScreen(page)
        .getByRole('button', { name: 'Crear vídeo fusionado', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Crear vídeo fusionado' });
      await expect(dialog.getByRole('radio', { name: 'Mezcla' })).toBeChecked();
      await expect(dialog.locator('[data-merge-size]')).toBeVisible();
      await snap(page, `merge-dialog-${theme}.png`);

      // Progreso de la fusión (el más largo: unos segundos).
      await dialog.getByRole('radio', { name: 'La del más largo' }).click();
      await dialog.getByLabel('Nombre').fill('Fusión de las capturas');
      await dialog.getByRole('button', { name: 'Crear vídeo fusionado' }).click();
      const progress = dialog.getByRole('progressbar');
      await expect(progress).toBeVisible();
      await expect
        .poll(async () => Number((await progress.getAttribute('aria-valuenow')) ?? 0), {
          timeout: 120_000,
          intervals: [50],
        })
        .toBeGreaterThan(5);
      await page.mouse.move(5, 5);
      // Sin esperas (la fusión dura unos segundos): solo la captura.
      await page.screenshot({ path: join(OUT, `merge-progress-${theme}.png`) });
      await expect(dialog.locator('[data-merge-result]')).toHaveText('Vídeo fusionado creado', {
        timeout: 180_000,
      });
      await snap(page, `merge-done-${theme}.png`);
      await dialog.getByRole('button', { name: 'Cerrar' }).click();
      await expect(dialog).toBeHidden();

      // Independiente: una barra por lado y posiciones distintas.
      await page.getByRole('switch', { name: 'Controles sincronizados' }).click();
      await expect(dualScreen(page)).toHaveAttribute('data-dual-mode', 'independent');
      const left = controls(page, 'left');
      const right = controls(page, 'right');
      await left.getByRole('button', { name: 'Avanzar 10 s izquierdo (L)' }).click();
      await right.getByRole('button', { name: 'Reproducir derecho (K)' }).click();
      await expect
        .poll(async () => (await snapVideos(page)).right?.t, { timeout: 60_000 })
        .toBeGreaterThan(1);
      await right.getByRole('button', { name: 'Pausar derecho (K)' }).click();
      await expect(right).toHaveAttribute('data-playing', 'false');
      await right.getByRole('button', { name: /^Velocidad derecho: / }).click();
      await page.getByRole('menuitemradio', { name: '1,5×', exact: true }).click();
      await page.mouse.move(5, 5);
      await snap(page, `dual-independent-${theme}.png`);
    } finally {
      removeDir(src);
      await launched.close();
    }
  });
}
