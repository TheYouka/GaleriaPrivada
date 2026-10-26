// linux-thumbnails.ts (docs/DESIGN.md §12.9). Los vectores de GLib (g_filename_to_uri) se generan en
// el PC Linux del usuario y se fijan en 7.4 (anexo §5): en F2 son it.todo.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupThumbnails,
  fileUri,
  thumbnailBases,
  thumbnailName,
  THUMBNAIL_SIZES,
} from '../../../src/main/import/linux-thumbnails';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('linux-thumbnails');
afterAll(() => removeTmpDir(tmp));

describe('URI y MD5', () => {
  it('vector del spec: file:///home/jens/photos/me.png → c6ee772d9e49320e97ec29a7eb5b1697', () => {
    const uri = fileUri('/home/jens/photos/me.png');
    expect(uri).toBe('file:///home/jens/photos/me.png');
    expect(thumbnailName(uri)).toBe('c6ee772d9e49320e97ec29a7eb5b1697.png');
  });

  it('regla de §12.9: escapa espacio, " # % ; < > ? [ \\ ] ^ ` { | } DEL y bytes ≥ 0x80, en mayúsculas', () => {
    expect(fileUri('/a b"#%;<>?[\\]^`{|}\x7f')).toBe(
      'file:///a%20b%22%23%25%3B%3C%3E%3F%5B%5C%5D%5E%60%7B%7C%7D%7F',
    );
    expect(fileUri('/fotos/á.jpg')).toBe('file:///fotos/%C3%A1.jpg');
    expect(fileUri("/x/-._~!$&'()*+,=:@")).toBe("file:///x/-._~!$&'()*+,=:@");
  });

  // Vectores de GLib para nombres con ; # ? % [ ] & = + , ' ! $ ~ @, espacio y á (7.4).
  it.todo('GLib: nombre con ";"');
  it.todo('GLib: nombre con "#"');
  it.todo('GLib: nombre con "?"');
  it.todo('GLib: nombre con "%"');
  it.todo('GLib: nombre con "[" y "]"');
  it.todo('GLib: nombre con "&", "=", "+" y ","');
  it.todo('GLib: nombre con "\'", "!", "$", "~" y "@"');
  it.todo('GLib: nombre con un espacio');
  it.todo('GLib: nombre con "á"');
});

describe('cleanupThumbnails', () => {
  const home = join(tmp, 'home');
  const cache = join(tmp, 'xdg-cache');
  const original = '/home/ana/Fotos/playa 1.jpg';
  const name = thumbnailName(fileUri(original));
  const other = thumbnailName(fileUri('/home/ana/Fotos/otra.jpg'));

  function seed(): string[] {
    const files: string[] = [];
    for (const base of thumbnailBases({ home, xdgCacheHome: cache })) {
      for (const size of THUMBNAIL_SIZES) {
        mkdirSync(join(base, size), { recursive: true });
        files.push(join(base, size, name));
        writeFileSync(join(base, size, other), 'otra');
      }
      for (const app of ['gnome-thumbnail-factory', 'otra-app']) {
        mkdirSync(join(base, 'fail', app), { recursive: true });
        files.push(join(base, 'fail', app, name));
      }
    }
    for (const f of files) writeFileSync(f, 'png en claro');
    return files;
  }

  it('las dos bases: ${XDG_CACHE_HOME:-~/.cache}/thumbnails y ~/.thumbnails', () => {
    expect(thumbnailBases({ home, xdgCacheHome: cache })).toEqual([
      join(cache, 'thumbnails'),
      join(home, '.thumbnails'),
    ]);
    expect(thumbnailBases({ home, xdgCacheHome: 'relativa' })[0]).toBe(
      join(home, '.cache', 'thumbnails'),
    );
  });

  it('borra normal/large/x-large/xx-large y fail/* de las dos bases; nada más', async () => {
    const files = seed();
    const removed = await cleanupThumbnails(original, {
      platform: 'linux',
      home,
      xdgCacheHome: cache,
    });
    expect(removed).toBe(files.length);
    for (const f of files) expect(existsSync(f)).toBe(false);
    for (const base of thumbnailBases({ home, xdgCacheHome: cache })) {
      for (const size of THUMBNAIL_SIZES) expect(existsSync(join(base, size, other))).toBe(true);
    }
  });

  it('fuera de Linux no hace nada; sin carpetas no falla', async () => {
    const files = seed();
    expect(
      await cleanupThumbnails(original, { platform: 'win32', home, xdgCacheHome: cache }),
    ).toBe(0);
    for (const f of files) expect(existsSync(f)).toBe(true);
    expect(await cleanupThumbnails(original, { platform: 'linux', home: join(tmp, 'vacio') })).toBe(
      0,
    );
  });
});
