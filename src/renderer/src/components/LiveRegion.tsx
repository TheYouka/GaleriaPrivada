// Región global aria-live (docs/DESIGN.md §14.1): `polite` para avisos y `assertive` solo para los
// errores de contraseña. Se escribe con announce() de lib/announce.ts.
import { useAnnounceStore } from '../lib/announce';

export function LiveRegion() {
  const polite = useAnnounceStore((s) => s.polite);
  const assertive = useAnnounceStore((s) => s.assertive);
  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </>
  );
}
