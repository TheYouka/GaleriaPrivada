// Formatos en español (tamaños, duraciones y fechas).

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1536 → "1,5 KB" (base 1024, como el explorador de archivos). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat('es', { maximumFractionDigits: digits }).format(value)} ${BYTE_UNITS[unit]}`;
}

/** 83 000 ms → "1:23"; 3 723 000 ms → "1:02:03". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const DATE = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });
const MONTH = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' });

/** "22 de octubre de 2026". */
export function formatDate(ms: number): string {
  return DATE.format(ms);
}

/** "octubre de 2026" (cabeceras de mes de la galería, §14.6). */
export function formatMonth(ms: number): string {
  return MONTH.format(ms);
}

const NAIVE_DATE = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Fecha de pared codificada con Date.UTC (captured_at y los filtros de fecha, §12.8): "17 de mayo de 2024". */
export function formatNaiveDate(ms: number): string {
  return NAIVE_DATE.format(ms);
}
