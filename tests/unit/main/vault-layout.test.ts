// Layout de la bóveda y removeVaultDir (docs/DESIGN.md §8.5 y §8.5.1): nunca se toca un archivo
// ajeno y nunca se borra nada a través de un enlace simbólico o una junction.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  creatingVaultDir,
  defaultVaultDir,
  objectPath,
  readVaultJson,
  removeVaultDir,
  shardOf,
  thumbPath,
  tmpPartPath,
  vaultPaths,
} from '../../../src/main/vault/vault-layout';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('vault-layout');
afterAll(() => removeTmpDir(tmp));

const newId = (): string => randomBytes(16).toString('hex');

/** Junction en Windows (no necesita privilegios) o enlace simbólico de carpeta en Linux. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function canSymlinkFiles(): boolean {
  const dir = mkdtempSync(join(tmp, 'probe-'));
  writeFileSync(join(dir, 'a'), 'a');
  try {
    symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file');
    return true;
  } catch {
    return false; // Windows sin modo desarrollador ni privilegios: EPERM
  }
}

function writeVaultJson(dir: string, profileId: string): void {
  writeFileSync(
    join(dir, 'vault.json'),
    JSON.stringify({ formatVersion: 1, profileId, createdAt: new Date().toISOString() }),
  );
}

/** Bóveda completa con todas las entradas conocidas de §8.5.1. */
function makeVault(profileId: string, parent = mkdtempSync(join(tmp, 'p-'))): string {
  const dir = join(parent, 'vault');
  mkdirSync(dir);
  writeVaultJson(dir, profileId);
  writeFileSync(join(dir, 'library.db'), randomBytes(64));
  writeFileSync(join(dir, 'library.db-wal'), randomBytes(64));
  writeFileSync(join(dir, 'library.db-shm'), randomBytes(64));
  writeFileSync(join(dir, 'library.db.bak-v0'), randomBytes(64));
  writeFileSync(join(dir, 'vault.json.tmp-0a1b2c3d'), '{}');
  const media = newId();
  mkdirSync(join(dir, 'objects', shardOf(media)), { recursive: true });
  writeFileSync(objectPath(dir, media), randomBytes(200));
  mkdirSync(join(dir, 'thumbs', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'thumbs', 'ab', newId()), randomBytes(50));
  mkdirSync(join(dir, 'tmp'));
  writeFileSync(join(dir, 'tmp', `${newId()}.part`), randomBytes(50));
  mkdirSync(join(dir, 'music'));
  writeFileSync(join(dir, 'music', `${newId()}.mp3`), randomBytes(50));
  return dir;
}

/** Carpeta ajena con un archivo que nunca se debe tocar. */
function foreignDir(): { dir: string; file: string; content: string } {
  const dir = mkdtempSync(join(tmp, 'ajena-'));
  const content = `ajeno-${randomBytes(8).toString('hex')}`;
  const file = join(dir, 'mis-fotos.txt');
  writeFileSync(file, content);
  mkdirSync(join(dir, 'objects'));
  writeFileSync(join(dir, 'objects', 'importante.jpg'), content);
  return { dir, file, content };
}

describe('rutas', () => {
  it('ubicación por defecto, .creating, sharding y subcarpetas', () => {
    const id = newId();
    expect(defaultVaultDir('/datos', id)).toBe(join('/datos', 'vaults', id));
    expect(creatingVaultDir('/datos', id)).toBe(join('/datos', 'vaults', `${id}.creating`));
    expect(shardOf(id)).toBe(id.slice(0, 2));
    expect(objectPath('/v', id)).toBe(join('/v', 'objects', id.slice(0, 2), id));
    expect(thumbPath('/v', id)).toBe(join('/v', 'thumbs', id.slice(0, 2), id));
    expect(tmpPartPath('/v', id)).toBe(join('/v', 'tmp', `${id}.part`));
    expect(vaultPaths('/v')).toMatchObject({
      vaultJson: join('/v', 'vault.json'),
      db: join('/v', 'library.db'),
    });
    expect(() => shardOf('../../x')).toThrow(RangeError);
  });

  it('readVaultJson valida el esquema y no sigue enlaces', async () => {
    const id = newId();
    const dir = mkdtempSync(join(tmp, 'vj-'));
    expect(await readVaultJson(dir)).toBeNull();
    writeVaultJson(dir, id);
    expect((await readVaultJson(dir))?.profileId).toBe(id);
    writeFileSync(join(dir, 'vault.json'), '{"formatVersion":1,"profileId":"x"}');
    expect(await readVaultJson(dir)).toBeNull();
  });
});

describe('removeVaultDir (modo vault)', () => {
  it('borra una bóveda completa con su vault.json correcto', async () => {
    const id = newId();
    const dir = makeVault(id);
    expect(await removeVaultDir(dir, id, 'vault')).toEqual({ removed: true, leftoverPath: null });
    expect(existsSync(dir)).toBe(false);
  });

  it('carpeta sin vault.json: no toca nada', async () => {
    const { dir, file, content } = foreignDir();
    const result = await removeVaultDir(dir, newId(), 'vault');
    expect(result).toEqual({ removed: false, leftoverPath: dir });
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(readFileSync(join(dir, 'objects', 'importante.jpg'), 'utf8')).toBe(content);
  });

  it('carpeta con el vault.json de otro perfil: no toca nada', async () => {
    const { dir, file, content } = foreignDir();
    writeVaultJson(dir, newId());
    writeFileSync(join(dir, 'library.db'), 'otra');
    const result = await removeVaultDir(dir, newId(), 'vault');
    expect(result.removed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(existsSync(join(dir, 'library.db'))).toBe(true);
    expect(existsSync(join(dir, 'vault.json'))).toBe(true);
  });

  it('vault.json correcto más archivos ajenos: borra lo conocido y deja lo ajeno', async () => {
    const id = newId();
    const dir = makeVault(id);
    const foreign = join(dir, 'ajeno.docx');
    writeFileSync(foreign, 'no es de la app');
    mkdirSync(join(dir, 'Mis cosas'));
    writeFileSync(join(dir, 'Mis cosas', 'x.txt'), 'x');
    const result = await removeVaultDir(dir, id, 'vault');
    expect(result).toEqual({ removed: false, leftoverPath: dir });
    expect(readdirSync(dir).sort()).toEqual(['Mis cosas', 'ajeno.docx']);
    expect(readFileSync(foreign, 'utf8')).toBe('no es de la app');
    expect(readFileSync(join(dir, 'Mis cosas', 'x.txt'), 'utf8')).toBe('x');
  });

  it('`dir` como junction/enlace a una bóveda: no se borra nada a través del enlace', async () => {
    const id = newId();
    const real = makeVault(id);
    const link = join(mkdtempSync(join(tmp, 'l-')), 'enlace');
    linkDir(real, link);
    const result = await removeVaultDir(link, id, 'vault');
    expect(result).toEqual({ removed: false, leftoverPath: link });
    expect(existsSync(join(real, 'library.db'))).toBe(true);
    expect(readdirSync(join(real, 'objects'))).toHaveLength(1);
    expect(existsSync(link)).toBe(true);
  });

  it('`objects/` como junction/enlace: no se borra nada a través del enlace', async () => {
    const id = newId();
    const dir = makeVault(id);
    const { dir: outside, file, content } = foreignDir();
    // Sustituye objects/ por un enlace a la carpeta ajena.
    removeTmpDir(join(dir, 'objects'));
    linkDir(outside, join(dir, 'objects'));
    const result = await removeVaultDir(dir, id, 'vault');
    expect(result).toEqual({ removed: false, leftoverPath: dir });
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(readFileSync(join(outside, 'objects', 'importante.jpg'), 'utf8')).toBe(content);
    expect(existsSync(join(dir, 'objects'))).toBe(true); // el enlace se deja
    expect(existsSync(join(dir, 'library.db'))).toBe(false);
    expect(existsSync(join(dir, 'vault.json'))).toBe(true); // queda mientras quede algo conocido
  });

  it('una junction/enlace dentro de objects/: fs.rm no la sigue', async () => {
    const id = newId();
    const dir = makeVault(id);
    const { dir: outside, file, content } = foreignDir();
    linkDir(outside, join(dir, 'objects', 'zz'));
    expect(await removeVaultDir(dir, id, 'vault')).toEqual({ removed: true, leftoverPath: null });
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it.skipIf(!canSymlinkFiles())(
    'library.db como enlace simbólico de archivo: el destino no se toca',
    async () => {
      const id = newId();
      const dir = makeVault(id);
      const { file, content } = foreignDir();
      removeTmpDir(join(dir, 'library.db'));
      symlinkSync(file, join(dir, 'library.db'), 'file');
      const result = await removeVaultDir(dir, id, 'vault');
      expect(result.removed).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(content);
    },
  );

  it('nunca borra la bóveda actual del perfil', async () => {
    const id = newId();
    const dir = makeVault(id);
    const result = await removeVaultDir(dir, id, 'vault', { currentVaultDir: dir });
    expect(result).toEqual({ removed: false, leftoverPath: dir });
    expect(existsSync(join(dir, 'library.db'))).toBe(true);
  });

  it('carpeta inexistente: borrada si existe la carpeta padre; si no (disco ausente), leftover', async () => {
    const parent = mkdtempSync(join(tmp, 'm-'));
    expect(await removeVaultDir(join(parent, 'no-existe'), newId())).toEqual({
      removed: true,
      leftoverPath: null,
    });
    const absent = join(parent, 'disco', 'Galeria-1234');
    expect(await removeVaultDir(absent, newId())).toEqual({ removed: false, leftoverPath: absent });
  });

  it('un archivo en lugar de una carpeta: no se borra', async () => {
    const file = join(mkdtempSync(join(tmp, 'f-')), 'vault');
    writeFileSync(file, 'x');
    expect((await removeVaultDir(file, newId())).removed).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

describe('removeVaultDir (modo creating)', () => {
  it('sin vault.json: solo subcarpetas vacías y vault.json.tmp-*', async () => {
    const dir = join(mkdtempSync(join(tmp, 'c-')), `${newId()}.creating`);
    mkdirSync(join(dir, 'objects'), { recursive: true });
    mkdirSync(join(dir, 'tmp'));
    writeFileSync(join(dir, 'vault.json.tmp-deadbeef'), '{}');
    expect(await removeVaultDir(dir, newId(), 'creating')).toEqual({
      removed: true,
      leftoverPath: null,
    });
    expect(existsSync(dir)).toBe(false);
  });

  it('sin vault.json y con contenido: no borra nada que no esté vacío', async () => {
    const dir = join(mkdtempSync(join(tmp, 'c-')), `${newId()}.creating`);
    mkdirSync(join(dir, 'objects', 'aa'), { recursive: true });
    writeFileSync(join(dir, 'objects', 'aa', 'x'), 'x');
    writeFileSync(join(dir, 'library.db'), 'x');
    const result = await removeVaultDir(dir, newId(), 'creating');
    expect(result).toEqual({ removed: false, leftoverPath: dir });
    expect(existsSync(join(dir, 'objects', 'aa', 'x'))).toBe(true);
    expect(existsSync(join(dir, 'library.db'))).toBe(true);
  });

  it('con vault.json del perfil: borra como una bóveda', async () => {
    const id = newId();
    const dir = makeVault(id);
    expect((await removeVaultDir(dir, id, 'creating')).removed).toBe(true);
  });
});

describe('removeVaultDir (modo relocate-partial)', () => {
  it('exige el marcador del trabajo', async () => {
    const id = newId();
    const job = newId();
    const dir = makeVault(id);
    expect(
      (await removeVaultDir(dir, id, 'relocate-partial', { relocateJobId: job })).removed,
    ).toBe(false);
    writeFileSync(join(dir, `.galeria-relocate-${job}`), '');
    expect(await removeVaultDir(dir, id, 'relocate-partial', { relocateJobId: job })).toEqual({
      removed: true,
      leftoverPath: null,
    });
  });

  it('con el marcador pero el vault.json de otro perfil: no toca nada', async () => {
    const id = newId();
    const job = newId();
    const dir = makeVault(newId());
    writeFileSync(join(dir, `.galeria-relocate-${job}`), '');
    expect(
      (await removeVaultDir(dir, id, 'relocate-partial', { relocateJobId: job })).removed,
    ).toBe(false);
    expect(existsSync(join(dir, 'library.db'))).toBe(true);
  });
});
