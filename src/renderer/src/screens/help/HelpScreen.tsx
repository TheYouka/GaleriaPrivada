// Ayuda (docs/DESIGN.md §14.10): los límites documentados de §24.2, en el mismo orden, la línea del
// riesgo aceptado v3-1 y la tabla de atajos de teclado. Texto estático; se abre con F1 o desde la
// navegación.
import { ScreenHeading } from '../../components/ScreenHeading';
import { HELP_CAMERA_VIDEO_NOTE, HELP_LIMITS, HELP_SHORTCUT_GROUPS } from './help-content';

export function HelpScreen() {
  return (
    <div className="flex max-w-3xl flex-col gap-8 p-8">
      <ScreenHeading className="text-3xl text-text">Ayuda</ScreenHeading>

      <section aria-labelledby="help-import" className="flex flex-col gap-2">
        <h2 id="help-import" className="text-xl font-semibold text-text">
          Importar
        </h2>
        <p className="text-text-muted">
          Al importar, Galería copia cada archivo cifrado a la bóveda, comprueba la copia y solo
          entonces borra el original. Si algo falla, el original se queda donde estaba. Prueba con
          copias hasta que te sientas cómodo: el borrado de los originales es definitivo. Se admiten
          fotos JPG, PNG, WebP, GIF y AVIF, y vídeos MP4, WebM, MKV, AVI y MOV.
        </p>
      </section>

      <section aria-labelledby="help-limits" className="flex flex-col gap-3">
        <h2 id="help-limits" className="text-xl font-semibold text-text">
          Límites
        </h2>
        <ol className="flex list-decimal flex-col gap-3 pl-6 text-text marker:text-text-muted">
          {HELP_LIMITS.map((limit) => (
            <li key={limit.title} className="pl-1">
              <strong className="font-semibold">{limit.title}</strong> {limit.body}
            </li>
          ))}
        </ol>
        <p className="text-text">{HELP_CAMERA_VIDEO_NOTE}</p>
      </section>

      <section aria-labelledby="help-shortcuts" className="flex flex-col gap-4">
        <h2 id="help-shortcuts" className="text-xl font-semibold text-text">
          Atajos de teclado
        </h2>
        {HELP_SHORTCUT_GROUPS.map((group) => (
          <table key={group.title} className="w-full border-collapse text-sm">
            <caption className="pb-2 text-left text-base font-semibold text-text">
              {group.title}
            </caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Atajo</th>
                <th scope="col">Acción</th>
              </tr>
            </thead>
            <tbody>
              {group.shortcuts.map((s) => (
                <tr key={s.keys} className="border-t border-border">
                  <th
                    scope="row"
                    className="w-1/3 py-2 pr-4 text-left font-mono font-medium text-text"
                  >
                    {s.keys}
                  </th>
                  <td className="py-2 text-text">{s.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>
    </div>
  );
}
