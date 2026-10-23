// JobRegistry (docs/DESIGN.md §12.11 y §13.3, [H3-6]): reglas de BUSY, abortAll y drained().
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JobRegistry, type JobKind } from '../../../src/main/session/jobs';
import { appErrorOf } from '../helpers/crypto';

const mediaId = (): string => randomBytes(16).toString('hex');

function registry(onPauseChange?: (paused: boolean) => void): JobRegistry {
  return new JobRegistry({ epoch: 3, onPauseChange });
}

describe('JobRegistry: reglas de §12.11', () => {
  it.each(['import', 'merge', 'music-import', 'relocate'] satisfies JobKind[])(
    '%s: como mucho uno → BUSY',
    async (kind) => {
      const jobs = registry();
      const first = jobs.start(kind);
      expect((await appErrorOf(() => jobs.start(kind))).code).toBe('BUSY');
      first.done();
      expect(() => jobs.start(kind).done()).not.toThrow();
    },
  );

  it('import, merge, music-import y edit coexisten', () => {
    const jobs = registry();
    for (const kind of ['import', 'merge', 'music-import'] satisfies JobKind[]) jobs.start(kind);
    jobs.start('edit', { mediaId: mediaId() });
    expect(jobs.active()).toHaveLength(4);
    expect(jobs.active('import')).toHaveLength(1);
  });

  it('edit: uno por mediaId', async () => {
    const jobs = registry();
    const a = mediaId();
    jobs.start('edit', { mediaId: a });
    expect((await appErrorOf(() => jobs.start('edit', { mediaId: a }))).code).toBe('BUSY');
    expect(() => jobs.start('edit', { mediaId: mediaId() })).not.toThrow();
    expect(() => jobs.start('edit')).toThrow(RangeError);
  });

  it('relocate no coexiste con nada, en los dos sentidos', async () => {
    const jobs = registry();
    const imp = jobs.start('import');
    expect((await appErrorOf(() => jobs.start('relocate'))).code).toBe('BUSY');
    imp.done();
    const relocate = jobs.start('relocate');
    for (const kind of ['import', 'merge', 'music-import'] satisfies JobKind[]) {
      expect((await appErrorOf(() => jobs.start(kind))).code).toBe('BUSY');
    }
    expect((await appErrorOf(() => jobs.start('edit', { mediaId: mediaId() }))).code).toBe('BUSY');
    relocate.done();
    expect(() => jobs.start('import')).not.toThrow();
  });

  it('cada handle lleva la época de su sesión [H3-6]', () => {
    expect(registry().start('import').epoch).toBe(3);
  });
});

describe('JobRegistry: abortAll y drained', () => {
  it('abortAll dispara de forma síncrona todas las señales, también la de la sesión', () => {
    const jobs = registry();
    const handles = [jobs.start('import'), jobs.start('merge'), jobs.start('music-import')];
    const seen: unknown[] = [];
    for (const h of handles) h.signal.addEventListener('abort', () => seen.push(h.signal.reason));
    jobs.abortAll('suspend');
    expect(seen).toEqual(['suspend', 'suspend', 'suspend']);
    expect(jobs.sessionSignal.aborted).toBe(true);
    expect(jobs.sessionSignal.reason).toBe('suspend');
  });

  it('tras abortAll, start da LOCKED', async () => {
    const jobs = registry();
    jobs.abortAll('manual');
    expect((await appErrorOf(() => jobs.start('import'))).code).toBe('LOCKED');
  });

  it('drained() se resuelve cuando todos los trabajos abortados llaman a done()', async () => {
    const jobs = registry();
    await expect(jobs.drained()).resolves.toBeUndefined(); // sin trabajos
    const a = jobs.start('import');
    const b = jobs.start('merge');
    jobs.abortAll('manual');
    let resolved = false;
    void jobs.drained().then(() => (resolved = true));
    a.done();
    await Promise.resolve();
    expect(resolved).toBe(false);
    b.done();
    b.done(); // idempotente
    await vi.waitFor(() => expect(resolved).toBe(true));
  });

  it('setPausesAutoLock avisa solo en los cambios (motivo job, D18)', () => {
    const changes: boolean[] = [];
    const jobs = registry((p) => changes.push(p));
    const merge = jobs.start('merge');
    const imp = jobs.start('import');
    merge.setPausesAutoLock(true);
    imp.setPausesAutoLock(true);
    merge.done();
    imp.setPausesAutoLock(false);
    imp.setPausesAutoLock(true);
    imp.done();
    expect(changes).toEqual([true, false, true, false]);
  });
});
