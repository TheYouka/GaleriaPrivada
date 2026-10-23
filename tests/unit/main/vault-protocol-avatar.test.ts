// vault:// primera versión (docs/DESIGN.md §11): avatares sin desbloqueo, cabeceras de §11.3 y
// errores con X-Galeria-Error (§11.4).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { avatarFilePath } from '../../../src/main/profiles/avatars';
import {
  handleVaultRequest,
  type VaultProtocolDeps,
} from '../../../src/main/protocol/vault-protocol';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('vault-protocol');
afterAll(() => removeTmpDir(tmp));

const ORIGIN = 'app://bundle';
const root = mkdtempSync(join(tmp, 'r-'));
mkdirSync(join(root, 'avatars'));
const profileId = randomBytes(16).toString('hex');
const avatar = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 avatar', 'latin1');
writeFileSync(avatarFilePath(root, profileId), avatar);
const token = randomBytes(32).toString('base64url');
const pending = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 pendiente', 'latin1');

function deps(unlocked = false): VaultProtocolDeps {
  return {
    avatarFile: (id) => avatarFilePath(root, id),
    pendingAvatar: (t) => (t === token ? pending : null),
    rendererOrigin: () => ORIGIN,
    isUnlocked: () => unlocked,
  };
}

function request(url: string, method = 'GET'): Request {
  return new Request(url, { method });
}

async function expectError(res: Response, status: number, code: string | null): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get('x-galeria-error')).toBe(code);
  expect((await res.arrayBuffer()).byteLength).toBe(0);
}

describe('vault://avatar', () => {
  it('sirve avatars/<id>.webp sin desbloqueo, con las cabeceras de §11.3', async () => {
    const res = await handleVaultRequest(request(`vault://avatar/${profileId}?rev=3`), deps());
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(avatar);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('content-length')).toBe(String(avatar.length));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-expose-headers')).toContain('Content-Length');
  });

  it('HEAD: las mismas cabeceras y sin cuerpo', async () => {
    const res = await handleVaultRequest(request(`vault://avatar/${profileId}`, 'HEAD'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(avatar.length));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('avatar inexistente → 404 NOT_FOUND', async () => {
    const res = await handleVaultRequest(
      request(`vault://avatar/${randomBytes(16).toString('hex')}?rev=1`),
      deps(),
    );
    await expectError(res, 404, 'NOT_FOUND');
  });

  it('vault://avatar/pending/<token>: el WebP en memoria; token desconocido → 404', async () => {
    const ok = await handleVaultRequest(request(`vault://avatar/pending/${token}`), deps());
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(pending);
    const other = randomBytes(32).toString('base64url');
    await expectError(
      await handleVaultRequest(request(`vault://avatar/pending/${other}`), deps()),
      404,
      'NOT_FOUND',
    );
    await expectError(
      await handleVaultRequest(request('vault://avatar/pending/corto'), deps()),
      400,
      'VALIDATION',
    );
  });

  it('URL mal formada → 400 VALIDATION; método distinto de GET/HEAD → 405', async () => {
    for (const url of [
      'vault://avatar/no-es-un-id',
      `vault://avatar/${profileId}/extra`,
      `vault://avatar/${profileId}?rev=abc`,
      `vault://avatar/..%2F..%2Fprofiles.json`,
      `vault://otro/${profileId}`,
    ]) {
      await expectError(await handleVaultRequest(request(url), deps()), 400, 'VALIDATION');
    }
    await expectError(
      await handleVaultRequest(request(`vault://avatar/${profileId}`, 'POST'), deps()),
      405,
      null,
    );
    // Claves de query distintas de rev se ignoran.
    expect(
      (await handleVaultRequest(request(`vault://avatar/${profileId}?x=1`), deps())).status,
    ).toBe(200);
  });

  it('media/thumb/music (F2/F4): 423 LOCKED con la sesión bloqueada, 404 con ella abierta', async () => {
    const mediaId = randomBytes(16).toString('hex');
    for (const host of ['media', 'thumb', 'music']) {
      await expectError(
        await handleVaultRequest(request(`vault://${host}/${mediaId}`), deps(false)),
        423,
        'LOCKED',
      );
      await expectError(
        await handleVaultRequest(request(`vault://${host}/${mediaId}`), deps(true)),
        404,
        'NOT_FOUND',
      );
    }
  });
});
