// capture-date.ts (docs/DESIGN.md §12.8), con la zona de Madrid fijada para este proceso.
import { describe, expect, it } from 'vitest';
import {
  parseExifDate,
  parseIsoInstant,
  parseTzOffset,
  photoCapturedAt,
  videoCapturedAt,
  wallClockOf,
} from '../../../src/main/import/capture-date';

process.env.TZ = 'Europe/Madrid';

/** mtime de 2025-06-01T10:00:00Z en ns: en Madrid (CEST) son las 12:00 de pared. */
const MTIME_NS = BigInt(Date.UTC(2025, 5, 1, 10, 0, 0)) * 1_000_000n;
const MTIME_WALL = Date.UTC(2025, 5, 1, 12, 0, 0);

describe('zona del proceso', () => {
  it('TZ = Europe/Madrid está activa', () => {
    expect(new Date(Date.UTC(2025, 0, 1, 12)).getHours()).toBe(13); // CET, +1
    expect(new Date(Date.UTC(2025, 6, 1, 12)).getHours()).toBe(14); // CEST, +2
  });
});

describe('parseExifDate', () => {
  it('"2026:03:29 02:30:00" (no existe en Madrid) da exactamente Date.UTC(2026, 2, 29, 2, 30, 0)', () => {
    expect(parseExifDate('2026:03:29 02:30:00')).toBe(Date.UTC(2026, 2, 29, 2, 30, 0));
  });

  it('valores inválidos → null', () => {
    for (const v of [
      '0000:00:00 00:00:00',
      '2026:02:30 10:00:00',
      '',
      '2026:13:01 00:00:00',
      '2026:01:01 24:00:00',
      '1899:12:31 23:59:59',
      '2026-01-01 10:00:00',
      null,
      123,
    ]) {
      expect(parseExifDate(v)).toBeNull();
    }
    expect(parseExifDate('2024:02:29 00:00:00')).toBe(Date.UTC(2024, 1, 29));
    expect(parseExifDate('2023:02:29 00:00:00')).toBeNull();
  });

  it('OffsetTimeOriginal → minutos', () => {
    expect(parseTzOffset('+02:00')).toBe(120);
    expect(parseTzOffset('-05:30')).toBe(-330);
    expect(parseTzOffset('2:00')).toBeNull();
  });
});

describe('photoCapturedAt', () => {
  it('DateTimeOriginal → CreateDate → mtime', () => {
    expect(
      photoCapturedAt(
        { DateTimeOriginal: '2024:05:17 10:30:00', CreateDate: '2020:01:01 00:00:00' },
        MTIME_NS,
      ),
    ).toEqual({ capturedAt: Date.UTC(2024, 4, 17, 10, 30, 0), source: 'exif' });
    expect(
      photoCapturedAt({ DateTimeOriginal: '', CreateDate: '2020:01:01 00:00:00' }, MTIME_NS),
    ).toEqual({ capturedAt: Date.UTC(2020, 0, 1), source: 'exif' });
  });

  it('"0000:00:00 00:00:00", "2026:02:30 10:00:00" y "" pasan a mtime (pared local)', () => {
    for (const bad of ['0000:00:00 00:00:00', '2026:02:30 10:00:00', '']) {
      expect(photoCapturedAt({ DateTimeOriginal: bad }, MTIME_NS)).toEqual({
        capturedAt: MTIME_WALL,
        source: 'file_mtime',
      });
    }
    expect(photoCapturedAt(null, MTIME_NS).source).toBe('file_mtime');
  });
});

describe('videoCapturedAt', () => {
  it('creation_time "2026-10-25T00:30:00Z" da la hora de pared de Madrid de ese instante', () => {
    // Todavía CEST (+2): el cambio es a las 01:00Z.
    expect(videoCapturedAt('2026-10-25T00:30:00Z', MTIME_NS)).toEqual({
      capturedAt: Date.UTC(2026, 9, 25, 2, 30, 0),
      source: 'container',
    });
    expect(videoCapturedAt('2026-10-25T00:30:00.000000Z', MTIME_NS).capturedAt).toBe(
      Date.UTC(2026, 9, 25, 2, 30, 0),
    );
    // Después del cambio (CET, +1).
    expect(videoCapturedAt('2026-10-25T01:30:00Z', MTIME_NS).capturedAt).toBe(
      Date.UTC(2026, 9, 25, 2, 30, 0),
    );
  });

  it('sin creation_time válido → mtime', () => {
    for (const bad of [undefined, '', 'ayer', '2026-02-30T10:00:00Z']) {
      expect(videoCapturedAt(bad, MTIME_NS)).toEqual({
        capturedAt: MTIME_WALL,
        source: 'file_mtime',
      });
    }
  });

  it('parseIsoInstant con desfase explícito y wallClockOf', () => {
    expect(parseIsoInstant('2026-01-01T12:00:00+01:00')).toBe(Date.UTC(2026, 0, 1, 11));
    expect(wallClockOf(Date.UTC(2026, 0, 1, 11))).toBe(Date.UTC(2026, 0, 1, 12));
  });
});
