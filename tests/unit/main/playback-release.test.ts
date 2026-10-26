// 3.6: si el renderer cae o recarga con un vídeo sonando, main suelta la reproducción activa.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attachPlaybackRelease } from '../../../src/main/playback-release';

describe('attachPlaybackRelease', () => {
  it('suelta al caer el renderer y al navegar o recargar el frame principal', () => {
    const wc = new EventEmitter();
    const release = vi.fn();
    attachPlaybackRelease(wc, release);

    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(release).toHaveBeenCalledTimes(1);
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('ignora subframes y navegaciones dentro del mismo documento', () => {
    const wc = new EventEmitter();
    const release = vi.fn();
    attachPlaybackRelease(wc, release);

    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(release).not.toHaveBeenCalled();
  });
});
