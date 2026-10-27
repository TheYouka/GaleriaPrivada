// Cola de pistas de la presentación (docs/DESIGN.md §17.8): en orden, en bucle, saltando las que fallan.
import { describe, expect, it } from 'vitest';
import { MusicQueue } from '../../../src/renderer/src/screens/presentation/music-queue';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

describe('MusicQueue', () => {
  it('las pistas suenan en orden y, tras la última, vuelve la primera', () => {
    const q = new MusicQueue([A, B, C]);
    expect(q.current()).toBe(A);
    expect([q.advance(), q.advance(), q.advance(), q.advance()]).toEqual([B, C, A, B]);
  });

  it('con una sola pista se repite', () => {
    const q = new MusicQueue([A]);
    expect(q.advance()).toBe(A);
    expect(q.advance()).toBe(A);
  });

  it('una pista que falla se salta, también en las vueltas siguientes', () => {
    const q = new MusicQueue([A, B, C]);
    q.advance(); // B
    expect(q.fail()).toBe(C);
    expect([q.advance(), q.advance(), q.advance()]).toEqual([A, C, A]);
  });

  it('si fallan todas, no hay pista y la cola queda agotada (la música se desactiva)', () => {
    const q = new MusicQueue([A, B]);
    expect(q.fail()).toBe(B);
    expect(q.exhausted).toBe(false);
    expect(q.fail()).toBeNull();
    expect(q.exhausted).toBe(true);
    expect(q.current()).toBeNull();
    expect(q.advance()).toBeNull();
  });

  it('sin pistas no hay nada que tocar', () => {
    const q = new MusicQueue([]);
    expect(q.current()).toBeNull();
    expect(q.advance()).toBeNull();
    expect(q.exhausted).toBe(true);
  });

  it('cambiar la lista en vivo sigue con la pista actual si continúa en ella', () => {
    const q = new MusicQueue([A, B, C]);
    q.advance(); // B
    q.setTracks([C, B]);
    expect(q.current()).toBe(B);
    expect(q.advance()).toBe(C);
    q.setTracks([A]);
    expect(q.current()).toBe(A);
  });
});
