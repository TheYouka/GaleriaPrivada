// Esquemas privilegiados (docs/DESIGN.md §5.5). Se registran antes de `ready`.
// app://bundle sirve el renderer empaquetado; vault:// (Fase 1+) sirve medios descifrados al vuelo.
import { protocol } from 'electron';

export function registerSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    {
      scheme: 'vault',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}
