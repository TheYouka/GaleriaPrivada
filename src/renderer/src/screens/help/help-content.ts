// Contenido de la Ayuda (docs/DESIGN.md §14.10 y §24.2): los 13 límites documentados, en el mismo
// orden y con el mismo texto que el diseño, la línea del riesgo aceptado v3-1 y la tabla de atajos.
// El límite 10 es el de D18 (se pausa el bloqueo por inactividad también durante las importaciones);
// si el usuario rechazara D18 para las importaciones, se cambia aquí junto con IMPORT_PAUSES_AUTOLOCK.

export interface HelpLimit {
  /** Frase en negrita con la que empieza el límite. */
  title: string;
  /** Resto del texto. */
  body: string;
}

export const HELP_LIMITS: readonly HelpLimit[] = Object.freeze([
  {
    title: 'El borrado de los originales no es forense.',
    body: 'En SSD (wear leveling, TRIM), NTFS y ext4 (journaling), y con instantáneas o copias del sistema (Historial de archivos, Timeshift, snapshots de Btrfs/ZFS, carpetas sincronizadas con OneDrive u otros servicios, incluida Descargas), pueden quedar copias recuperables. Si el archivo importado tenía otros nombres (enlaces duros), Galería solo quita el nombre importado y no sobrescribe el contenido, porque destruiría también esos otros nombres: el contenido sigue en el disco bajo ellos. Galería sobrescribe y borra lo mejor que puede, pero no lo garantiza. Recomendación: cifra el disco con BitLocker (Windows) o LUKS (Linux).',
  },
  {
    title: 'Windows guarda miniaturas en thumbcache y no se pueden borrar archivo a archivo.',
    body: 'En Linux, Galería borra las miniaturas freedesktop (~/.cache/thumbnails) y quita los archivos importados de la lista de recientes de GTK (~/.local/share/recently-used.xbel), pero otros visores y escritorios pueden tener cachés e historiales propios. Windows también puede guardar el nombre o la carpeta del original en "Archivos recientes", "Acceso rápido", las jump lists y el historial de los diálogos de abrir archivo (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\OpenSavePidlMRU y LastVisitedPidlMRU). Galería pide a Windows que no añada los archivos elegidos a "Recientes", pero no puede limpiar ese historial del registro.',
  },
  {
    title: 'Mientras la bóveda está desbloqueada, los datos descifrados están en la RAM',
    body: 'y el sistema puede moverlos al archivo de paginación, al swap o al archivo de hibernación. Si Galería o el sistema fallan, un volcado de memoria (Informe de errores de Windows con LocalDumps en %LOCALAPPDATA%\\CrashDumps, systemd-coredump o apport en Linux) puede guardar en disco parte de esos datos y de las claves. El cifrado de disco también mitiga esto. Bloquea Galería cuando no la uses.',
  },
  {
    title: 'Lo que puede ver alguien con acceso a los archivos:',
    body: 'cuántos archivos hay en cada bóveda y su tamaño aproximado, sus fechas de modificación, la lista de perfiles (nombres y avatares), la música, los ajustes y los avatares personalizados. No puede ver las fotos, los vídeos, los nombres, las fechas de captura, el EXIF, las playlists ni las ediciones.',
  },
  {
    title:
      'No hay protección contra malware activo, keyloggers ni capturas de pantalla en tu sesión.',
    body: 'En Windows, mientras la bóveda está abierta, Galería pide al sistema que excluya su ventana de las capturas, las grabaciones y Recall (Ajustes → Seguridad), pero un programa malicioso con acceso a tu sesión puede saltarse eso. En Linux esa protección no existe.',
  },
  {
    title: 'No hay recuperación de contraseña ni exportación.',
    body: 'Si olvidas la contraseña, el contenido no se puede descifrar nunca.',
  },
  {
    title: 'Cambiar la contraseña no invalida las copias antiguas de profiles.json:',
    body: 'con una copia antigua y la contraseña antigua se sigue pudiendo abrir la bóveda. Restaurar copias antiguas de la base de datos o de profiles.json (por ejemplo, desde una copia de seguridad) revierte su contenido (nombres, playlists, ediciones) sin aviso.',
  },
  {
    title: 'Galería no hace copias de seguridad.',
    body: 'Si el disco se pierde o se estropea, el contenido se pierde.',
  },
  {
    title: 'Algunos vídeos se procesan al importarlos.',
    body: 'Los MKV, AVI y MOV con códecs compatibles se pasan a MP4 sin pérdida de calidad; los que tienen códecs poco comunes se convierten con pérdida de calidad, previa confirmación. En los dos casos el original se borra después.',
  },
  {
    title: 'El bloqueo por inactividad se pausa',
    body: 'mientras se reproduce un vídeo o una presentación y mientras hay una importación o una fusión de vídeos en curso. Suspender el equipo, bloquear la sesión del sistema o pulsar "Bloquear" bloquean igualmente y cancelan lo que esté en curso.',
  },
  {
    title: 'En Linux, detectar el bloqueo de pantalla del sistema depende del escritorio.',
    body: 'La suspensión y la inactividad sí bloquean siempre.',
  },
  {
    title: 'Como hecho, no como función:',
    body: 'quien tenga acceso de administrador al sistema puede borrar a mano la carpeta de una bóveda. Galería no ofrece ninguna forma de borrar un perfil sin su contraseña.',
  },
  {
    title: 'Si arrastras o copias contenido fuera de Galería',
    body: '(por ejemplo, una foto al escritorio o a otra app, o un nombre con Ctrl+C), esa copia queda fuera de la bóveda y sin cifrar. El texto copiado también puede quedar en el historial del portapapeles de Windows (Win+V) y, si tienes activada su sincronización, en otros dispositivos. Galería no lo impide porque es una acción tuya con la sesión iniciada.',
  },
] satisfies HelpLimit[]);

/** Riesgo aceptado v3-1 (anexo, sección 4): una línea, sin comprobación de pix_fmt. */
export const HELP_CAMERA_VIDEO_NOTE =
  'Algunos vídeos de cámara (H.264 de 10 bits o 4:2:2/4:4:4) podrían no reproducirse en Galería después de importarlos.';

export interface HelpShortcut {
  keys: string;
  action: string;
}

export interface HelpShortcutGroup {
  title: string;
  shortcuts: readonly HelpShortcut[];
}

/**
 * §14.1 (atajos globales) y §14.6 (rejilla de la galería). Las filas de clic reflejan PLAN.md nota
 * 195: un clic siempre alterna la selección; abrir es doble clic o Intro.
 */
export const HELP_SHORTCUT_GROUPS: readonly HelpShortcutGroup[] = Object.freeze([
  {
    title: 'En cualquier pantalla',
    shortcuts: [
      { keys: 'Ctrl+L', action: 'Bloquear' },
      { keys: 'Ctrl+I', action: 'Importar archivos' },
      { keys: 'Ctrl+Shift+I', action: 'Importar carpeta' },
      { keys: 'Ctrl+F', action: 'Ir a la búsqueda' },
      { keys: 'F5', action: 'Presentación de la selección, o de todo lo visible' },
      { keys: 'F1', action: 'Ayuda' },
      { keys: 'Ctrl+,', action: 'Ajustes' },
    ],
  },
  {
    title: 'En la galería',
    shortcuts: [
      { keys: 'Flechas', action: 'Mover el foco entre los elementos' },
      { keys: 'Inicio / Fin', action: 'Primer o último elemento de la fila' },
      { keys: 'Ctrl+Inicio / Ctrl+Fin', action: 'Primer o último elemento de todo' },
      { keys: 'Re Pág / Av Pág', action: 'Subir o bajar una página' },
      { keys: 'Clic', action: 'Seleccionar o quitar de la selección' },
      { keys: 'Doble clic o Intro', action: 'Abrir en el visor (la selección queda como estaba)' },
      {
        keys: 'Espacio',
        action: 'Seleccionar o quitar de la selección el elemento con el foco',
      },
      { keys: 'Ctrl+clic', action: 'Seleccionar o quitar de la selección' },
      { keys: 'Mayús+clic', action: 'Seleccionar el rango desde el último elemento marcado' },
      { keys: 'Mayús+flechas', action: 'Ampliar la selección' },
      { keys: 'Ctrl+A', action: 'Seleccionar todo el resultado' },
      { keys: 'Esc', action: 'Limpiar la búsqueda o la selección' },
      { keys: 'F2', action: 'Renombrar el elemento seleccionado' },
      { keys: 'Supr', action: 'Eliminar la selección (pide confirmación)' },
      { keys: 'Tecla Menú / Mayús+F10', action: 'Abrir el menú contextual' },
    ],
  },
  {
    title: 'En el detalle de una playlist',
    shortcuts: [
      { keys: 'Clic', action: 'Seleccionar o quitar de la selección' },
      { keys: 'Doble clic o Intro', action: 'Abrir en el visor (la selección queda como estaba)' },
      { keys: 'Espacio', action: 'Marcar o desmarcar la casilla con el foco' },
      { keys: 'Ctrl+clic / Mayús+clic', action: 'Alternar la fila / marcar el rango' },
      { keys: 'Esc', action: 'Limpiar la selección' },
    ],
  },
  {
    title: 'En el vídeo dual',
    shortcuts: [
      {
        keys: 'Espacio / K',
        action:
          'Reproducir o pausar (los dos con controles sincronizados; si no, el lado con el foco)',
      },
      { keys: 'J / L o Mayús+flechas', action: 'Retroceder o avanzar 10 s' },
      {
        keys: 'Flecha arriba / abajo',
        action: 'Volumen del lado con el foco (el izquierdo, si no hay)',
      },
      { keys: 'M', action: 'Silenciar o activar el sonido del lado con el foco' },
      { keys: 'R', action: 'Repetir en bucle' },
      { keys: 'Mayús+, / Mayús+.', action: 'Velocidad más lenta o más rápida' },
      {
        keys: 'Ctrl+flecha izquierda / derecha',
        action: 'Mover el foco al lado izquierdo o derecho',
      },
    ],
  },
  {
    title: 'Al reordenar una playlist (sobre el asa de la fila)',
    shortcuts: [
      { keys: 'Espacio / Intro', action: 'Levantar la fila; con la fila levantada, soltarla' },
      { keys: 'Flecha arriba / abajo', action: 'Mover la fila levantada' },
      { keys: 'Esc', action: 'Cancelar el movimiento' },
      { keys: 'Alt+Flecha arriba / abajo', action: 'Mover la fila una posición, sin levantarla' },
    ],
  },
] satisfies HelpShortcutGroup[]);
