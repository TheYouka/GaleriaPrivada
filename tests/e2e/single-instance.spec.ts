// Instancia única (docs/DESIGN.md §5.2, pasos 3–4, y §22 "Un solo escritor"): con raíces de datos
// distintas arrancan las dos; con la misma, la segunda sale con código 0 en menos de 5 s y la primera
// recibe `second-instance`.
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { appEnv, electronExecutable, launchApp, ROOT } from './helpers/launch';

test('dos instancias con distinto GALERIA_DATA_DIR arrancan las dos', async () => {
  const a = await launchApp();
  const b = await launchApp();
  try {
    expect(a.dataDir).not.toBe(b.dataDir);
    await expect(a.page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
    await expect(b.page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  } finally {
    await b.close();
    await a.close();
  }
});

test('con el mismo GALERIA_DATA_DIR la segunda sale con código 0 y la primera recibe second-instance', async () => {
  const first = await launchApp();
  try {
    await expect(first.page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
    await first.app.evaluate(({ app }) => {
      const g = globalThis as { __e2eSecondInstance?: number };
      g.__e2eSecondInstance = 0;
      app.on('second-instance', () => {
        g.__e2eSecondInstance = (g.__e2eSecondInstance ?? 0) + 1;
      });
    });

    const started = Date.now();
    const second = spawn(electronExecutable(), ['.'], {
      cwd: ROOT,
      env: appEnv(first.dataDir),
      stdio: 'ignore',
      windowsHide: true,
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error('la segunda instancia no salió en 5 s'));
      }, 5000);
      second.once('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      second.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const elapsed = Date.now() - started;
    console.log(`[e2e] segunda instancia: código ${code} en ${elapsed} ms`);
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(5000);
    await expect
      .poll(() =>
        first.app.evaluate(
          () => (globalThis as { __e2eSecondInstance?: number }).__e2eSecondInstance ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(1);
    // La primera sigue funcionando.
    await expect(first.page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  } finally {
    await first.close();
  }
});
