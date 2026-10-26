// linux-recent.ts (docs/DESIGN.md §12.9.1): recently-used.xbel pierde solo los <bookmark> de los
// originales borrados y conserva el resto byte a byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileUri } from '../../../src/main/import/linux-thumbnails';
import {
  recentFilePath,
  removeRecentEntries,
  stripBookmarks,
} from '../../../src/main/import/linux-recent';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('linux-recent');
afterAll(() => removeTmpDir(tmp));

const uriA = fileUri('/home/ana/Fotos/playa & sol.jpg');
const uriB = fileUri('/home/ana/Fotos/b.mp4');
const uriKeep = fileUri('/home/ana/Documentos/informe.odt');

const xmlAttr = (s: string): string => s.replaceAll('&', '&amp;');

function bookmark(uri: string, app = 'org.gnome.Nautilus'): string {
  return `  <bookmark href="${xmlAttr(uri)}" added="2026-10-01T10:00:00.000000Z" modified="2026-10-01T10:00:00.000000Z" visited="2026-10-01T10:00:00.000000Z">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="image/jpeg"/>
        <bookmark:applications>
          <bookmark:application name="${app}" exec="&apos;nautilus %u&apos;" modified="2026-10-01T10:00:00.000000Z" count="1"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>
`;
}

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info"
>
`;
const TAIL = '</xbel>\n';

function setup(name: string, content: string): { home: string; path: string } {
  const home = join(tmp, name);
  const path = recentFilePath({ home, xdgDataHome: join(home, 'datos') });
  mkdirSync(join(home, 'datos'), { recursive: true });
  writeFileSync(path, content);
  return { home, path };
}

describe('stripBookmarks', () => {
  it('decodifica las entidades de href y quita solo los elementos pedidos', () => {
    const xml = HEAD + bookmark(uriA) + bookmark(uriKeep) + TAIL;
    const { text, removed } = stripBookmarks(xml, new Set([uriA]));
    expect(removed).toBe(1);
    expect(text).toBe(HEAD + bookmark(uriKeep) + TAIL);
  });
});

describe('removeRecentEntries', () => {
  it('pierde solo los <bookmark> borrados y conserva el resto byte a byte (con á)', async () => {
    const keep1 = bookmark(uriKeep);
    const keep2 = bookmark(fileUri('/home/ana/Música/canción.ogg'), 'org.gnome.Rhythmbox3');
    const original = HEAD + bookmark(uriA) + keep1 + bookmark(uriB) + keep2 + TAIL;
    const { home, path } = setup('normal', original);
    const removed = await removeRecentEntries([uriA, uriB, fileUri('/no/esta.jpg')], {
      platform: 'linux',
      home,
      xdgDataHome: join(home, 'datos'),
    });
    expect(removed).toBe(2);
    expect(readFileSync(path).equals(Buffer.from(HEAD + keep1 + keep2 + TAIL, 'utf8'))).toBe(true);
    // Sin temporales sueltos.
    expect(readdirSync(join(home, 'datos'))).toEqual(['recently-used.xbel']);
  });

  it('sin coincidencias no escribe; tampoco fuera de Linux', async () => {
    const original = HEAD + bookmark(uriKeep) + TAIL;
    const { home, path } = setup('sin-cambios', original);
    const opts = { home, xdgDataHome: join(home, 'datos') };
    expect(await removeRecentEntries([uriA], { ...opts, platform: 'linux' })).toBe(0);
    expect(await removeRecentEntries([uriKeep], { ...opts, platform: 'win32' })).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('forma inesperada (sin <?xml, sin <xbel o UTF-8 inválido) → no se toca', async () => {
    const opts = (home: string): Parameters<typeof removeRecentEntries>[1] => ({
      platform: 'linux',
      home,
      xdgDataHome: join(home, 'datos'),
    });
    const noXml = setup('sin-xml', bookmark(uriA));
    expect(await removeRecentEntries([uriA], opts(noXml.home))).toBe(0);
    const noXbel = setup('sin-xbel', `<?xml version="1.0"?>\n<otro>${bookmark(uriA)}</otro>`);
    expect(await removeRecentEntries([uriA], opts(noXbel.home))).toBe(0);
    const bad = Buffer.concat([
      Buffer.from(HEAD + bookmark(uriA), 'utf8'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(TAIL),
    ]);
    const invalid = setup('utf8-invalido', '');
    writeFileSync(invalid.path, bad);
    expect(await removeRecentEntries([uriA], opts(invalid.home))).toBe(0);
    expect(readFileSync(invalid.path).equals(bad)).toBe(true);
  });

  it('archivo inexistente → 0 sin lanzar', async () => {
    expect(await removeRecentEntries([uriA], { platform: 'linux', home: join(tmp, 'nadie') })).toBe(
      0,
    );
  });
});
