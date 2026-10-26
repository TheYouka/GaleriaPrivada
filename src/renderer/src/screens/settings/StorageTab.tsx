// Ajustes → Almacenamiento (docs/DESIGN.md §14.9 y §8.7): ubicación de la bóveda, tamaño y
// espacio libre; "Mover bóveda…" (diálogo de carpeta en main) y "Volver a la ubicación
// predeterminada". El progreso va en RelocateDialog (montado en UnlockedApp). [H3-8] La ruta que se
// muestra es la ubicación de la bóveda; el renderer nunca envía ninguna.
import { useEffect } from 'react';
import { Button } from '../../components/Button';
import { errorMessage } from '../../lib/errors-es';
import { formatBytes } from '../../lib/format';
import { refreshVaultInfo, startRelocate, useRelocateStore } from '../../stores/relocate-store';

export function StorageTab() {
  const info = useRelocateStore((s) => s.info);
  const infoError = useRelocateStore((s) => s.infoError);
  const loading = useRelocateStore((s) => s.loading);
  const job = useRelocateStore((s) => s.job);
  const leftoverPath = useRelocateStore((s) => s.leftoverPath);
  const startError = useRelocateStore((s) => s.startError);

  useEffect(() => {
    useRelocateStore.setState({ startError: null });
    void refreshVaultInfo();
  }, []);

  const busy = job !== null;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="storage-location">
        <h2 id="storage-location" className="text-lg font-semibold text-text">
          Ubicación de la bóveda
        </h2>
        {info ? (
          <dl className="grid max-w-prose grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-text-muted">Ubicación</dt>
            <dd className="text-text">
              {info.location === 'default' ? 'Predeterminada' : 'Personalizada'}
            </dd>
            <dt className="text-text-muted">Carpeta</dt>
            <dd>
              <code className="font-mono break-all text-text select-all">{info.path}</code>
            </dd>
            <dt className="text-text-muted">Tamaño</dt>
            <dd className="text-text">{formatBytes(info.sizeBytes)}</dd>
            <dt className="text-text-muted">Espacio libre</dt>
            <dd className="text-text">{formatBytes(info.freeBytes)}</dd>
          </dl>
        ) : infoError ? (
          <p role="alert" className="text-sm text-danger-text">
            {errorMessage(infoError)}
          </p>
        ) : (
          <p role="status" className="text-sm text-text-muted">
            {loading ? 'Calculando…' : ''}
          </p>
        )}
      </section>

      <section className="flex flex-col items-start gap-3" aria-labelledby="storage-move">
        <h2 id="storage-move" className="text-lg font-semibold text-text">
          Mover la bóveda
        </h2>
        <p className="max-w-prose text-sm text-text-muted">
          Galería copia los archivos cifrados a la carpeta nueva, comprueba la copia y después borra
          la ubicación anterior. Mientras tanto no se puede usar la galería. Si eliges un disco
          externo, tendrá que estar conectado para abrir la bóveda.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void startRelocate('choose')}>
            Mover bóveda…
          </Button>
          <Button
            disabled={busy || info?.location !== 'custom'}
            onClick={() => void startRelocate('default')}
          >
            Volver a la ubicación predeterminada
          </Button>
        </div>
        {startError ? (
          <p role="alert" className="max-w-prose text-sm text-danger-text">
            {errorMessage(startError)}
          </p>
        ) : null}
        {leftoverPath ? (
          <div className="max-w-prose rounded-md border border-border-strong bg-surface p-3 text-sm text-text">
            <p>
              No se pudo borrar del todo la ubicación anterior. Galería lo volverá a intentar;
              también puedes borrar tú esta carpeta:
            </p>
            <p className="mt-2">
              <code className="font-mono break-all text-text select-all">{leftoverPath}</code>
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
