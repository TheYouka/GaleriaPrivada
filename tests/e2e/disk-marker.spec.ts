// Nada de la bóveda en claro en el disco (docs/DESIGN.md §22, "Nada descifrado se escribe en disco"),
// con el enfoque del marcador de §22: un marcador aleatorio de 32 bytes se guarda en el estado cifrado
// de la bóveda (la tabla `kv` de SQLCipher, mediante el gancho de E2E que solo escribe) y, después de
// bloquear y cerrar la app, ningún archivo bajo la raíz de datos de prueba (ni el userData de
// Electron) lo contiene, ni en UTF-8 ni en UTF-16LE. La contraseña tampoco aparece. No se buscan
// firmas cortas, que salen por azar en el ciphertext.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createProfile,
  launchApp,
  lockAndGetNewWindow,
  readProfilesJson,
  unlockProfile,
} from './helpers/launch';

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('el marcador guardado en la bóveda y la contraseña no aparecen en ningún archivo', async () => {
  const marker = randomBytes(32).toString('hex');
  const ids = [marker.slice(0, 32), marker.slice(32)];
  const password = `pw-${randomBytes(12).toString('hex')}`;
  const name = `Marcador${randomBytes(4).toString('hex')}`;

  const launched = await launchApp();
  try {
    let page = launched.page;
    await createProfile(page, name, password);
    await unlockProfile(page, name, password);

    // Escribe el marcador en el estado cifrado de la sesión abierta.
    await launched.app.evaluate((_electron, values) => {
      (
        globalThis as unknown as { __galeriaTestWriteMarker(ids: string[]): void }
      ).__galeriaTestWriteMarker(values);
    }, ids);

    page = await lockAndGetNewWindow(launched.app, () => page.keyboard.press('Control+L'));
    // Bloqueada, el gancho ya no llega a la DB (getDb → LOCKED): prueba que pasa por la sesión.
    const lockedError = await launched.app.evaluate((_electron, values) => {
      try {
        (
          globalThis as unknown as { __galeriaTestWriteMarker(ids: string[]): void }
        ).__galeriaTestWriteMarker(values);
        return null;
      } catch (err) {
        return (err as { error?: { code?: string } }).error?.code ?? 'other';
      }
    }, ids);
    expect(lockedError).toBe('LOCKED');

    await launched.quit();

    const id = readProfilesJson(launched.dataDir).profiles.find((p) => p.name === name)?.id ?? '';
    expect(existsSync(join(launched.dataDir, 'vaults', id, 'library.db'))).toBe(true);

    const needles: { label: string; bytes: Buffer }[] = [];
    for (const [label, text] of [
      ['marcador', marker],
      ['marcador[0:32]', ids[0] as string],
      ['marcador[32:64]', ids[1] as string],
      ['contraseña', password],
    ] as const) {
      needles.push({ label: `${label} utf8`, bytes: Buffer.from(text, 'utf8') });
      needles.push({ label: `${label} utf16le`, bytes: Buffer.from(text, 'utf16le') });
    }

    const roots = [launched.dataDir, `${launched.dataDir}.electron`];
    const files = roots.flatMap(filesUnder);
    const hits: string[] = [];
    let scanned = 0;
    let nameFound = false;
    for (const file of files) {
      const data = readFileSync(file);
      scanned += 1;
      // Control positivo: el nombre del perfil sí está en claro en profiles.json (por diseño).
      if (data.includes(Buffer.from(name, 'utf8'))) nameFound = true;
      for (const n of needles) {
        if (data.includes(n.bytes)) hits.push(`${n.label} en ${relative(launched.dataDir, file)}`);
      }
    }
    console.log(`[e2e] archivos analizados: ${scanned}`);
    expect(scanned).toBeGreaterThan(5);
    expect(nameFound).toBe(true);
    expect(hits).toEqual([]);
  } finally {
    launched.cleanup();
  }
});
