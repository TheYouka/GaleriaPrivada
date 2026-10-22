# Galería: diseño técnico

Versión del documento: 3 (22-oct-2026; revisa la versión 2 con los 20 hallazgos de la revisión 2 de `.agents/tasks/design-review.md` y las decisiones del usuario de la sección 3 del anexo; ver sección 27). Idioma: español. Este documento es la referencia que implementarán las fases de `docs/PLAN.md`. Si el plan y este diseño se contradicen, manda este diseño hasta que se revise.

Fuentes de requisitos (mismo peso las dos):

- El brief original del usuario (mensajes 1 y 2 de la conversación).
- El anexo de requisitos confirmado después: `.agents/tasks/requirements-addendum.md` (ruta relativa a la raíz del repo; ruta absoluta `c:\Users\AlbertoVázquezAguila\Documents\Galeria_App\.agents\tasks\requirements-addendum.md`). Añade:
  - punto 1: el borrado de perfil exige siempre la contraseña (decisión cerrada);
  - punto 2: el sistema de 5 temas visuales (sección 15);
  - punto 3: la aclaración del modelo de amenazas (5.1), la retirada de BMP de los formatos admitidos y la decisión D18 (auto-bloqueo durante trabajos largos).

Fuera de alcance, explícitamente: nube o cualquier red, exportar o "desocultar", recuperar la contraseña, subtítulos, HEIC/HEIF, RAW y BMP, modo de "explorar carpetas normales", e impedir que el propietario con la sesión iniciada arrastre o copie contenido fuera de la ventana (anexo, punto 3; límite 13 de 24.2).

---

## 1. Visión general

Galería es una app de escritorio para Windows y Linux, hecha con Electron, que funciona como una bóveda privada de fotos y vídeos con la experiencia de Fotos de Windows. Todo lo que se importa se cifra dentro de la bóveda del perfil activo y el original se borra cuando la copia cifrada está verificada. La app no hace ninguna conexión de red. El proceso principal (main) es el único que conoce las claves: descifra al vuelo los medios y se los sirve al renderer mediante un protocolo propio `vault://` que admite peticiones Range. Nunca se escribe nada descifrado en disco. Cada perfil tiene su contraseña, su clave maestra aleatoria y su base de datos SQLCipher. Cambiar la contraseña solo vuelve a envolver la clave maestra. Encima de ese núcleo van la galería virtualizada, el visor con edición no destructiva, el reproductor, las playlists, la presentación con transiciones y música (Web Audio) y el vídeo dual con fusión mediante ffmpeg. Toda la interfaz se puede cambiar en vivo entre 5 temas.

---

## 2. Stack y versiones exactas

Versiones consultadas el 22-oct-2026 con `npm.cmd view <pkg> version`, `engines` y `peerDependencies`. En PowerShell hay que usar `npm.cmd` y `npx.cmd`, porque `npm.ps1` está bloqueado por la ExecutionPolicy RemoteSigned (ver `.agents/tasks/env.md`). En `package.json` todas las versiones se fijan exactas, sin `^` ni `~`.

### 2.1 Dependencias de runtime del proceso main (`dependencies`, se externalizan y empaquetan)

| Paquete | Versión | Notas |
|---|---|---|
| `@node-rs/argon2` | 2.2.2 | N-API (napi-rs) con binarios precompilados por plataforma en optionalDependencies (`@node-rs/argon2-win32-x64-msvc`, `-linux-x64-gnu`). No necesita node-gyp. |
| `better-sqlite3-multiple-ciphers` | 13.0.3 | Trae SQLite3MultipleCiphers 2.4.0. `gypfile: false`, con binarios N-API precompilados dentro del tarball (`prebuilds/win32-x64.node`, `prebuilds/linux-x64.node`, …), así que no compila nada. Expone `db.key(Buffer)` y `db.rekey(Buffer)`. |
| `sharp` | 0.35.5 | N-API con libvips 8.18.7 precompilada (`@img/sharp-win32-x64`, `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64` 1.3.4). Decodifica JPEG/PNG/WebP/GIF/AVIF, que son los únicos formatos de foto admitidos (BMP quedó fuera por decisión del usuario, anexo punto 3). Solo se carga a través de `src/main/media/sharp-loader.ts` (12.4, paso 4). |
| `exifr` | 7.1.3 | JS puro. Siempre recibe buffers, nunca URLs. |
| `zod` | 4.6.7 | Valida los payloads IPC, los JSON de disco y la salida de ffprobe. Añadido al stack aprobado (D17). |

### 2.2 Renderer (se empaqueta con Vite; va en `devDependencies`)

| Paquete | Versión | Notas |
|---|---|---|
| `react`, `react-dom` | 19.3.1 | |
| `radix-ui` | 1.8.1 | Paquete unificado. peer react ^19 OK. |
| `motion` | 14.6.0 | Antes Framer Motion. peer react ^19 OK. |
| `@tanstack/react-virtual` | 3.14.22 | Grid virtualizado. |
| `zustand` | 5.0.16 | Estado. |
| `@dnd-kit/core` / `@dnd-kit/sortable` | 6.3.1 / 10.0.0 | Reordenar playlists arrastrando, con `KeyboardSensor` accesible. Se añade al stack aprobado (D17) porque Motion `Reorder` no ofrece teclado. |
| `lucide-react` | 1.61.0 | Iconos originales (licencia ISC). No se usa ningún icono de Microsoft, Sony ni Apple. Añadido al stack aprobado (D17). |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 / 4.3.3 | Tailwind v4 configurado en CSS (`@import "tailwindcss"` + `@theme inline`). Sin `tailwind.config.js` ni PostCSS. peer vite ^8 OK. |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1. Temas `fotos` y `macos`. Las cinco fuentes se añaden al stack aprobado (D17) porque el anexo exige fuentes locales y abiertas. |
| `@fontsource-variable/noto-sans` | 5.3.0 | OFL-1.1. Tema `xbox` y texto de cuerpo de `album`. |
| `@fontsource-variable/nunito` | 5.3.0 | OFL-1.1. Tema `ps3`. |
| `@fontsource-variable/fraunces` | 5.3.0 | OFL-1.1. Títulos serif de `album`. |
| `@fontsource-variable/caveat` | 5.3.0 | OFL-1.1. Rótulos manuscritos de `album`. |

### 2.3 Herramientas (`devDependencies`)

| Paquete | Versión | Notas de compatibilidad |
|---|---|---|
| `electron` | 44.9.3 | Línea estable 44.x (Node 24 interno, por eso `@types/node` ^24). npm ya publica 45.0.0 (salió el 21-oct-2026), pero se descarta por tener un día. Se reevalúa al empezar la Fase 7 (instaladores). |
| `electron-vite` | 6.0.0 | peer vite ^6 \|\| ^7 \|\| ^8; engines node ^20.19 \|\| >=22.12. |
| `vite` | 8.3.5 | Exigido por `@vitejs/plugin-react` 6 (peer vite ^8). |
| `@vitejs/plugin-react` | 6.1.2 | Sus peers opcionales (oxc/babel/react-compiler) no se instalan. |
| `typescript` | 6.0.3 | No se usa la 7.0.2 (`latest`) porque `typescript-eslint` 8.72.0 exige `>=4.8.4 <6.1.0`. TS 6 cambió valores por defecto (`types` vacío, `strict` activo): cada tsconfig declara `types` de forma explícita. |
| `@types/node` | 24.19.2 | Coincide con el Node 24 de Electron 44, no con el Node 26 del sistema. |
| `@types/react` / `@types/react-dom` | 19.3.0 / 19.3.0 | |
| `vitest` / `@vitest/coverage-v8` | 5.0.5 / 5.0.5 | peer vite ^8 OK; engines node ^22.12 \|\| ^24 \|\| >=26 (Node 25 queda excluido). |
| `@playwright/test` | 1.64.1 | Usa `_electron`. No hace falta descargar navegadores. |
| `eslint` / `@eslint/js` | 9.39.5 / 9.39.5 | No se usa ESLint 10: `eslint-plugin-jsx-a11y` 6.10.2 solo declara peer eslint hasta ^9. |
| `typescript-eslint` | 8.72.0 | |
| `eslint-plugin-react-hooks` | 7.1.1 | |
| `eslint-plugin-react-refresh` | 0.5.7 | peer eslint ^9 \|\| ^10. |
| `eslint-plugin-jsx-a11y` | 6.10.2 | Reglas de accesibilidad. |
| `eslint-config-prettier` | 10.1.8 | |
| `globals` | 17.13.0 | |
| `prettier` / `prettier-plugin-tailwindcss` | 3.9.10 / 0.8.1 | |
| `electron-builder` | 26.15.3 | NSIS, AppImage, deb y `electronFuses`. |

No se usan: `@electron-toolkit/*` (no aporta nada imprescindible), `eslint-plugin-react` (la cobertura de hooks y a11y basta), jsdom ni testing-library (los tests unitarios son de lógica pura y la UI se prueba con Playwright), `ffmpeg-static` (es GPL-3.0, ver sección 19), `@electron/rebuild` (no hace falta porque todos los módulos nativos son N-API precompilados; ver 2.1 y 20.1).

### 2.4 Binarios externos

FFmpeg y ffprobe 8.1.3 de BtbN/FFmpeg-Builds, variante LGPL compartida (`lgpl-shared`), del tag `autobuild-2026-10-22-13-06`. Los SHA-256 oficiales están en la sección 19.

### 2.5 Node.js

- El mínimo lo marcan `electron`, `vite`, `electron-vite` y `@vitejs/plugin-react` (>= 22.12.0) y `vitest` (^22.12 \|\| ^24 \|\| >=26).
- En `package.json` va `"engines": { "node": "^24.0.0 || >=26.0.0" }`. Hay que corregir el `">=24"` que dejó el paso de setup, porque admite Node 25 y Vitest lo excluye.
- La máquina tiene Node 26.10.0, de la línea Current (todavía no LTS). Cumple todos los `engines`. Se recomienda actualizar al último parche 26.x, o usar Node 24 LTS si aparece algún problema. El Node del sistema solo se usa para las herramientas. En runtime corre el Node 24 que trae Electron.
- Los tres módulos nativos son N-API, así que el mismo binario carga en Node 26 (Vitest) y en Electron 44. La nota de ABI del `PLAN.md` de la raíz deja de aplicar: los tests de Vitest pueden cargar argon2, SQLCipher y sharp directamente.

---

## 3. Arquitectura de procesos

```
┌────────────────────────── proceso main (Node 24 de Electron) ──────────────────────────┐
│ app lifecycle · seguridad (red/CSP/navegación) · protocolos app:// y vault://          │
│ SessionManager (KeyRing en memoria) · perfiles · DB SQLCipher · object store cifrado   │
│ importación · miniaturas (sharp) · ffmpeg/ffprobe (procesos hijos) · servidor loopback │
│ auto-bloqueo (powerMonitor) · settings/prefs JSON · IPC (validación zod)               │
└──────────────▲───────────────────────────────▲─────────────────────────────────────────┘
               │ ipcRenderer.invoke / eventos   │ vault://media|thumb|music|avatar (Range)
┌──────────────┴──────────────┐   ┌─────────────┴──────────────────────────────────────┐
│ preload (sandbox, CJS)      │   │ renderer (React, sandbox, sin Node)                │
│ contextBridge → window.     │──▶│ UI, temas, Zustand, Web Audio, <img>/<video>       │
│ galeria (allowlist canales) │   │ nunca ve claves ni rutas de objetos de la bóveda   │
└─────────────────────────────┘   └────────────────────────────────────────────────────┘
        src/shared: tipos y contrato IPC, constantes, lógica pura (edits, presentación, temas)
```

Responsabilidades:

- **main** (`src/main`): es el único proceso con acceso a disco, claves, SQLite, sharp, ffmpeg y diálogos nativos. Hace de autoridad para todas las invariantes de seguridad (sección 22). No usa `utilityProcess`. El cifrado y el hash se hacen por bloques de 64 KiB con E/S asíncrona y backpressure, así que el hilo principal sigue respondiendo (AES-GCM con AES-NI va a más de 1 GB/s). Si en la Fase 2 una importación grande bloquea la UI más de 100 ms seguidos, el trabajo se moverá a un `utilityProcess`. Esa medición está prevista en el plan.
- **preload** (`src/preload`): expone `window.galeria` con `contextBridge`. Ofrece `invoke(channel, payload)`, limitado a una allowlist de canales; `on(event, cb)`, también con allowlist; e `importDropped(files)`, que resuelve las rutas con `webUtils.getPathForFile` dentro del preload sin devolverlas al renderer (12.2). Se compila a CommonJS porque los preloads con sandbox no admiten ESM.
- **renderer** (`src/renderer`): React 19 con Zustand. La navegación va por estado (pantalla actual en un store), sin router ni URLs. Los medios se cargan por `vault://`. Web Audio para la presentación. Al bloquear, main sustituye la ventana por una nueva con un proceso de renderer nuevo (13.3).
- **shared** (`src/shared`): solo TypeScript puro sin dependencias de Node ni del DOM. Contrato IPC y tipos, códigos de error, constantes de formatos y límites, plegado de ediciones (`foldEdits`), valores por defecto de la presentación y catálogo de temas. Lo importan los tres procesos.

---

## 4. Layout del repositorio (exacto)

El scaffold crea todas las carpetas del árbol, con `.gitkeep` en las que queden vacías, y los archivos marcados **[S]**. El resto de archivos los crea la fase indicada (`[F1]`…`[F7]`, la numeración de fases de `docs/PLAN.md`; ver sección 26). Los nombres de archivo son ASCII en kebab-case, salvo los componentes React, que van en PascalCase.

```
Galeria_App/
├─ package.json                      [S] scripts y versiones exactas (2)
├─ package-lock.json                 [S]
├─ electron.vite.config.ts           [S]
├─ electron-builder.yml              [S] (mínimo) → completo en [F7]
├─ tsconfig.json                     [S] solo "references" + "files": []
├─ tsconfig.node.json                [S] main, preload, shared, tests, scripts, configs (types: ["node"])
├─ tsconfig.web.json                 [S] renderer + shared (types: ["vite/client"]; lib DOM)
├─ eslint.config.mjs                 [S]
├─ .prettierrc.json / .prettierignore[S]
├─ vitest.config.ts                  [S] include tests/unit/**/*.test.ts, environment node
├─ playwright.config.ts              [S] testDir tests/e2e, workers 1, timeout 60 s
├─ .gitignore / .editorconfig / .nvmrc / README.md   [S]
├─ docs/DESIGN.md, docs/PLAN.md
├─ scripts/
│  ├─ native-spike.cjs               [S] carga argon2/SQLCipher/sharp dentro de Electron main
│  ├─ make-icon.mjs                  [S] genera resources/build/icon.png con sharp (26.2)
│  └─ fetch-ffmpeg.mjs               [F2] descarga, verifica SHA-256 y extrae ffmpeg (+ fuentes LGPL, 19.3)
├─ resources/
│  ├─ build/                         [S] icon.png (512×512, color sólido #1b1b1f); [F7] icon.ico e iconos finales
│  ├─ ffmpeg/manifest.json           [F2] URLs + SHA-256 (versionado)
│  ├─ ffmpeg/win-x64/, linux-x64/    [F2] binarios descargados (en .gitignore)
│  └─ licenses/                      [F7] FFmpeg LGPL-2.1, OFL de fuentes, THIRD-PARTY-NOTICES.md
├─ src/
│  ├─ shared/
│  │  ├─ ipc-contract.ts             [S] (mínimo: app:getInfo) → completo [F1+]
│  │  ├─ errors.ts                   [S] ErrorCode (lista completa de 10.1), AppError, Result<T>
│  │  ├─ types.ts                    [F1]
│  │  ├─ constants.ts                [F1] formatos, límites
│  │  ├─ edits.ts                    [F3] EditOp, foldEdits(), mapeos de recorte
│  │  ├─ presentation.ts             [F4] tipos + DEFAULT_PRESENTATION
│  │  └─ themes.ts                   [F1] ThemeId, catálogo, nombres visibles
│  ├─ main/
│  │  ├─ index.ts                    [S] arranque en el orden exacto de 5.2: guards, userData, single-instance, schemes, ready, ventana
│  │  ├─ app-paths.ts                [S] userData ASCII, raíz de datos, override GALERIA_DATA_DIR
│  │  ├─ window.ts                   [S] BrowserWindow endurecida
│  │  ├─ log.ts                      [F1]
│  │  ├─ security/
│  │  │  ├─ csp.ts                   [S] (único sitio con webRequest.onHeadersReceived, 5.4)
│  │  │  ├─ network-guard.ts         [S] webRequest + contador por esquema + proxy muerto + WebRTC (5.4)
│  │  │  ├─ node-egress-guard.ts     [S] bloqueo en runtime de fetch/net/dns/dgram de Node (5.4)
│  │  │  ├─ startup-checks.ts        [S] forbiddenDebugSwitch(): sale si el binario empaquetado trae switches de depuración (5.2)
│  │  │  └─ navigation-guard.ts      [S]
│  │  ├─ protocol/
│  │  │  ├─ schemes.ts               [S] registerSchemesAsPrivileged (antes de ready)
│  │  │  ├─ app-protocol.ts          [S] app://bundle → out/renderer
│  │  │  ├─ vault-protocol.ts        [F1] (avatar) → [F2] media/thumb → [F4] music
│  │  │  └─ range.ts                 [F2] parseo puro de Range
│  │  ├─ crypto/
│  │  │  ├─ secure-buffer.ts         [F1] alloc/zeroize
│  │  │  ├─ kdf.ts                   [F1] Argon2id + calibración
│  │  │  ├─ keys.ts                  [F1] wrap/unwrap MK, HKDF, KeyRing
│  │  │  ├─ file-format.ts           [F1] cabecera, constantes, aritmética de tamaños
│  │  │  ├─ object-writer.ts         [F1] cifrado en streaming
│  │  │  └─ object-reader.ts         [F1] lectura aleatoria / Range
│  │  ├─ profiles/
│  │  │  ├─ profile-store.ts         [F1] profiles.json atómico + .bak
│  │  │  ├─ profile-service.ts       [F1] crear/editar/cambiar contraseña/borrar
│  │  │  └─ avatars.ts               [F1]
│  │  ├─ session/
│  │  │  ├─ session-manager.ts       [F1] máquina de estados lock/unlock (13)
│  │  │  ├─ auto-lock.ts             [F1] temporizador con motivos de pausa (13.2)
│  │  │  ├─ jobs.ts                  [F1] JobRegistry: AbortController por trabajo, BUSY, abortAll() (12.11, 13.3)
│  │  │  └─ keyless-cleanup.ts       [F1] limpiezas sin claves que siguen tras el bloqueo (13.3, paso 6)
│  │  ├─ settings/settings-store.ts  [F1] settings.json + prefs/<id>.json
│  │  ├─ vault/
│  │  │  ├─ vault-layout.ts          [F1] rutas, sharding y removeVaultDir() (8.5.1)
│  │  │  ├─ object-store.ts          [F2]
│  │  │  ├─ in-flight.ts             [F2] ids en curso que el barrido de huérfanos no toca (12.6)
│  │  │  ├─ reconcile.ts             [F2]
│  │  │  └─ relocate.ts              [F2]
│  │  ├─ db/
│  │  │  ├─ database.ts              [F1] apertura SQLCipher + PRAGMAs
│  │  │  ├─ migrate.ts               [F1]
│  │  │  ├─ migrations/index.ts      [F1] lista ordenada {version, sql}
│  │  │  └─ repos/ media-repo.ts [F2], playlist-repo.ts [F4], edit-repo.ts [F3],
│  │  │           music-repo.ts [F4], kv-repo.ts [F1]
│  │  ├─ import/
│  │  │  ├─ import-service.ts        [F2] un trabajo de importación activo como mucho (12.11)
│  │  │  ├─ walk.ts / sniff.ts       [F2]
│  │  │  ├─ naming.ts                [F2] nombre y extensión a partir del archivo (12.4.1), puro
│  │  │  ├─ capture-date.ts          [F2] fechas EXIF/contenedor/mtime → hora naive (12.8), puro
│  │  │  ├─ image-pipeline.ts        [F2]
│  │  │  ├─ video-pipeline.ts        [F2]
│  │  │  ├─ secure-delete.ts         [F2]
│  │  │  ├─ linux-thumbnails.ts      [F2]
│  │  │  └─ linux-recent.ts          [F2] limpieza de recently-used.xbel (12.9.1)
│  │  ├─ media/
│  │  │  ├─ sharp-loader.ts          [F1] único punto de carga de sharp (VIPS_DISC_THRESHOLD, 12.4)
│  │  │  ├─ ffmpeg.ts                [F2] resolución de binarios, spawn, progreso
│  │  │  ├─ loopback-server.ts       [F2]
│  │  │  ├─ thumbnails.ts            [F2]
│  │  │  ├─ edits-render.ts          [F3]
│  │  │  └─ merge-service.ts         [F5]
│  │  ├─ music/music-service.ts      [F4]
│  │  └─ ipc/
│  │     ├─ register.ts              [S] wrapper handle() mínimo: emisor, zod, Result → [F1] + requiresUnlock y maintenance (5.6)
│  │     ├─ library-events.ts        [F2] agrupa library:changed (10.2)
│  │     └─ handlers/ app.ts [S], window.ts [F1], profiles.ts [F1], session.ts [F1],
│  │                  settings.ts [F1], media.ts [F2], import.ts [F2], vault.ts [F2],
│  │                  edits.ts [F3], playlists.ts [F4], music.ts [F4],
│  │                  presentation.ts [F4], merge.ts [F5]
│  ├─ preload/
│  │  └─ index.ts                    [S] contextBridge (allowlist)
│  └─ renderer/
│     ├─ index.html                  [S]
│     └─ src/
│        ├─ lockdown.ts              [S] primer import de main.tsx: elimina las APIs de WebRTC (5.4, punto 5)
│        ├─ main.tsx / App.tsx       [S] placeholder oscuro con el título
│        ├─ env.d.ts                 [S] tipos de window.galeria
│        ├─ styles/base.css          [S] @import "tailwindcss" + @theme inline
│        ├─ styles/fonts.css, styles/themes.css   [F1] (themes.css: fotos en F1, resto en F6)
│        ├─ lib/ ipc.ts, vault-url.ts, format.ts, keyboard.ts, focus.ts        [F1]
│        ├─ stores/ session-store.ts, nav-store.ts, theme-store.ts [F1];
│        │          library-store.ts, selection-store.ts, import-store.ts [F2];
│        │          player-store.ts [F3]; presentation-store.ts [F4]; dual-store.ts [F5]
│        ├─ themes/
│        │  ├─ registry.ts, build-css.ts, ThemeProvider.tsx, contrast.ts   [F1]
│        │  ├─ tokens/ fotos.ts [F1], ps3.ts [F1 stub → F6], xbox.ts, macos.ts, album.ts [F6]
│        │  ├─ shells/ SidebarShell.tsx [F1], XmbShell.tsx [F1 stub → F6], PivotShell.tsx,
│        │  │          VibrancyShell.tsx, TopbarShell.tsx [F6]
│        │  ├─ backgrounds/ MicaBackground.tsx [F1], WavesBackground.tsx [F1 stub → F6],
│        │  │               WallpaperBackground.tsx, PaperBackground.tsx [F6]
│        │  └─ titlebars/ Titlebar.tsx (variantes) [F1]
│        ├─ components/ Button, IconButton, Dialog, ConfirmDialog, Menu, Tile, Avatar,
│        │              Slider, TextField, PasswordField, Toast, LiveRegion…   [F1+]
│        ├─ screens/
│        │  ├─ profiles/ ProfilePicker, UnlockDialog, ManageProfiles, ProfileForm,
│        │  │            ChangePasswordDialog, DeleteProfileDialog              [F1]
│        │  ├─ gallery/ GalleryScreen, GalleryGrid, CommandBar, FilterBar,
│        │  │           SelectionBar, ImportDropZone, ImportProgress, RenameDialog [F2]
│        │  ├─ viewer/ Viewer, ZoomPan, zoom-math.ts, EditedImage, InfoPanel, Editor [F3]
│        │  ├─ player/ VideoPlayer, PlayerControls                              [F3]
│        │  ├─ playlists/ PlaylistsScreen, PlaylistDetail                       [F4]
│        │  ├─ presentation/ PresentationScreen, SlideStage, PresentationControls,
│        │  │                PresentationSettingsPanel, transitions.ts,
│        │  │                scheduler.ts, audio-graph.ts                       [F4]
│        │  ├─ dual/ DualVideoScreen, MergeDialog, sync.ts                      [F5]
│        │  ├─ settings/ SettingsScreen, ThemePicker, ThemePreview, MusicLibrary [F1…F6]
│        │  └─ help/ HelpScreen                                                 [F2]
│        └─ assets/ avatars/*.svg [F1], textures/*.png [F6], wallpapers/*.svg [F6]
└─ tests/
   ├─ unit/                          Vitest (Node del sistema)
   │  ├─ smoke.test.ts               [S]
   │  ├─ main/node-egress-guard.test.ts [S] (5.4)
   │  ├─ main/startup-checks.test.ts [S] (5.2)
   │  ├─ crypto/*.test.ts            [F1]
   │  ├─ shared/*.test.ts            [F1+]
   │  ├─ main/*.test.ts              [F1+] (DB, import, range, loopback, linux-thumbnails)
   │  └─ renderer/*.test.ts          [F1+] (lógica pura: contraste, selección, scheduler)
   ├─ e2e/
   │  ├─ helpers/launch.ts           [S] _electron.launch con GALERIA_DATA_DIR temporal
   │  └─ smoke.spec.ts               [S] ventana + red bloqueada (incluido WebRTC, 5.4)
   └─ fixtures/                      [F2] generados por script (no fotos reales)
```

Scripts de npm (todos **[S]**, salvo los marcados):

| Script | Comando |
|---|---|
| `dev` | `electron-vite dev` |
| `build` | `electron-vite build` |
| `typecheck` | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` |
| `lint` | `eslint .` |
| `format` | `prettier --write .` |
| `test` | `vitest run` |
| `test:e2e` | `electron-vite build && playwright test` |
| `spike:native` | `electron scripts/native-spike.cjs` |
| `make:icon` | `node scripts/make-icon.mjs` (el scaffold lo ejecuta una vez; `icon.png` se versiona) |
| `fetch:ffmpeg` [F2] | `node scripts/fetch-ffmpeg.mjs` |
| `dist:win` [F7] | `electron-vite build && electron-builder --win nsis` |
| `dist:linux` [F7] | `electron-vite build && electron-builder --linux AppImage deb` |

npm ejecuta los scripts con `cmd.exe` en Windows, así que `&&` funciona dentro de `package.json`. En la terminal PowerShell se encadena con `;`.

`electron.vite.config.ts`:

- **main**: entrada `src/main/index.ts`, salida `out/main` en formato `cjs`. `dependencies` se externaliza con el mecanismo por defecto de electron-vite 6.
- **preload**: entrada `src/preload/index.ts`, salida `out/preload/index.js` en formato `cjs`.
- **renderer**: `root: src/renderer`, salida `out/renderer`, plugins `react()` y `tailwindcss()`, y `build.assetsInlineLimit: 0`. Así no se generan URLs `data:` y la CSP puede seguir sin `data:`. `server: { host: '127.0.0.1', port: 5173, strictPort: true }`: el origen de desarrollo es siempre `http://127.0.0.1:5173` (electron-vite 6 construye `ELECTRON_RENDERER_URL` como `${protocol}//${resolveHostname(host)}:${port}`, comprobado en su `dist`), así que la CSP de desarrollo (5.3), el guard (5.4) y `host-resolver-rules` (5.2) lo comparan de forma exacta.
- **Alias**: `@shared` → `src/shared` y `@renderer` → `src/renderer/src`. Se replican en los `paths` de los tsconfig.

`package.json` no declara `"type": "module"`. Los `.ts` de main y preload salen en CJS y los configs que necesitan ESM usan la extensión `.mjs`.

---

## 5. Modelo de seguridad y amenazas

### 5.1 Activos, adversarios y alcance

Activos: el contenido de los medios, sus nombres, fechas y EXIF, las playlists, las ediciones, la base de datos y las claves.

**Modelo de amenazas confirmado por el usuario** (`.agents/tasks/requirements-addendum.md`, punto 3, vinculante; el revisor no debe volver a plantear los hallazgos que esa sección descarta):

- La app es de **uso personal**.
- La amenaza que se defiende: alguien que **no conoce la contraseña** de un perfil abre la app, o accede a los archivos de la bóveda en disco, y obtiene cualquier dato de la bóveda sin iniciar sesión (fotos, vídeos, miniaturas, nombres, fechas, playlists).
- Siguen siendo prioritarios todo lo que protege contra esa amenaza: el cifrado y el formato de archivo (6, 7); el bloqueo (manual, inactividad, suspensión y bloqueo del SO) con las claves a cero y la UI oculta al momento (13.3); que **la propia app** nunca escriba nada descifrado en disco (temporales, cachés, logs, temporales de libvips, entradas de ffmpeg); que no haya datos accesibles con la sesión bloqueada; que el selector de perfiles no revele nada; y que no haya red.
- **Fuera de alcance, por decisión del usuario**: lo que hace a propósito el propietario con la sesión iniciada, como arrastrar imágenes o texto fuera de la ventana (al escritorio u otra app) o copiar y pegar con el portapapeles. Es un comportamiento esperado: no se añade ningún bloqueo de `dragstart`, `-webkit-user-drag`, `draggable={false}` ni `user-select: none`, y solo se documenta (límite 13 de 24.2). Esto descarta los hallazgos 1 y 18 de la revisión 2. Sigue sin existir ninguna función de exportar ni de "desocultar".

| Adversario | ¿Protegido? |
|---|---|
| Alguien que copia la carpeta de datos o roba el disco con la app bloqueada o cerrada | Sí. Solo ve archivos cifrados, cuántos hay y su tamaño aproximado. |
| Otro perfil de la app en la misma cuenta del SO | Sí. Cada bóveda tiene su clave maestra y no hay ningún camino de datos entre perfiles. |
| Alguien que usa el equipo mientras la bóveda está desbloqueada | Parcialmente: bloqueo manual, por inactividad y al suspender o bloquear el SO. |
| Malware activo o keylogger en la cuenta del usuario | No (límite documentado, sección 24). |
| Análisis forense de los originales borrados (SSD, NTFS, ext4, pagefile, swap, thumbcache) | No garantizado (límite documentado). |
| Fuerza bruta offline de la contraseña con `profiles.json` | Mitigado con Argon2id y parámetros altos (6.1). Una contraseña débil sigue siendo débil. |
| Alguien que arranca el binario empaquetado con switches de depuración (`--remote-debugging-port`, …) para leer el renderer | Sí: la app sale antes de crear ninguna ventana (5.2, `startup-checks.ts`). |
| Contenido web malicioso | No aplica: la app no carga contenido remoto. La CSP y el bloqueo de red son defensa en profundidad, también frente a una dependencia comprometida del bundle del renderer (incluido WebRTC, 5.4, punto 5). |
| El propietario, con la sesión iniciada, arrastra o copia contenido fuera de la ventana | Fuera de alcance (acción deliberada del usuario; anexo, punto 3). Documentado en el límite 13 de 24.2. |

### 5.2 Endurecimiento de `BrowserWindow` (`src/main/window.ts`)

```ts
new BrowserWindow({
  width: 1280, height: 800, minWidth: 960, minHeight: 600,
  show: false,                 // se muestra en 'ready-to-show' (evita destello blanco)
  backgroundColor: '#1b1b1f',  // = token bg del tema fotos oscuro
  title: 'Galería',
  frame: false,                // desde F1 (barra de título propia por tema, 15.6). El scaffold usa frame: true
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    partition: 'galeria',      // sin "persist:" → sesión en memoria: sin caché HTTP, cookies ni storage en disco
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: !app.isPackaged,
    safeDialogs: true,
    autoplayPolicy: 'no-user-gesture-required', // la presentación encadena vídeos con sonido
    additionalArguments: [`--galeria-theme=${themeId}`, `--galeria-scheme=${scheme}`],
  },
});
```

Además, en `src/main/index.ts`, **en este orden exacto** y todo antes de `ready`:

1. `installNodeEgressGuard()` (5.4, punto 10), primera sentencia del módulo.
2. **Switches de depuración** (`security/startup-checks.ts`):

   ```ts
   // Los fuses cierran --inspect de Node, pero no los switches de depuración de Chromium.
   // El script de main se ejecuta antes de que Chromium arranque el servidor de DevTools,
   // así que salir aquí impide que llegue a abrirse el puerto o la tubería CDP.
   export const FORBIDDEN_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe',
     'remote-debugging-address', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags'] as const;
   export function forbiddenDebugSwitch(isPackaged: boolean, has: (s: string) => boolean): string | null {
     return isPackaged ? (FORBIDDEN_SWITCHES.find((s) => has(s)) ?? null) : null;
   }
   // index.ts:
   if (forbiddenDebugSwitch(app.isPackaged, (s) => app.commandLine.hasSwitch(s))) app.exit(1);
   ```

   Sin empaquetar no se comprueba (las DevTools y el inspector se usan en desarrollo y en los E2E). No se registra nada: todavía no hay log. Unitario `tests/unit/main/startup-checks.test.ts` [S] con la función pura; F7 añade a la lista de comprobación manual que el instalado, lanzado con `--remote-debugging-port=9222`, sale con código 1 y el puerto 9222 no queda abierto.
3. `app.setPath('userData', <ASCII>)` (8.1). Va **antes** del paso 4 porque el lock de instancia única se ancla al directorio de `userData` vigente cuando se pide (no verificado en el código de Electron; es el orden seguro en cualquier caso, y el E2E de abajo lo comprueba).
4. `app.requestSingleInstanceLock()`: si devuelve `false`, `app.quit()`; la segunda instancia enfoca la primera.
5. `app.enableSandbox()`.
6. `protocol.registerSchemesAsPrivileged(...)` (5.5).
7. Los switches de Chromium:

   ```ts
   // Solo en desarrollo se excluye el host del servidor de Vite (127.0.0.1, 4.); en producción no hay excepción.
   const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
   app.commandLine.appendSwitch('host-resolver-rules',
     devUrl ? `MAP * ~NOTFOUND, EXCLUDE ${new URL(devUrl).hostname}` : 'MAP * ~NOTFOUND');
   if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic'); // 20.1
   ```

   El switch hace fallar cualquier resolución DNS de Chromium, como defensa en profundidad. Sin el `EXCLUDE`, el renderer de desarrollo y el WebSocket de HMR fallarían con `ERR_NAME_NOT_RESOLVED`.

**E2E de F1** (orden de los pasos 3 y 4): dos instancias con `GALERIA_DATA_DIR` distintos arrancan las dos; con el mismo, la segunda sale con código 0 en menos de 5 s y la primera recibe `second-instance`. Para que el `userData` de dos raíces de prueba no coincida, el override de 8.1 deriva `userData` del nombre de la raíz, no de su carpeta padre.

Y además:

- No se llama nunca a `crashReporter.start()`. Tampoco hay `autoUpdater` ni `electron-updater`.
- `Menu.setApplicationMenu(null)`. Los atajos los gestiona el renderer.
- **Protección de contenido** (D15): con la bóveda desbloqueada y `prefs.contentProtection = true` (valor por defecto), `win.setContentProtection(true)`. En Windows llama a `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, así que la ventana no aparece en capturas, grabaciones ni en Recall; según la documentación de Electron 44, el cambio se aplica en la siguiente composición del escritorio. En Linux no tiene efecto (límite 5 de 24.2). `prefs:set` con un `contentProtection` distinto lo aplica al momento. La ventana nueva que se crea al bloquear (13.3) nace sin protección, porque el selector de perfiles no muestra contenido de la bóveda.
- **Una sola referencia a la ventana**: `window.ts` exporta `getMainWindow()` y `replaceMainWindow()` (13.3). La comprobación del emisor del IPC (5.6), los eventos y los diálogos usan siempre la ventana actual.

### 5.3 Content Security Policy exacta (`src/main/security/csp.ts`)

Producción (cabecera HTTP en las respuestas de `app://bundle`, no en `<meta>`):

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' vault:; media-src vault:; font-src 'self'; connect-src 'self'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Desarrollo (`!app.isPackaged`, origen `http://127.0.0.1:5173`, fijado en `electron.vite.config.ts` y leído de `ELECTRON_RENDERER_URL`; la cabecera se inyecta con `webRequest.onHeadersReceived` solo en las respuestas de ese origen):

```
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' vault:; media-src vault:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5173; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`csp.ts` construye el `ws://` a partir del `host` y el `port` de `ELECTRON_RENDERER_URL`, no con un literal, para que no se desincronice si el puerto cambia en la configuración.

Por qué cada parte:

- `script-src 'self'` sin `unsafe-eval` ni `unsafe-inline`.
- `style-src 'unsafe-inline'` es necesario porque Radix (a través de `react-remove-scroll`) inyecta elementos `<style>`. El riesgo de inyectar CSS es bajo y no permite ejecutar código. Los estilos que Motion y React aplican por CSSOM no dependen de la CSP.
- No hay `data:` ni `blob:` (`assetsInlineLimit: 0`).
- `vault:` aparece solo en img/media.
- `connect-src 'self'` impide cualquier `fetch` externo.

El test E2E del scaffold comprueba que un `fetch('https://example.com')` desde el renderer falla.

### 5.4 Bloqueo de red y otros canales de salida (`src/main/security/network-guard.ts`)

1. **`webRequest.onBeforeRequest({ urls: ['<all_urls>'] })`** en `session.defaultSession`, en `session.fromPartition('galeria')` y en cualquier sesión creada después (`app.on('session-created')`). Se permiten:
   - los esquemas `app:` y `vault:`;
   - `devtools:` solo en desarrollo;
   - en desarrollo, el origen `http://127.0.0.1:5173` y `ws://127.0.0.1:5173` exactos (comparando `new URL(url).origin`, no prefijos de texto).

   Todo lo demás (http, https, ws, wss, ftp, file:, cualquier host, incluido 127.0.0.1 en otro puerto) se cancela con `{ cancel: true }`, que Chromium entrega como `net::ERR_BLOCKED_BY_CLIENT`. Se registra un `warn` con el esquema, nunca la URL completa, y se incrementa un contador por esquema (`{ http, https, ws, wss, file, other }`). Solo con `!app.isPackaged && process.env.GALERIA_E2E === '1'` el contador se expone como `globalThis.__galeriaNetBlocked` para que el E2E compruebe qué capa bloqueó.

   **Un solo listener por evento y sesión**: en Electron, registrar otro `onBeforeRequest` (u otro `onHeadersReceived`) en la misma sesión **sustituye** al anterior sin avisar, así que un cambio futuro podría desactivar el guard. ESLint lo impide con `no-restricted-properties` sin `object` (cubre `ses.webRequest.onBeforeRequest`, cuyo objeto no es un identificador simple, y el acceso con corchetes): `{ property: 'onBeforeRequest' }` prohibido en todo `src/` salvo `src/main/security/network-guard.ts`, y `{ property: 'onHeadersReceived' }` salvo `src/main/security/csp.ts`. Las dos excepciones se declaran con `overrides` por archivo en `eslint.config.mjs`.

   **Descargas** (defensa en profundidad de una línea, no requerida por el modelo de amenazas): en las mismas sesiones, `ses.on('will-download', (e) => { e.preventDefault(); log.warn('download.blocked'); })`. La app no descarga nada; no hay test específico.
2. **DNS, incluido el prefetch de DNS y el preconnect de Chromium**: el switch `host-resolver-rules` (5.2) hace fallar cualquier resolución de nombres. En desarrollo solo queda excluido `127.0.0.1`, que es un literal IP y no se resuelve. Además no se carga ningún contenido remoto que pueda disparar un prefetch.
3. **Navegación** (`navigation-guard.ts`, aplicado en `app.on('web-contents-created')` a todos los webContents):
   - `will-navigate` y `will-redirect`: `preventDefault()` si el origen destino no es el origen del renderer;
   - `will-frame-navigate` en subframes: siempre se deniega;
   - `setWindowOpenHandler(() => ({ action: 'deny' }))`;
   - `will-attach-webview`: `preventDefault()`.
4. **Permisos**: `setPermissionRequestHandler` y `setPermissionCheckHandler` solo conceden `'fullscreen'`. Cámara, micrófono, notificaciones, geolocalización, MIDI, portapapeles de lectura, HID, serie, USB y bluetooth se deniegan. `setDisplayMediaRequestHandler` deniega.
5. **WebRTC**. Sus conexiones (ICE/STUN/TURN) no son peticiones URL: `session.webRequest` no las ve, Chromium no les aplica `connect-src` y, con un literal IP (`turn:203.0.113.5:443?transport=tcp`), `host-resolver-rules` tampoco interviene. Un script del renderer (por ejemplo, una dependencia comprometida del bundle) podría sacar datos así. La app no usa WebRTC, y se cierra con tres capas:
   1. **Renderer** (`src/renderer/src/lockdown.ts` **[S]**, que `main.tsx` importa en **primer lugar**, así que se evalúa antes que React y cualquier otra dependencia):

      ```ts
      // APIs de red que no pasan por webRequest ni por la CSP. Las interfaces WebIDL son
      // propiedades configurables del objeto global, así que se pueden borrar.
      for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
                       'RTCSessionDescription', 'RTCIceCandidate'] as const) {
        delete (globalThis as Record<string, unknown>)[k];
      }
      ```

      ESLint: `no-restricted-globals` para `RTCPeerConnection` y `webkitRTCPeerConnection` en `src/renderer/**`. Esta capa no cubre un `<iframe>` `about:blank` creado por script (su ventana trae constructores nuevos y `frame-src` no bloquea `about:blank`); de eso se encargan las dos siguientes.
   2. **Política de IP de WebRTC** en todos los webContents (`app.on('web-contents-created')`): `contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`. Con ella Chromium no usa UDP salvo a través de un proxy que lo admita, y el TCP de ICE pasa por el proxy de la sesión.
   3. **Proxy inexistente** en `defaultSession`, `galeria` y cada sesión de `session-created`, antes de crear la ventana (`await` en el arranque):

      ```ts
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: 'socks5://127.0.0.1:9',               // puerto "discard": nada escucha ahí
        proxyBypassRules: devUrl ? '' : '<-loopback>',    // producción y E2E: ni siquiera 127.0.0.1 va directo
      });
      ```

      Cualquier tráfico de Chromium que escape a `webRequest` (incluido el TCP de WebRTC) acaba en un proxy local que no existe y falla. `<-loopback>` es la regla de Chromium que quita la excepción implícita de loopback: en producción el renderer solo usa `app:` y `vault:`, que no son red, y el servidor loopback de ffmpeg (18.5) lo usa ffmpeg, que es otro proceso y no pasa por Chromium. Con el servidor de desarrollo (`devUrl` definido) se deja la excepción implícita de loopback para que Vite y HMR sigan funcionando; esa diferencia solo existe sin empaquetar y con `ELECTRON_RENDERER_URL`. `webRequest` se evalúa antes que el proxy, así que el código `ERR_BLOCKED_BY_CLIENT` de la verificación sigue siendo el mismo. Un proceso local que escuchara en `127.0.0.1:9` haciéndose pasar por proxy es malware activo, fuera del modelo (5.1).
6. **Corrector ortográfico**: `spellcheck: false` y `ses.setSpellCheckerEnabled(false)`. En Linux, con el corrector activo, Chromium descargaría diccionarios Hunspell.
7. **Actualizaciones**: ninguna. En electron-builder, `publish: null`. No se instala `electron-updater`.
8. **DevTools**: desactivadas en producción (`devTools: !app.isPackaged`).
9. **`shell.openExternal` / `shell.openPath`**: prohibidos en todo `src/` con la regla ESLint `no-restricted-properties`.
10. **Red desde Node (main)**: `session.webRequest` no cubre los módulos de Node. Hay dos capas:
    - **ESLint** (en `src/main/**` y `src/preload/**`):
      - `no-restricted-imports` prohíbe `http`, `https`, `net`, `tls`, `dgram`, `dns`, `http2` y sus formas `node:`, salvo en `src/main/media/loopback-server.ts` (solo `node:http` para `createServer`, servidor entrante en 127.0.0.1, sección 18) y en `src/main/security/node-egress-guard.ts`;
      - `no-restricted-imports` prohíbe además `{ name: 'electron', importNames: ['net'] }` en todo `src/`;
      - `no-restricted-imports` prohíbe `child_process`/`node:child_process` salvo en `src/main/media/ffmpeg.ts`;
      - `no-restricted-globals` prohíbe `fetch`, `WebSocket`, `EventSource` y `XMLHttpRequest`;
      - en `src/renderer/**`, `no-restricted-globals` prohíbe `RTCPeerConnection` y `webkitRTCPeerConnection` (punto 5), y en todo `src/`, `no-restricted-properties` limita `onBeforeRequest` y `onHeadersReceived` a su archivo (punto 1).
    - **Guard en tiempo de ejecución** (`src/main/security/node-egress-guard.ts`, `installNodeEgressGuard()`, primera sentencia de `index.ts`). Cubre también el código de las dependencias, que ESLint no analiza:

      ```ts
      import net from 'node:net'; import dgram from 'node:dgram'; import dns from 'node:dns';
      const egressError = () => Object.assign(new Error('network disabled'), { code: 'EGALERIA_NET' });
      // Destino de Socket#connect: Node llama a connect() con los argumentos ya normalizados
      // (un array [opts, cb]) desde net.connect(), o con (opts) / (path) / (port, host) directamente.
      function connectPath(args: unknown[]): string | undefined {
        const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
        if (first && typeof first === 'object') {
          const p = (first as { path?: unknown }).path;
          return typeof p === 'string' ? p : undefined;
        }
        return typeof first === 'string' && !/^\d+$/.test(first) ? first : undefined;
      }
      export function installNodeEgressGuard(): void {
        globalThis.fetch = (() => Promise.reject(egressError())) as typeof fetch;
        for (const k of ['WebSocket', 'EventSource'] as const)
          Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false });
        const connect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
          if (connectPath(args) !== undefined) return connect.apply(this, args as never); // solo pipe/socket unix local
          throw egressError();                                                            // ninguna conexión TCP
        } as typeof connect;
        dgram.createSocket = (() => { throw egressError(); }) as never;
        const deny = () => { throw egressError(); };
        const denyAsync = () => Promise.reject(egressError());
        for (const k of Object.keys(dns) as (keyof typeof dns)[])
          if (k === 'lookup' || k === 'lookupService' || k === 'reverse' || k.startsWith('resolve'))
            (dns as Record<string, unknown>)[k] = deny;
        for (const k of Object.keys(dns.promises) as (keyof typeof dns.promises)[])
          if (k === 'lookup' || k === 'lookupService' || k === 'reverse' || k.startsWith('resolve'))
            (dns.promises as Record<string, unknown>)[k] = denyAsync;
        for (const R of [dns.Resolver.prototype, dns.promises.Resolver.prototype])
          for (const k of Object.getOwnPropertyNames(R))
            if (k === 'reverse' || k.startsWith('resolve')) (R as Record<string, unknown>)[k] = deny;
      }
      ```

      El guard falla cerrado: si alguna de estas asignaciones lanzara (por ejemplo, una propiedad no configurable en otra versión de Node), la excepción no se captura y la app no arranca. `dns.resolve*` se bloquea aparte porque c-ares abre sus propios sockets sin pasar por `dgram`. `tls.connect`, `http.request`, `http2.connect` y el `fetch` interno de Node (undici) acaban en `net.Socket.prototype.connect`, así que fallan con `EGALERIA_NET`. El servidor loopback es entrante (`listen`), y las tuberías de los procesos hijos (`stdio: 'pipe'`) crean el socket a partir de un handle, sin `connect`; ninguno de los dos se ve afectado.

      Orden de carga: Rollup coloca los `require()` de los módulos externos al principio del bundle CJS de main, así que se ejecutan antes que el guard. Ninguno abre conexiones al cargarse (argon2, SQLite y sharp no tienen red y exifr solo recibe buffers), y el guard parchea prototipos y objetos de módulo, que se consultan en el momento de cada llamada. Por eso el código de la app tampoco puede guardar referencias a esas funciones (lo impide la regla de ESLint).
    - **`electron.net`** (`net.fetch`, `net.request`) va por la pila de red de Chromium, no por Node: lo cubre el punto 1. El E2E lo comprueba con el contador (abajo). Si el E2E demostrara que `webRequest` no intercepta `net.fetch` (contador a 0), `installNodeEgressGuard()` sustituirá también `electron.net.fetch` y `electron.net.request` por funciones que rechazan, y esa variante se anotará aquí.
11. **ffmpeg y ffprobe**: siempre llevan `-protocol_whitelist`, que vale `file,pipe` cuando la entrada es un archivo local y `http,tcp,pipe` cuando la entrada es el loopback. Las URLs de entrada se construyen en código y siempre son `http://127.0.0.1:<puerto>/<token>/<ref>`.

**Verificación** (E2E del scaffold, `tests/e2e/smoke.spec.ts`, con `GALERIA_E2E=1`; el proceso del test levanta un servidor HTTP en `127.0.0.1:<p>` que cuenta las conexiones):

1. **Renderer**: `fetch('https://example.com')` se rechaza (CSP).
2. **Guard de webRequest, aislado**: `electronApp.evaluate(({ BrowserWindow }, url) => { const w = new BrowserWindow({ show: false, webPreferences: { partition: 'galeria', sandbox: true } }); return w.loadURL(url).then(() => 'loaded', (e) => e.code).finally(() => w.destroy()); }, 'http://127.0.0.1:<p>/')` devuelve `'ERR_BLOCKED_BY_CLIENT'`. `loadURL` desde main no pasa por `will-navigate` ni por la CSP, y `127.0.0.1` es un literal IP que no pasa por el resolver, así que ese código de error solo puede venir de `webRequest`. Además `__galeriaNetBlocked.http ≥ 1` y el servidor recibió 0 conexiones.
3. **`electron.net`**: `net.fetch('http://127.0.0.1:<p>/')` desde main se rechaza, el contador `http` vuelve a subir y el servidor recibe 0 conexiones.
4. **Node**: desde main, `fetch('http://127.0.0.1:<p>/')`, `process.getBuiltinModule('node:net').connect(<p>, '127.0.0.1')` y `process.getBuiltinModule('node:dns').promises.lookup('example.com')` fallan con `code === 'EGALERIA_NET'`, y el servidor recibe 0 conexiones. (`electronApp.evaluate` se ejecuta en el contexto global de main, donde `require` no existe; `process.getBuiltinModule` está en Node ≥ 22.3, y Electron 44 trae Node 24.)
5. **WebRTC**: `page.evaluate(() => [typeof RTCPeerConnection, typeof webkitRTCPeerConnection])` vale `['undefined', 'undefined']`. Después, el test levanta también un socket UDP en `127.0.0.1:<u>` que cuenta datagramas y, desde el renderer, crea un `<iframe>` vacío, toma `iframe.contentWindow.RTCPeerConnection` (si no existe, el caso ya está cubierto) y lo usa con `iceServers: [{ urls: 'turn:127.0.0.1:<p>?transport=tcp', username: 'u', credential: 'p' }, { urls: 'stun:127.0.0.1:<u>' }]`, `createDataChannel('x')`, `createOffer` y `setLocalDescription`, y espera 5 s. El servidor TCP recibe 0 conexiones y el socket UDP 0 datagramas. Si alguno recibe algo, el scaffold lo anota en `docs/PLAN.md` y este punto del diseño se reabre (R19); no se improvisa otra capa.

El unitario `tests/unit/main/node-egress-guard.test.ts` repite el punto 4 en Vitest (instala el guard en su propio worker) y comprueba además que `net.createServer().listen(0, '127.0.0.1')` sigue funcionando y que un `child_process.spawn(process.execPath, ['-e', 'process.stdout.write("ok")'])` sigue entregando su stdout.

### 5.5 Esquemas privilegiados (`src/main/protocol/schemes.ts`)

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'app',   privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true,
                                   stream: true, corsEnabled: true } },
]);
```

- `app://bundle/<ruta>` sirve `out/renderer` (dentro de app.asar) con `ses.protocol.handle('app', …)`.
  - Normaliza la ruta, rechaza `..`, separadores absolutos y bytes nulos, y solo acepta GET.
  - MIME por extensión (`.html .js .css .woff2 .svg .png .webp .json`). Cualquier otra devuelve 404.
  - Cabeceras: CSP (5.3), `X-Content-Type-Options: nosniff` y `Cache-Control: no-store`.
  - Así se evita cargar con `file://`, y el fuse `GrantFileProtocolExtraPrivileges` puede ir a `false` (20.2).
  - En desarrollo el renderer carga `ELECTRON_RENDERER_URL`.
- `vault://` se describe en la sección 11.
  - Se registra solo en la sesión `galeria`.
  - `corsEnabled` es necesario porque la presentación conecta los `<audio>` y `<video>` a Web Audio con `crossOrigin="anonymous"`, y desde un origen distinto (`app://bundle`) Chromium entrega silencio si la respuesta no es CORS. Por eso el handler responde `Access-Control-Allow-Origin: <origen del renderer>`.
  - No se pide `bypassCSP`.

### 5.6 Validación del IPC (`src/main/ipc/register.ts`)

Cada canal se registra con `handle(channel, schema, { requiresUnlock }, fn)`. El wrapper hace, en este orden:

1. **Emisor**: `event.sender.id === getMainWindow().webContents.id` (la ventana actual, que cambia al bloquear, 13.3) y `new URL(event.senderFrame.url).origin === rendererOrigin`. Si no coincide, devuelve `VALIDATION` y registra un `warn`.
2. **Payload**: `schema.safeParse(payload)` con esquemas zod estrictos (`.strict()`, sin claves extra). Los límites concretos están en 10.3. Si falla, `VALIDATION` con `details.path` del primer error, sin el valor.
3. **Desbloqueo**: si `requiresUnlock` y la sesión no está `unlocked`, devuelve `LOCKED`.
4. **Mantenimiento**: si la sesión está en el subestado `maintenance` (traslado de la bóveda, 8.7) y el canal no es uno de `vault:getInfo`, `vault:relocateCancel`, `session:lock`, `session:activity`, `session:setPlayback`, `session:getState` o los canales sin "U", devuelve `BUSY`.
5. Ejecuta `fn` y devuelve `Result<T>` (`{ ok: true, data }` o `{ ok: false, error }`). Los errores nunca se lanzan al renderer.
6. **Excepciones**: un `AppError` se convierte en `{ ok: false, error }`. Cualquier otra excepción se convierte en `INTERNAL` y se registra un `error` con `err.code` y `err.syscall` como mucho, nunca `err.message`, porque los mensajes de `fs` incluyen rutas y nombres de archivo.

El preload solo reenvía los canales de una allowlist (`INVOKE_CHANNELS`, `EVENT_CHANNELS`) derivada de `ipc-contract.ts`. El canal `import:paths` no está en la allowlist genérica: solo lo usa `importDropped(files)` (12.2).

**Versión del scaffold** (**[S]**): `register.ts` ya existe con los pasos 1, 2, 5 y 6 (emisor, zod, `Result` y excepciones) y se usa para registrar `app:getInfo` desde `ipc/handlers/app.ts`. La opción `requiresUnlock` y el paso 4 (`maintenance`) llegan en F1 con `SessionManager`; hasta entonces la firma ya acepta `{ requiresUnlock }` y el scaffold no registra ningún canal "U". `AppInfo.ffmpegAvailable` vale `false` en el scaffold y en F1, porque `media/ffmpeg.ts` llega en F2.

### 5.7 Qué protege y qué no

Protege: confidencialidad e integridad en reposo de todo el contenido de la bóveda (medios, miniaturas, nombres, fechas, EXIF, ediciones, playlists, qué música usa cada presentación), aislamiento entre perfiles y detección de manipulación, reordenación, truncado y extensión de los archivos cifrados.

No protege, y se documenta dentro de la app (sección 24):

- los restos forenses de los originales;
- la RAM mientras la bóveda está desbloqueada (y lo que pueda acabar en pagefile o swap);
- los metadatos visibles: número de archivos, tamaños, fechas de modificación de los archivos cifrados y la lista de perfiles;
- el malware y los keyloggers;
- copias antiguas de `profiles.json` combinadas con la contraseña antigua (6.6);
- **la restauración de copias antiguas**: si alguien sustituye `library.db` (o `profiles.json`) por una copia anterior del mismo perfil, por ejemplo de una copia de seguridad, se abre con la misma clave y revierte su contenido (nombres, playlists, ediciones) sin aviso. No hay contador anti-reversión; se acepta y se documenta (límite 7 de 24.2);
- la música, los avatares personalizados, los ajustes y las preferencias, que se guardan sin cifrar por decisión del usuario;
- lo que el propietario saca a propósito de la ventana con la sesión iniciada (arrastrar, copiar y pegar), fuera de alcance por decisión del usuario (5.1).

---

## 6. Criptografía

Primitivas: todas de `node:crypto` (OpenSSL 3.5 en Node 26 y la equivalente en Electron 44), salvo Argon2id (`@node-rs/argon2`) y el cifrado de páginas de SQLCipher (SQLite3MultipleCiphers).

- AES-256-GCM con tag de 16 bytes y nonce de 12 bytes. Siempre `createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })` y `createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })`, con `authTagLength` explícito también al descifrar: Node desaconseja aceptar tags de longitud implícita (DEP0182) y así un tag truncado nunca valida.
- HKDF-SHA256 (`crypto.hkdfSync`).
- HMAC-SHA256.
- SHA-256.
- `crypto.randomFillSync` para claves, sales, nonces e ids.

### 6.1 Derivación de la contraseña: Argon2id

- **Entrada**: la contraseña llega del renderer como `Uint8Array`, ya normalizada a NFC y codificada en UTF-8 (`TextEncoder`). Main exige entre 8 y 1024 bytes; la UI exige además al menos 8 code points (10.3).
- **Llamada**: `hashRaw(passwordBytes, { algorithm: 2 /* Argon2id */, version: 1 /* V0x13 */, memoryCost, timeCost, parallelism, outputLen: 32, salt })`. Se usan literales numéricos porque `Algorithm` y `Version` son `const enum` ambientales y no se pueden usar con `isolatedModules`.
- **Sal**: 16 bytes aleatorios. Se genera una nueva en cada creación de perfil y en cada cambio de contraseña.
- **Parámetros objetivo**: `m = 262144 KiB (256 MiB)`, `t = 3`, `p = 4`.

Por qué estos parámetros: la amenaza principal es la fuerza bruta offline de alguien que tiene `profiles.json`. El RFC 9106 recomienda Argon2id con p=4, y con 256 MiB cada intento es caro en GPU sin dejar sin memoria a equipos de 4 GB. El desbloqueo es poco frecuente, así que 0,5–1,5 s por intento son aceptables.

**Memoria real (medida el 22-oct-2026)**: `memoryCost` de `@node-rs/argon2` 2.2.2 es la memoria **total**, como en el RFC 9106, aunque su `index.d.ts` diga "each thread will have a memory pool of this size". En esta máquina (12 hilos, 15 GiB, Node 26.10.0), el pico de RSS (`process.resourceUsage().maxRSS`) sube 256 MiB con `m = 256 MiB, t = 3, p = 1` y 257 MiB con `p = 4`; con 128 MiB y 64 MiB sube 129 y 65 MiB. Tiempos con `p = 4`: 255 ms (256 MiB, t=3), 143 ms (128 MiB) y 70 ms (64 MiB). Con esos datos, la calibración de esta máquina elige `m = 256 MiB, t = 8, p = 4`, unos 0,68 s. El test "lento" de F1 repite la medición de memoria y falla si el delta supera 1,5 × m, para detectar un cambio de semántica en una versión futura.

**Calibración por máquina** (sí, al crear el perfil y al cambiar la contraseña), en `kdf.ts`:

1. Mide el tiempo de `(m=256 MiB, t=3, p=4)` con una contraseña y una sal aleatorias de prueba.
2. Si tarda más de 1,5 s, prueba en orden `(256 MiB, t=2)`, `(128 MiB, t=3)`, `(128 MiB, t=2)` y `(64 MiB, t=3)`, y se queda con el primero que baje de 1,5 s. `(64 MiB, t=3, p=4)` es el suelo: si ni así baja de 1,5 s, se usa igualmente. Nunca se baja de ahí.
3. Si `(256 MiB, t=3)` tarda menos de 0,5 s, sube `t` a `t = min(8, max(3, ceil(3 × 0,75 / medido_s)))`, sin cambiar `m`, donde `medido_s` es el tiempo medido en segundos y 0,75 s es el objetivo. Ejemplo: con 0,255 s, `ceil(8,82) = 9`, limitado a 8.
4. Los parámetros elegidos se guardan en el perfil (`kdf` en `profiles.json`). El desbloqueo usa siempre los guardados. La calibración dura unos 1–4 s y la UI muestra "Preparando tu bóveda…".

Fallos: si la reserva de memoria falla (error de la librería), se reintenta el siguiente candidato más ligero. Si falla también el suelo, se devuelve `INTERNAL` con `details.reason = 'kdf-memory'` y se registra un `error`.

### 6.2 Clave maestra y envoltura con la KEK

- `KEK = Argon2id(contraseña, sal, params)`, de 32 bytes.
- `MK` (clave maestra) son 32 bytes aleatorios generados al crear el perfil. No cambia nunca.
- Envoltura: AES-256-GCM con `key = KEK`, `nonce = 12 bytes aleatorios` (nuevos en cada envoltura) y plaintext `MK`.

```
AAD_mk = utf8("galeria/v1/mk-wrap") || 0x00 || profileId (16 bytes crudos)
         || utf8("argon2id$v=19$m=<m>,t=<t>,p=<p>") || 0x00 || salt (16 bytes)
```

`<m>`, `<t>` y `<p>` se escriben en decimal ASCII sin ceros a la izquierda ni signo (`m=262144,t=8,p=4`). La AAD liga la envoltura al perfil y a sus parámetros. Si se editan los parámetros o se copia la envoltura a otro perfil, el tag no valida.

Se guarda en `profiles.json` como `masterKeyWrap { alg: "A256GCM", nonce, ciphertext (32 B), tag (16 B) }`, todo en base64.

### 6.3 Jerarquía de claves

```
contraseña ──Argon2id(sal, m,t,p)──▶ KEK ──AES-GCM unwrap──▶ MK (32 B, aleatoria)
MK ──HKDF-SHA256(salt = profileId 16 B, info = …, L = 32)──▶
   ├─ "galeria/v1/db"         → K_db    clave cruda SQLCipher (sección 9)
   ├─ "galeria/v1/file-wrap"  → K_wrap  envuelve la DEK de cada objeto cifrado (originales y miniaturas)
   └─ "galeria/v1/dedup"      → K_dedup HMAC-SHA256 del contenido original (duplicados)
Por objeto: DEK = 32 B aleatorios, envuelta con K_wrap en la cabecera del archivo (sección 7)
```

No existen claves "de miniatura" aparte. Las miniaturas son objetos con su propia DEK aleatoria, con `kind = 2` autenticado en la cabecera, y se envuelven con K_wrap igual que los originales. La separación de dominios viene del campo `kind`, que está autenticado, y de que cada objeto tiene una DEK distinta.

### 6.4 Decisión: claves por archivo aleatorias y envueltas (no derivadas por HKDF)

Se elige una DEK aleatoria por objeto, guardada envuelta en su cabecera.

| Criterio | DEK aleatoria envuelta (elegida) | DEK = HKDF(MK, fileId) |
|---|---|---|
| Reutilizar un id o reescribir un objeto | Inofensivo: cada escritura genera una DEK nueva, así que nunca se repite (clave, nonce) | Catastrófico si un id se reescribe: misma clave y mismos nonces |
| Nonces deterministas por chunk | Seguros, porque la clave es única por objeto | Solo seguros si el id nunca se reutiliza, y eso depende de disciplina |
| Coste | 60 bytes de cabecera por archivo | 0 bytes |
| Borrado criptográfico | Sobrescribir los 108 bytes de cabecera deja el objeto ilegible aunque el resto siga en el disco (best-effort, en SSD no está garantizado) | No aplica |
| Cambio de contraseña | No toca los archivos (igual en las dos) | Igual |

Invariante: los objetos son de escritura única. `object-writer.ts` genera la DEK internamente y nunca la acepta como parámetro. `object-store.ts` nunca abre un objeto existente para escribir. Las ediciones generan una miniatura nueva con id nuevo.

### 6.5 Verificación de la contraseña

No hay verificador aparte, como un hash guardado. La contraseña es correcta si y solo si el desenvolvimiento AES-GCM de `masterKeyWrap` valida el tag. Si falla, se devuelve `WRONG_PASSWORD`, con el mismo tiempo de respuesta aproximado (domina Argon2) y un log `info` sin datos. No se añade limitación de intentos en la UI: cada intento ya cuesta lo que tarda Argon2 (unos 0,5–1,5 s), y un atacante offline no pasaría por la UI. Tras desenvolver, se abre la DB con K_db. Si SQLCipher rechaza la clave con la contraseña correcta, el error es `VAULT_CORRUPT`.

### 6.6 Cambio de contraseña (solo se vuelve a envolver)

1. Desenvolver `MK` con la contraseña actual. Si falla, `WRONG_PASSWORD`.
2. Calibrar (6.1), generar sal nueva y derivar `KEK'`.
3. Envolver `MK` con `KEK'` y un nonce nuevo.
4. Escribir `profiles.json` y `profiles.json.bak` de forma atómica (8.3). Los dos quedan con la envoltura nueva, para que no quede en la app ninguna copia con la contraseña antigua.
5. Poner a cero la KEK, la KEK', la contraseña antigua y la nueva.

Es instantáneo: la DB y los objetos no se tocan.

Límite documentado: la MK no cambia. Quien tenga una copia antigua de `profiles.json` (de un backup, o restos en el SSD) y conozca la contraseña antigua puede seguir obteniendo la MK. Rotar la MK obligaría a recifrar toda la bóveda y queda fuera de alcance. Se explica en la Ayuda.

### 6.7 KeyRing y puesta a cero (`keys.ts`, `secure-buffer.ts`)

`KeyRing` vive solo en `SessionManager` y contiene `MK`, `K_db`, `K_wrap` y `K_dedup`. Ninguno sale de `Buffer.allocUnsafe`, que usa el pool compartido:

- **MK**: la salida de `decipher.update(ciphertext)` se copia a un `Buffer.alloc(32)` propio y después se pone a cero (`fill(0)`); `decipher.final()` no devuelve bytes.
- **K_db, K_wrap, K_dedup**: `Buffer.from(hkdfSync('sha256', MK, salt, info, 32))`. `hkdfSync` devuelve un `ArrayBuffer` propio y `Buffer.from(arrayBuffer)` lo envuelve sin copiarlo, así que `fill(0)` borra la única copia que maneja JS.
- **DEKs**: igual que la MK (copia a `Buffer.alloc(32)` y puesta a cero de la salida de `update`). Hay una caché LRU de DEKs desenvueltas (máximo 64 entradas) que usan el protocolo y el loopback.

Al bloquear (paso 4 de 13.3, síncrono y sin esperar a los trabajos):

- se cierra la DB, y SQLite3MultipleCiphers libera y limpia su contexto de clave;
- `zeroize()` hace `fill(0)` en las cuatro claves y en todas las DEKs de la LRU, y suelta las referencias;
- `SessionManager` registra todos los `ObjectWriter` y `ObjectReader` abiertos (7.7) y llama a `destroyKeys()` de cada uno, que pone a cero **de forma síncrona** la DEK propia del objeto (la del writer, o la de un reader abierto sin caché, como la verificación del paso 3 de 12.4) y lo marca como muerto: cualquier `write()`/lectura posterior rechaza con `LOCKED`. Cerrar sus descriptores y borrar los `.part` ocurre después, en segundo plano (13.3, paso 6);
- se ponen a cero los buffers de contraseña y KEK en cuanto dejan de usarse, también en las rutas de error.

Límites en JS/V8 (documentados):

- el GC puede haber movido o copiado buffers antes de ponerlos a cero;
- los strings son inmutables y no se pueden borrar, y la contraseña existe como string en el `<input>` del renderer;
- OpenSSL copia la clave a su contexto (`EVP_CIPHER_CTX`, y el de `createHmac` con K_dedup) y la limpia al liberarlo, pero eso ocurre cuando el GC recoge el objeto; un trabajo abortado a mitad de un `await` suelta sus contextos al terminar su limpieza;
- no hay `mlock`, así que la memoria puede acabar en pagefile o swap;
- `db.key()` recibe un `Buffer` que se pone a cero justo después (9.1).

Mitigaciones adicionales:

- al bloquear se sustituye la ventana por una nueva (13.3): el proceso del renderer anterior termina, con su heap, las imágenes decodificadas y los búferes de vídeo;
- `sharp.cache(false)` (12.4, paso 4): libvips no guarda en su caché de operaciones imágenes descifradas entre llamadas.

---

## 7. Formato de archivo cifrado (objetos y miniaturas), versión 1

### 7.1 Constantes

`MAGIC = "GALV"` (0x47 0x41 0x4C 0x56), `VERSION = 1`, `HEADER_LEN = 108`, `CHUNK = 65536` (64 KiB de plaintext), `TAG = 16`, `CHUNK_CT = CHUNK + TAG = 65552`, `MAX_PLAINTEXT = 2^40` bytes (1 TiB). Todos los enteros van en big-endian.

### 7.2 Cabecera (108 bytes, en claro pero autenticada)

| Offset | Long. | Campo | Valor y validación al leer |
|---|---|---|---|
| 0 | 4 | magic | `GALV`; si no, `INTEGRITY` |
| 4 | 1 | version | `1`; si no, `INTEGRITY` (versión desconocida) |
| 5 | 1 | kind | `1` = medio almacenado, `2` = miniatura; tiene que coincidir con lo esperado |
| 6 | 2 | flags | `0x0000` en v1; cualquier bit activo da `INTEGRITY` |
| 8 | 4 | chunkSize | `65536`; cualquier otro valor da `INTEGRITY` |
| 12 | 8 | plaintextSize | `P`, entre 0 y 2^40 |
| 20 | 16 | fileId | id del objeto (= nombre del archivo); tiene que coincidir con el id pedido |
| 36 | 12 | nonceBase | aleatorio |
| 48 | 12 | wrapNonce | aleatorio |
| 60 | 32 | wrappedDek | `AES-256-GCM(K_wrap, wrapNonce, DEK, AAD = header[0..48))` |
| 92 | 16 | wrapTag | tag de la envoltura |

**Autenticación de la cabecera**: la AAD de la envoltura de la DEK son los 48 primeros bytes (de magic a nonceBase). Cambiar cualquier bit de la cabecera hace fallar el desenvolvimiento: los campos 0–47 por la AAD, `wrapNonce`/`wrappedDek`/`wrapTag` por el propio GCM. La cabecera se escribe al final del cifrado (en la posición 0, con el archivo abierto en `r+`), porque `P` no se conoce hasta terminar cuando el origen es un stream (ffmpeg). Mientras tanto, los 108 bytes son cero y el archivo es un `.part` en `tmp/`.

### 7.3 Chunks

- `n = (P == 0) ? 1 : ceil(P / CHUNK)`. Un archivo vacío tiene un único chunk final de 0 bytes más el tag, así que truncarlo entero también se detecta.
- El chunk `i` (0 ≤ i < n) tiene `len_i = CHUNK` si `i < n−1`, y `len_{n−1} = P − (n−1)·CHUNK`, que vale CHUNK cuando P es múltiplo exacto (no se añade un chunk vacío extra).
- Offset del chunk `i` en el archivo: `off_i = HEADER_LEN + i · CHUNK_CT`. Ocupa `len_i + TAG` bytes (ciphertext seguido del tag).
- Tamaño total del archivo: `L = HEADER_LEN + P + TAG · n`.
- **Nonce** del chunk `i`: `nonce_i = nonceBase XOR (0x00000000 ‖ uint64_be(i))`, es decir, un XOR sobre los bytes 4..11.
- **AAD** del chunk `i` (25 bytes): `fileId (16) ‖ uint64_be(i) (8) ‖ final (1)`, donde `final = 0x01` si `i == n−1` y `0x00` en los demás.
- Cifrado: `AES-256-GCM(DEK, nonce_i, AAD_i, plaintext_i)` con `authTagLength: 16`, que produce `ciphertext_i ‖ tag_i`.

**Por qué los nonces son únicos**: cada objeto tiene una DEK aleatoria de 256 bits que no se reutiliza nunca (6.4). Dentro de un objeto, `i ↦ nonce_i` es inyectiva (XOR con una base fija), así que cada par (DEK, nonce) se usa una sola vez. Un objeto tiene como mucho 2^24 chunks, muy por debajo de 2^64. La envoltura de las DEKs usa nonces aleatorios de 96 bits bajo K_wrap, una vez por objeto. El límite recomendado por NIST son 2^32 envolturas por clave y la app prevé ≤ 10^6 objetos por bóveda. Cada envoltura de la MK usa una KEK nueva, porque la sal cambia.

### 7.4 Detección de ataques

| Ataque | Cómo se detecta |
|---|---|
| Modificar bytes de un chunk | El tag GCM del chunk falla |
| Reordenar chunks dentro del archivo | La AAD incluye `i` y el tag falla |
| Mover un chunk de otro archivo | Otra DEK, así que el tag falla |
| Truncar al final | `L` de disco ≠ `HEADER_LEN + P + 16n` (se comprueba al abrir), y además el último chunk presente no lleva `final = 1`, así que el tag falla |
| Extender (añadir bytes o chunks) | El tamaño en disco ≠ `L`. Aunque se ignorase el tamaño, un chunk `n` no existe en el esquema y el chunk `n−1` ya lleva `final` |
| Cambiar `P` en la cabecera | La AAD de la envoltura cubre `P`, así que el desenvolvimiento falla |
| Intercambiar archivos (renombrar el objeto A como B) | `fileId` de la cabecera (autenticado) ≠ id pedido |
| Cambiar `kind` (servir una miniatura como original) | `kind` está autenticado y se compara con el esperado |

Cualquiera de estos fallos produce un `AppError('INTEGRITY')`, que el protocolo devuelve como 500 (11.4), y un log `warn` con el `mediaId`. El lector nunca entrega plaintext de un chunk sin haber verificado antes su tag.

### 7.5 Lectura aleatoria (Range → chunks)

Para un rango de plaintext `[a, b]` (inclusivo, `0 ≤ a ≤ b < P`):

```
i0 = floor(a / CHUNK)            i1 = floor(b / CHUNK)
leer del archivo: desde off_i0 hasta off_i1 + len_i1 + TAG  (lecturas por chunk, en streaming)
para cada i en [i0, i1]: descifrar y verificar chunk i
  recorte inicial (solo i0): desde a − i0·CHUNK
  recorte final   (solo i1): hasta b − i1·CHUNK (inclusivo)
```

### 7.6 Ejemplo resuelto

Con `P = 150000` bytes, `n = ceil(150000 / 65536) = 3`, y los chunks miden 65536, 65536 y 18928. Tamaño del archivo: `L = 108 + 150000 + 3·16 = 150156`.

| Chunk | off_i | bytes en disco | final |
|---|---|---|---|
| 0 | 108 | 65552 | 0 |
| 1 | 65660 | 65552 | 0 |
| 2 | 131212 | 18944 (termina en 150156) | 1 |

Range `bytes=70000-140000`, que son 70001 bytes:

- `i0 = 1` (70000 / 65536 = 1,07), `i1 = 2` (140000 / 65536 = 2,14).
- Se leen el chunk 1 (offset 65660, 65552 bytes) y el chunk 2 (offset 131212, 18944 bytes).
- Del chunk 1 descifrado se toma desde `70000 − 65536 = 4464` hasta el final, que son 61072 bytes.
- Del chunk 2 se toma `[0, 140000 − 131072] = [0, 8928]`, que son 8929 bytes.
- Total: 61072 + 8929 = 70001 bytes. Cuadra.
- Respuesta: `206`, `Content-Range: bytes 70000-140000/150000`, `Content-Length: 70001`.

Nonce del chunk 2 con `nonceBase = 00112233 44556677 8899AABB`: `nonce_2 = 00112233 44556677 8899AAB9`. El XOR con `…00000002` solo cambia el último byte, `BB ⊕ 02 = B9`.

### 7.7 API de los módulos

```ts
// object-writer.ts
createObjectWriter(opts: { kind: 1 | 2; fileId: Buffer; kWrap: Buffer; tmpPath: string;
                           hmacKey?: Buffer /* solo originales */; signal?: AbortSignal }): ObjectWriter
interface ObjectWriter {
  write(data: Buffer): Promise<void>;      // acumula, cifra cada chunk completo; retiene el último hasta saber si es final
  finish(): Promise<{ plaintextSize: number; sha256: Buffer; hmac: Buffer | null }>; // escribe el último chunk con final=1, la cabecera en offset 0, fsync, close; pone la DEK a cero
  abort(): Promise<void>;                  // pone la DEK a cero (síncrono) + close + unlink del .part (nunca lanza)
  destroyKeys(): void;                     // síncrono: DEK a cero y writer muerto (13.3, paso 4); el .part lo borra abort() después
}
// El evento 'abort' de opts.signal llama a destroyKeys() de forma síncrona. Mientras finish() no ha
// escrito la cabecera, el .part tiene los 108 primeros bytes a cero (sin DEK envuelta): es ilegible
// y basta con unlink. Tras finish(), su borrado es el criptográfico de 12.10.
// object-reader.ts
openObject(path: string, expected: { fileId: Buffer; kind: 1 | 2 }, kWrap: Buffer,
           dekCache?: DekCache): Promise<ObjectReader>  // valida la cabecera, desenvuelve la DEK y comprueba el tamaño L con fstat
interface ObjectReader {
  readonly plaintextSize: number;
  createReadStream(start: number, endInclusive: number): Readable; // verifica chunk a chunk
  readAll(): Promise<Buffer>;              // solo para fotos ≤ 256 MiB y miniaturas
  destroyKeys(): void;                     // síncrono: suelta o pone a cero su DEK; las lecturas pendientes fallan con LOCKED
  close(): Promise<void>;
}
```

Errores del writer: `ENOSPC` da `DISK_FULL`; otros errores de E/S dan `IO`. En los dos casos se llama a `abort()` automáticamente y el `.part` se borra. Errores del reader: `ENOENT` da `NOT_FOUND`, la validación da `INTEGRITY` y el resto `IO`.

---

## 8. Layout en disco

### 8.1 Rutas base (`src/main/app-paths.ts`)

| Qué | Windows | Linux |
|---|---|---|
| `userData` de Chromium (`app.setPath('userData', …)` antes de `ready`) | `%LOCALAPPDATA%\Galeria\electron` | `${XDG_CONFIG_HOME:-~/.config}/Galeria/electron` |
| Raíz de datos `GaleriaData` | `%LOCALAPPDATA%\Galeria\GaleriaData` | `${XDG_DATA_HOME:-~/.local/share}/Galeria/GaleriaData` |

Razones:

- Se usa `Local` y no `Roaming` para que los perfiles móviles de Windows no sincronicen gigas de medios.
- El nombre de carpeta es ASCII (`Galeria`), aunque `productName` sea "Galería", para no añadir otro carácter no ASCII a rutas que ya lo tienen (el usuario de Windows es `AlbertoVázquezAguila`).
- `%LOCALAPPDATA%` sale de `process.env.LOCALAPPDATA`; si no existe, de `join(app.getPath('home'), 'AppData', 'Local')`.

**Override**: si existe la variable de entorno `GALERIA_DATA_DIR` y es una ruta absoluta, pasa a ser la raíz de datos y `userData` pasa a `<GALERIA_DATA_DIR>.electron` (carpeta hermana con el mismo nombre más el sufijo, para que dos raíces de prueba de la misma carpeta padre no compartan `userData` ni el lock de instancia única, 5.2). Si no es absoluta, se ignora y se registra un `warn`. La usan Vitest y Playwright para aislar los datos, y también vale en builds empaquetados porque no es una frontera de seguridad. Al arrancar se registra un `info` "override activo", sin la ruta.

```
GaleriaData/
├─ profiles.json            lista de perfiles (en claro): nombre, avatar, KDF, sal, MK envuelta
├─ profiles.json.bak        copia idéntica (8.3)
├─ settings.json            ajustes globales (en claro)
├─ prefs/<profileId>.json   preferencias de UI por perfil (en claro)
├─ avatars/<profileId>.webp avatar personalizado (en claro, 256×256, sin metadatos)
├─ logs/main.log[.1|.2]     log rotado (1 MiB × 3), sin datos de contenido (21.2)
├─ vaults/<profileId>/      bóveda en la ubicación por defecto (8.5)
└─ vaults/<profileId>.creating/  solo mientras se crea un perfil (14.4); se borra al arrancar si quedó de una caída
```

### 8.2 `profiles.json`

Esquema (zod en `profile-store.ts`):

- `formatVersion`: 1.
- `profiles`: máximo 10 perfiles.
- Cada perfil:
  - `id`: 32 hex.
  - `name`: 1–40 caracteres, NFC, sin caracteres de control, único sin distinguir mayúsculas ni acentos.
  - `avatar`: `{ type: "builtin", id }` o `{ type: "custom", rev }`.
  - `createdAt`: ISO-8601.
  - `vault`: `{ location: "default", pendingCleanup? }` o `{ location: "custom", path, pendingCleanup? }`.
    - `path` es la ruta absoluta de **la carpeta que contiene `vault.json`**, incluido el último segmento `Galeria-<id[0..8]>` cuando la creó el traslado (8.7). Con `location: "default"` la carpeta es `GaleriaData/vaults/<id>` y no se guarda.
    - `pendingCleanup` (opcional) es la ruta absoluta de una bóveda antigua que un traslado dejó por borrar (8.7, paso 8). Se borra con `removeVaultDir` (8.5.1) al arrancar o al desbloquear, y el campo desaparece cuando el borrado termina.
    - Ninguna de las dos rutas está autenticada (el archivo va en claro). Por eso la app nunca hace un borrado recursivo sobre ellas sin pasar por `removeVaultDir`.
  - `kdf`: `alg = "argon2id"`, `version = 19`, `memoryKiB` entre 8192 y 1048576, `iterations` entre 1 y 8, `parallelism` entre 1 y 4, `salt` de 16 B en base64. El esquema admite valores bajos para los tests (23.2). El suelo de producción (64 MiB, t=3, p=4) lo impone la calibración (6.1), no el esquema. Editar los parámetros a mano no sirve de nada, porque están en la AAD de la envoltura (6.2).
  - `masterKeyWrap`: `alg = "A256GCM"`, `nonce` (12 B), `ciphertext` (32 B), `tag` (16 B).

```json
{
  "formatVersion": 1,
  "profiles": [
    {
      "id": "3fa9c2d41b7e4f0a9c8d2e1f00a1b2c3",
      "name": "Alberto",
      "avatar": { "type": "builtin", "id": "aurora" },
      "createdAt": "2026-10-22T15:04:05.000Z",
      "vault": { "location": "default" },
      "kdf": {
        "alg": "argon2id", "version": 19,
        "memoryKiB": 262144, "iterations": 3, "parallelism": 4,
        "salt": "q8Jm2kq6T1yW0Q3r9mVb1w=="
      },
      "masterKeyWrap": {
        "alg": "A256GCM",
        "nonce": "m5x8YVb0c2k1QW9x",
        "ciphertext": "pQ0aGm1u9B2y7J0dQe8v3n6h0Lk2sX1y4rT6wE9uI0o=",
        "tag": "Zk3mQ9w1e2r3t4y5u6i7oA=="
      }
    }
  ]
}
```

En `profiles.json` no se guarda ni la preferencia de tema ni ningún dato de uso, como "último perfil usado". Las preferencias van en `prefs/`.

### 8.3 Escritura atómica de JSON (`settings-store.ts`, `profile-store.ts`)

`writeJsonAtomic(path, obj)`:

1. Serializa y valida contra su propio esquema zod.
2. Escribe `<path>.tmp-<8 hex>` con `fsync`.
3. `rename` sobre `<path>` (en Windows, Node reemplaza el destino). Hasta 5 reintentos con backoff de 50 ms ×2 si da `EPERM`/`EBUSY` (antivirus).
4. En Linux, `fsync` del directorio. En Windows no se puede abrir un directorio para fsync y se omite.

Para `profiles.json` se repite exactamente con el mismo contenido sobre `profiles.json.bak`, así que el `.bak` nunca contiene envolturas antiguas.

Lectura de `profiles.json`:

- si `profiles.json` es inválido, se usa el `.bak` y se reescribe el principal, con un log `warn`;
- si los dos son inválidos, se devuelve `VAULT_CORRUPT`. La UI muestra "Los datos de perfiles están dañados" y no escribe nada, para no destruir información que se pueda recuperar a mano;
- si no existe ninguno, es el primer arranque y la lista está vacía.

### 8.4 `settings.json` y `prefs/<profileId>.json`

```json
// settings.json (global; tema del selector de perfiles)
{ "formatVersion": 1, "pickerThemeId": "fotos", "colorScheme": "system",
  "window": { "width": 1280, "height": 800, "x": 120, "y": 80, "maximized": false } }
```

```json
// prefs/<profileId>.json (se aplica tras desbloquear; null = heredar el global)
{ "formatVersion": 1, "themeId": null, "colorScheme": null,
  "autoLockMinutes": 5, "contentProtection": true, "gridSize": "medium",
  "gallerySort": { "field": "captured", "dir": "desc" },
  "presentationDefaults": {
    "transition": "fade", "randomPool": ["fade", "slide", "zoom", "kenburns"],
    "transitionMs": 700, "slideMs": 5000, "loop": true, "startFullscreen": true,
    "audioMode": "video", "musicEnabled": false, "musicVolume": 0.7, "videoVolume": 1.0,
    "musicFadeMs": 1500
  } }
```

`presentationDefaults` no incluye qué pistas de música se usan: eso va en la DB cifrada (tabla `kv`, clave `presentation.defaultTracks`). `contentProtection` es la decisión D15 (5.2). Si un JSON es inválido, se usan los valores por defecto, se reescribe y se registra un `warn`.

### 8.5 Estructura de una bóveda

```
<vaultDir>/                      = GaleriaData/vaults/<profileId>/  o  vault.path (8.2), p. ej. E:\Fotos\Galeria-3fa9c2d4\
├─ vault.json                    { "formatVersion": 1, "profileId": "<32 hex>", "createdAt": "<ISO>" } (en claro)
├─ library.db (+ -wal, -shm)     SQLCipher (sección 9); library.db.bak-v<n> solo durante una migración (9.3)
├─ objects/<aa>/<mediaId>        originales cifrados, sin extensión; aa = 2 primeros hex del id
├─ thumbs/<aa>/<thumbId>         miniaturas cifradas (WebP dentro)
├─ tmp/<32 hex>.part             solo ciphertext en curso; se vacía al desbloquear
└─ music/<trackId>.<ext>         música en claro (decisión del usuario); music/<trackId>.<ext>.part durante la copia (8.6.1)
```

- Ids: 16 bytes aleatorios en hex minúscula (`crypto.randomBytes(16)`). No guardan relación con el nombre ni con el contenido.
- Sharding: 256 subcarpetas, unos 400 archivos por carpeta para 100 000 objetos.
- Las carpetas se crean al crear el perfil (14.4) y las `aa` bajo demanda.

#### 8.5.1 `removeVaultDir(dir, profileId, mode)` (`vault/vault-layout.ts`)

Es la **única** función que puede borrar una bóveda o una carpeta de bóveda a medio crear o a medio copiar. La usan borrar un perfil (14.4), limpiar `vaults/*.creating` al arrancar (14.4), cancelar o terminar un traslado (8.7) y `pendingCleanup` (8.2). `mode` es `'vault'` (por defecto), `'creating'` o `'relocate-partial'`.

1. `lstat(dir)` tiene que ser un directorio, no un enlace simbólico ni una junction (`isSymbolicLink()` falso; en Windows, además, sin el atributo de reparse point, que Node expone como enlace simbólico en `lstat`). Si no, no se borra nada.
2. **Prueba de identidad**:
   - `'vault'` y `'creating'`: `vault.json` existe, valida con su esquema zod y `profileId` coincide. En `'creating'`, si `vault.json` no existe, solo se permite el paso 4 sobre subcarpetas vacías y archivos `vault.json.tmp-*` (el flujo de creación escribe `vault.json` antes que nada).
   - `'relocate-partial'`: existe el marcador `.galeria-relocate-<jobId>` del trabajo actual (8.7) y, si ya se copió `vault.json` (es lo primero que se copia), coincide en `profileId`.
   - Si la prueba falla, no se borra nada y se devuelve `{ removed: false, leftoverPath: dir }`.
3. Nunca se borra `dir` si es la bóveda **actual** del perfil (ruta resuelta con `realpath` igual a la de `profiles.json`), salvo en el borrado del perfil, que ya quitó la entrada antes (14.4).
4. Se borran solo las entradas conocidas de primer nivel: `vault.json`, `vault.json.tmp-*`, `library.db`, `library.db-wal`, `library.db-shm`, `library.db.bak-v*`, `objects/`, `thumbs/`, `tmp/`, `music/` y `.galeria-relocate-*`. Antes de borrar cada subárbol se repite el `lstat` (no puede ser un enlace) y se usa `fs.rm(sub, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })`. Dentro de esos subárboles solo puede haber archivos de la app.
5. `fs.rmdir(dir)` no recursivo. Si quedan entradas desconocidas, se dejan y se devuelve `{ removed: false, leftoverPath: dir }` con un `warn` (`vault.remove.leftover`).

Test (F1, `tests/unit/main/vault-layout.test.ts`): con un `profiles.json` cuyo `vault.path` apunta a una carpeta con archivos ajenos (sin `vault.json`, con un `vault.json` de otro perfil, o con un `vault.json` correcto más archivos ajenos), borrar el perfil no toca ningún archivo ajeno; con una junction o un enlace simbólico como `dir` o como `objects/`, no se borra nada a través del enlace.

### 8.6 Carpeta de música: por perfil (decisión)

La música va en `<vaultDir>/music/`, separada por perfil. Motivos:

- se mueve con la bóveda al cambiarla de sitio;
- se borra con el perfil;
- un perfil no puede deducir la música de otro;
- no hace falta contar referencias entre perfiles.

El coste es duplicar archivos si dos perfiles importan la misma canción, algo insignificante. La importación copia el archivo (no lo mueve) y **no borra el original** (8.6.1). El título visible y la relación con las playlists están en la DB cifrada.

#### 8.6.1 Importar música (`music/music-service.ts`, canal `music:import`)

- **Origen**: diálogo nativo en main, `properties: ['openFile', 'multiSelections', 'dontAddToRecent']`, filtro "Música" con `mp3, m4a, aac, ogg, opus, flac, wav`. Se abre desde Ajustes → Música y desde el panel de ajustes de la presentación ("Añadir música…"). No hay arrastrar y soltar para música.
- **Concurrencia** (12.11): una sola importación de música a la vez, registrada en `JobRegistry` como trabajo `music-import`. Un segundo `music:import` con otra en curso, o durante un traslado de la bóveda, devuelve `BUSY` antes de abrir el diálogo. El traslado no empieza mientras haya una en curso (8.7, paso 1). No pausa el auto-bloqueo (es corta); si se bloquea durante la copia, se aborta entre archivos, se borra el `.part` en curso y la reconciliación limpia el resto (12.6, punto 5).
- **Validación por archivo** (antes de copiar): `lstat` como en 12.3 punto 1 (sin enlaces simbólicos ni junctions, solo archivos regulares), tamaño ≤ 1 GiB (si no, `TOO_LARGE`), ≤ 200 archivos por importación (si se eligen más, `VALIDATION` antes de empezar) y formato por firma de los primeros 64 bytes:

  | Firma | Formato | `ext` guardada | MIME |
  |---|---|---|---|
  | `ID3`, o `FF` + byte con `(b1 & 0xE0) == 0xE0` y bits de capa `(b1 >> 1) & 3 == 1` (Layer III) | MP3 | `mp3` | `audio/mpeg` |
  | `FF` + byte con `(b1 & 0xF6) == 0xF0` (sync de 12 bits y capa `00`) | AAC ADTS | `aac` | `audio/aac` |
  | caja `ftyp` con brand mayor o compatible `M4A ` o `M4B ` | M4A | `m4a` | `audio/mp4` |
  | caja `ftyp` con otro brand: `ffprobe` (abajo) tiene que encontrar al menos una pista de audio y ninguna de vídeo; sin ffmpeg, `UNSUPPORTED_FORMAT` | M4A | `m4a` | `audio/mp4` |
  | `OggS` | Ogg (Vorbis/Opus) | `ogg` | `audio/ogg` |
  | `fLaC` | FLAC | `flac` | `audio/flac` |
  | `RIFF....WAVE` | WAV | `wav` | `audio/wav` |

  Cualquier otra firma da `UNSUPPORTED_FORMAT`. La extensión del archivo del usuario no se usa.
- **Copia** (sin pasar por `tmp/`, que solo contiene ciphertext, 8.8): `trackId` aleatorio → `fs.copyFile(original, music/<trackId>.<ext>.part, COPYFILE_EXCL)` → abrir y `fsync` → `rename` a `music/<trackId>.<ext>` → en Linux, `fsync` del directorio. El original no se toca nunca.
- **Duración**: `ffprobe -v error -print_format json -show_format -show_streams -protocol_whitelist file,pipe -f <mp3|aac|mov|ogg|flac|wav> <ruta en music/>` (timeout 30 s; la pista ya está en claro y es nuestra copia). `format.duration` × 1000, redondeado. Sin ffmpeg, o si falla, `duration_ms = NULL` (no es un error).
- **Título**: el nombre del archivo sin extensión, en NFC, sin `\p{Cc}`, con `trim` y recortado a 200 code points; si queda vacío, "Pista sin título". No se leen etiquetas ID3 (no se añaden dependencias).
- **DB**: `INSERT music_tracks` en una transacción por pista. Si falla, se borra el archivo copiado (`unlink`; está en claro, no hace falta sobrescribirlo).
- **Fallos**: cada archivo se procesa por separado; un fallo no detiene los demás, salvo `DISK_FULL` (`ENOSPC`), que detiene la importación porque los siguientes tampoco cabrían. Si falla la copia, se borra el `.part`.
- **Respuesta**: `music:import` devuelve `MusicImportResult = { imported: MusicTrack[]; failed: { name: string; code: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DISK_FULL' | 'IO' }[] } | null` (`null` si el usuario cancela el diálogo). `name` es el nombre visible del archivo elegido, para el resumen en la UI.
- **Duplicados de música**: se permiten (es una copia en claro; no hay HMAC).
- **Reconciliación al desbloquear** (12.6, paso 5): se borran `music/*.part` y los archivos de `music/` sin fila; las filas sin archivo se borran (la cascada limpia `playlist_music`) y su id se quita de `kv['presentation.defaultTracks']`.
- **`music:delete { id }`**: en una transacción, `DELETE FROM music_tracks WHERE id = ?` (la cascada limpia `playlist_music`) y quitar el id de `kv['presentation.defaultTracks']`. Después del `COMMIT`, `unlink` del archivo; si falla, `warn` y la reconciliación lo borrará como huérfano.
- **`vault://music/<trackId>`** sirve el archivo con el MIME de `music_tracks.mime` (11.3).

### 8.7 Cambiar la bóveda de sitio y disco ausente (`vault/relocate.ts`)

Se hace desde Ajustes → Almacenamiento con el perfil desbloqueado, con "Mover bóveda…" (diálogo nativo de carpeta) o "Volver a la ubicación predeterminada".

`<destino>` es `<elegida>/Galeria-<id[0..8]>` con "Mover bóveda…" y `GaleriaData/vaults/<id>` con "Volver a la ubicación predeterminada". `vault:relocate` devuelve `{ jobId }` en cuanto pasan las validaciones del paso 1; el resto ocurre en segundo plano con `relocate:progress` y termina con `relocate:done`.

1. **Validar**:
   - la carpeta elegida existe y se puede escribir en ella (se prueba creando y borrando un archivo);
   - ni `<destino>` ni `<destino>.partial` existen;
   - el destino no está dentro de la bóveda actual ni al revés (comparando `realpath`);
   - hay espacio libre (`fs.statfs`) ≥ tamaño de la bóveda × 1,05 + 200 MiB;
   - `JobRegistry` (12.11) no tiene ningún trabajo activo: ni importación (en cualquier fase, incluida `awaiting-confirmation`), ni importación de música, ni edición, ni fusión. Si lo hay, `BUSY`. La cola de regeneración de miniaturas (12.6, punto 3) no cuenta como trabajo: el paso 2 la pausa (espera a que termine el elemento en curso) y se reanuda al salir de `maintenance`.

   Si falla: `VALIDATION`, `IO`, `DISK_FULL` o `BUSY`, sin cambios.
2. **Entrar en mantenimiento**: `SessionManager` pasa al subestado `maintenance { jobId }` (13.1):
   - todos los canales "U" devuelven `BUSY`, salvo `vault:getInfo`, `vault:relocateCancel`, `session:lock`, `session:activity`, `session:setPlayback` y `session:getState` (5.6);
   - `vault://media|thumb|music` responde 503 con `X-Galeria-Error: BUSY` (11.4);
   - se pausan el temporizador de inactividad (motivo `'maintenance'`, 12.11) y el vigilante de la bóveda (13.2), así que ni una copia larga ni un `ENOENT` momentáneo disparan un bloqueo;
   - se pausan la cola de regeneración de miniaturas y el barrido de huérfanos (12.6, puntos 3 y 7), después de que termine el elemento en curso;
   - la UI muestra un `AlertDialog` de progreso que no se cierra con Esc ni con clic fuera, con la barra (`copiedBytes / totalBytes`) y el botón "Cancelar".
3. `PRAGMA wal_checkpoint(TRUNCATE)` y cerrar la DB.
4. **Copiar**: crear `<destino>.partial/` y dentro el marcador vacío `.galeria-relocate-<jobId>`. Copiar, en este orden, `vault.json`, `library.db`, `objects/`, `thumbs/` y `music/` (sin `tmp/` ni los `music/*.part`), con `fsync` por archivo. Después, verificar cada archivo comparando el SHA-256 del origen y del destino (es ciphertext o música en claro, así que no se descifra nada). Se emite `relocate:progress` como mucho cada 250 ms. Entre archivo y archivo se comprueba la cancelación.
5. Borrar el marcador y `rename(<destino>.partial, <destino>)`.
6. **Punto de confirmación**: actualizar `profiles.json` y su `.bak` (8.3) con `vault = { location, path: <destino> (solo si custom), pendingCleanup: <bóveda antigua> }`.
7. Reabrir la DB en la nueva ubicación y salir de `maintenance`. Si la apertura falla: se restaura `profiles.json` con la ruta y la ubicación anteriores (sin `pendingCleanup`), se reabre la DB antigua (sigue intacta), se borra el destino con `removeVaultDir(<destino>, id, 'vault')` y se devuelve `IO`.
8. **Borrar la bóveda antigua** con `removeVaultDir(<antigua>, id, 'vault')`; no necesita claves, porque solo borra ciphertext y la música del perfil. Si termina bien, se quita `pendingCleanup` de `profiles.json`. Si deja restos, se conserva `pendingCleanup`, se avisa en la UI con la ruta (`relocate:done` con `details.leftoverPath`) y se reintenta al arrancar y en cada desbloqueo.

**Durante el traslado no hay nuevos trabajos**: en `maintenance`, `import:*`, `music:import`, `merge:start` y `edits:save` devuelven `BUSY` (5.6, punto 4).

**Cancelar** (`vault:relocateCancel { jobId }`):

- antes del paso 5: se detiene la copia, se borra `<destino>.partial` con `removeVaultDir(…, 'relocate-partial')`, se reabre la DB original, se sale de `maintenance` y `relocate:done` devuelve `CANCELLED`;
- desde el paso 5: se ignora (la operación ya está a punto de confirmarse) y el diálogo muestra "Terminando…".

**Bloqueo durante el traslado** (manual, suspensión, bloqueo del SO, bóveda no disponible o cierre de la app; la inactividad está en pausa durante el traslado). El bloqueo sigue la secuencia de 13.3 sin esperar al traslado: las claves se ponen a cero al momento. La DB ya está cerrada desde el paso 3, y los pasos 4, 5, 6 y 8 no necesitan claves (copian, verifican o borran ciphertext y música en claro), así que el trabajo de traslado sigue o se deshace **sin claves** en `KeylessCleanup` (13.3, paso 6):

- antes del paso 5: equivale a cancelar, pero sin reabrir la DB. La copia se detiene en el siguiente límite entre archivos y el borrado de `<destino>.partial` con `removeVaultDir(…, 'relocate-partial')` sigue en segundo plano;
- los pasos 5 y 6 forman una unidad que no se interrumpe (un `rename` y una escritura atómica de JSON): si el bloqueo llega entre ellos, se completan igualmente en segundo plano;
- desde el paso 6: no se reabre la DB (la próxima apertura será en el destino) y el paso 8 sigue en segundo plano. El bloqueo no espera a que termine;
- con `shutdown` no se arranca `KeylessCleanup`: un `<destino>.partial` anterior al paso 5 se queda (abajo) y el paso 8 lo resuelve `pendingCleanup` en el siguiente arranque;
- una caída en cualquier punto deja o bien la bóveda antigua intacta y referenciada (antes del paso 6) más un `<destino>.partial` con marcador (o, entre los pasos 5 y 6, un `<destino>` completo sin referenciar), que el usuario puede borrar a mano y que la app no reutiliza porque el paso 1 exige que no exista; o bien la nueva referenciada y la antigua en `pendingCleanup` (desde el paso 6).

**Disco ausente**:

- `profiles:list` comprueba `fs.stat(<vaultDir>/vault.json)` con un timeout de 1,5 s y marca `vaultStatus: "unavailable"`. El selector muestra el aviso "Disco no conectado" en el avatar.
- Al intentar desbloquear con el disco ausente, se devuelve `VAULT_UNAVAILABLE` y el diálogo ofrece "Reintentar" y "Buscar la bóveda…" (`vault:locate`: diálogo de carpeta; se acepta si `vault.json.profileId` coincide, y entonces se actualiza la ruta). Las letras de unidad de Windows pueden cambiar entre conexiones.
- Nunca se crea una bóveda vacía en sustitución.
- Con la bóveda desbloqueada y fuera de `maintenance`, si cada 10 s `fs.stat(vault.json)` falla, o una operación de E/S da `ENOENT`/`EIO`/`ENODEV` sobre la DB o los objetos, se bloquea con el motivo `vault-unavailable`.
- `vault:locate` guarda como `vault.path` exactamente la carpeta elegida, que tiene que contener un `vault.json` válido con el mismo `profileId`.

### 8.8 Temporales y limpieza

- Solo existe `<vaultDir>/tmp/` y solo contiene ciphertext (`.part`). Los `.part` de la música van en `music/` (8.6.1), porque son copias en claro.
- No se usa nunca `os.tmpdir()` para contenido.
- SQLite usa `temp_store = MEMORY` (9.1).
- libvips (sharp) no descomprime a disco: `VIPS_DISC_THRESHOLD` (12.4, paso 4).
- Al desbloquear, después de reconciliar (12.6), se borran todos los `tmp/*.part`.
- Los JSON temporales (`*.tmp-*`) que encuentra `GaleriaData` al arrancar se borran.

---

## 9. Base de datos (SQLCipher con better-sqlite3-multiple-ciphers)

### 9.1 Apertura (`src/main/db/database.ts`)

```ts
const db = new Database(join(vaultDir, 'library.db'), { fileMustExist: !creating });
db.pragma("cipher = 'sqlcipher'");      // esquema compatible SQLCipher
db.pragma('legacy = 4');                // parámetros SQLCipher v4: AES-256-CBC + HMAC-SHA512 por página, page_size 4096
const keyArg = rawKeyArg(K_db);         // Buffer ASCII de 67 bytes: x'<64 hex>' (clave cruda, sin KDF de SQLCipher)
try { db.key(keyArg); } finally { keyArg.fill(0); }
db.prepare('SELECT count(*) FROM sqlite_master').get(); // si la clave es incorrecta → SQLITE_NOTADB
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');       // ningún temporal de SQLite en disco sin cifrar
db.pragma('secure_delete = ON');
db.pragma('busy_timeout = 5000');
```

Detalles:

- **Cifrado**: esquema `sqlcipher` en modo `legacy = 4`, porque el requisito pide explícitamente SQLCipher. Cifra y autentica cada página con HMAC.
- **Clave cruda**: `rawKeyArg` escribe `x'`, los 64 dígitos hex de `K_db` y `'` directamente en un `Buffer` mediante una tabla de búsqueda, sin crear ningún string con la clave. Al ser cruda no se ejecuta el KDF de SQLCipher (`kdf_iter` no aplica).
- **WAL**: SQLite3MultipleCiphers también cifra el WAL. El `-shm` solo contiene índices de páginas.
- **Prueba obligatoria en la Fase 1** (`tests/unit/main/database.test.ts`):
  1. crear la DB con la clave, cerrarla y reabrirla bien;
  2. con una clave incorrecta, `SQLITE_NOTADB`;
  3. los 16 primeros bytes del archivo no son `SQLite format 3\0`;
  4. buscar en los bytes del archivo un string insertado en la DB no da resultados.
- **Plan B**, si `db.key(Buffer)` no reconociera la forma `x'…'`: usar `db.pragma(\`key = "x'${hex}'"\`)`. Así el hex existe como string inmutable, con peor higiene; se documenta en el código y en PLAN.

### 9.2 Esquema v1 (`src/main/db/migrations/index.ts`, migración 1)

```sql
CREATE TABLE media (
  id                  TEXT    PRIMARY KEY CHECK (length(id) = 32),
  kind                TEXT    NOT NULL CHECK (kind IN ('photo','video')),
  state               TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  source              TEXT    NOT NULL CHECK (source IN ('import','merge')),
  name                TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  name_fold           TEXT    NOT NULL,          -- minúsculas, sin diacríticos (búsqueda)
  original_ext        TEXT    NOT NULL,          -- 'jpg','png','mp4','mkv',… del archivo original
  mime                TEXT    NOT NULL,          -- MIME del objeto almacenado (tras conversión)
  size_bytes          INTEGER NOT NULL CHECK (size_bytes >= 0),          -- plaintext almacenado
  original_size_bytes INTEGER NOT NULL CHECK (original_size_bytes >= 0),
  width               INTEGER,                   -- dimensiones de visualización (EXIF/rotación aplicadas)
  height              INTEGER,
  duration_ms         INTEGER,                   -- solo vídeo
  fps                 REAL,                      -- solo vídeo
  has_audio           INTEGER CHECK (has_audio IN (0,1)),
  video_codec         TEXT,
  audio_codec         TEXT,
  converted           INTEGER NOT NULL DEFAULT 0 CHECK (converted IN (0,1)),  -- 1 = lo almacenado NO es byte a byte el original (salida de ffmpeg: remultiplexado, recodificado o fusión)
  captured_at         INTEGER NOT NULL,          -- ms, hora local "naive" (pared) codificada con Date.UTC; siempre presente (12.8)
  captured_at_source  TEXT    NOT NULL CHECK (captured_at_source IN ('exif','container','file_mtime','generated')),
  imported_at         INTEGER NOT NULL,          -- ms UTC
  content_hmac        BLOB    NOT NULL UNIQUE CHECK (length(content_hmac) = 32),
  thumb_id            TEXT    CHECK (thumb_id IS NULL OR length(thumb_id) = 32),
  thumb_rev           INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX media_state_captured ON media(state, captured_at DESC);
CREATE INDEX media_state_imported ON media(state, imported_at DESC);
CREATE INDEX media_kind_captured  ON media(kind, captured_at DESC);
CREATE INDEX media_size           ON media(size_bytes);
CREATE INDEX media_duration       ON media(duration_ms);

CREATE TABLE media_exif (
  media_id      TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  camera_make   TEXT, camera_model TEXT, lens_model TEXT,
  f_number      REAL, exposure_s REAL, iso INTEGER, focal_mm REAL,
  orientation   INTEGER, gps_lat REAL, gps_lon REAL,
  tz_offset_min INTEGER,                           -- de OffsetTimeOriginal si existe
  raw_json      TEXT NOT NULL                      -- subconjunto saneado (strings ≤ 256 chars, ≤ 16 KiB)
) STRICT;

CREATE TABLE media_edits (                         -- operaciones no destructivas, en orden
  media_id   TEXT    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  op_json    TEXT    NOT NULL,                     -- EditOp (sección 16.3)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE playlists (
  id                TEXT PRIMARY KEY CHECK (length(id) = 32),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_fold         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  presentation_json TEXT                           -- PresentationPlainSettings (SIN trackIds) o NULL = usar defaults
) STRICT;

CREATE TABLE playlist_items (
  playlist_id TEXT    NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id    TEXT    NOT NULL REFERENCES media(id)     ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),  -- denso 0..n-1, reescrito al reordenar
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX playlist_items_order ON playlist_items(playlist_id, position);
CREATE INDEX playlist_items_media ON playlist_items(media_id);

CREATE TABLE music_tracks (
  id          TEXT PRIMARY KEY CHECK (length(id) = 32),
  file_name   TEXT NOT NULL UNIQUE,                -- '<id>.<ext>' dentro de music/
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  title_fold  TEXT NOT NULL,
  ext         TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  duration_ms INTEGER,
  imported_at INTEGER NOT NULL
) STRICT;

CREATE TABLE playlist_music (                      -- ÚNICA fuente de verdad de la música de una playlist
  playlist_id TEXT    NOT NULL REFERENCES playlists(id)    ON DELETE CASCADE,
  track_id    TEXT    NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (playlist_id, track_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE kv (                                  -- pares cifrados (claves cerradas, abajo)
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) STRICT;
```

Claves de `kv` (cerradas; `kv-repo.ts` valida cada valor con zod):

| Clave | Valor | Quién la escribe |
|---|---|---|
| `presentation.defaultTracks` | `["<trackId>", …]` (≤ 100, en orden) | `presentation:saveDefaults`; `music:delete` y la reconciliación quitan ids |
| `import.replace.<newId>` | `{ "old": "<mediaId>", "hmac": "<64 hex>" }`; zod: `old` `/^[0-9a-f]{32}$/`, `hmac` `/^[0-9a-f]{64}$/` (minúsculas; la transacción A escribe `lower(hex(:hmac))`) | Sustitución de un duplicado dañado (12.7, punto 3), entre sus dos transacciones |

Notas:

- **`converted`** tiene un único significado: `1` si el objeto almacenado no es byte a byte el archivo original, es decir, si es una salida de ffmpeg (remultiplexado con `-c copy`, recodificado, o una fusión). `0` solo para lo que se cifra tal cual (todas las fotos y los vídeos de la fila "Tal cual" de 12.5). El término "recodificar" se reserva para la confirmación D8 (12.5.1), que solo afecta a los vídeos que pierden calidad.
- **Duplicados**: `content_hmac` es `HMAC-SHA256(K_dedup, bytes del archivo original)`. Para los vídeos procesados con ffmpeg (`converted = 1`) se calcula sobre el original antes de procesarlo, para que reimportar el mismo archivo se detecte. Para fusiones, sobre la salida. Por eso la comprobación extra de 12.7, punto 1 (`HMAC(descifrado) == content_hmac`) solo se aplica con `converted = 0`. Está en la DB cifrada y con clave, así que no sirve para buscar un archivo conocido fuera de la app.
- **Fecha local**: `captured_at` usa hora local "naive". La agrupación por mes refleja la fecha de pared de la cámara, independientemente de la zona horaria de la máquina.
- **Búsqueda**: `name_fold = NFC(toLowerCase(quitarDiacríticos(NFD(name))))`, con `name_fold LIKE '%' || ? || '%' ESCAPE '\'` (el término se dobla igual y se escapan `%`, `_` y `\`). Un escaneo de 100 000 filas tarda menos de 50 ms, así que no se usa FTS.
- **Orden total y estable** (la selección por rango con Shift depende de él, 14.6). Siempre con `WHERE state = 'ready'`; `<dir>` es `ASC` o `DESC`:

  | `sort.field` | `ORDER BY` |
  |---|---|
  | `captured` | `captured_at <dir>, id <dir>` |
  | `imported` | `imported_at <dir>, id <dir>` |
  | `size` | `size_bytes <dir>, id <dir>` |
  | `duration` | `duration_ms IS NULL, duration_ms <dir>, id <dir>` (las fotos, con `NULL`, van al final en los dos sentidos) |
  | `position` (solo con `playlistId`) | `playlist_items.position <dir>` (es única dentro de la playlist) |
  | `name` | En JS (abajo) |

- **Orden por nombre**: se hace en JS en main con `Intl.Collator('es', { numeric: true, sensitivity: 'base' })`, porque better-sqlite3 no permite registrar collations. Desempate: `imported_at` y después `id`, en el mismo sentido que el nombre.
- **Límite de playlists**: 2000 elementos por playlist (`PLAYLIST_FULL`). Es un límite práctico de la vista reordenable sin virtualizar (14.8).
- **Música de las presentaciones**: las pistas de una playlist viven solo en `playlist_music`; `presentation_json` nunca contiene `trackIds`. Las pistas por defecto viven solo en `kv['presentation.defaultTracks']`. Las reglas de escritura y de composición están en 10.2 (`playlists:setPresentation`, `presentation:saveDefaults`, `presentation:getConfig`).

### 9.3 Migraciones (`src/main/db/migrate.ts`)

- La versión del esquema se guarda en `PRAGMA user_version`. `migrations` es un array ordenado de `{ version, sql }`.
- Las migraciones son solo hacia delante y nunca se edita una ya publicada.
- Al abrir, si `user_version < última`:
  1. checkpoint del WAL;
  2. copia del archivo cifrado a `library.db.bak-v<actual>`;
  3. `BEGIN IMMEDIATE`, se aplican las pendientes, `user_version = n`, `COMMIT`;
  4. se borra el `.bak` si todo fue bien.
- Si falla: `ROLLBACK`, se conserva el `.bak`, se devuelve `VAULT_CORRUPT { stage: 'migration' }`, se registra un `error` y no se desbloquea.
- Una DB con `user_version` mayor que la conocida (creada por una versión más nueva de la app) devuelve `VAULT_CORRUPT { stage: 'newer-version' }` y no se toca.

---

## 10. API IPC

### 10.1 Tipos compartidos (`src/shared/errors.ts`, `src/shared/types.ts`, `src/shared/ipc-contract.ts`)

```ts
export const ERROR_CODES = ['VALIDATION','LOCKED','BUSY','WRONG_PASSWORD','PROFILE_NOT_FOUND',
  'PROFILE_NAME_TAKEN','PROFILE_LIMIT','VAULT_UNAVAILABLE','VAULT_CORRUPT','NOT_FOUND','INTEGRITY',
  'UNSUPPORTED_FORMAT','TOO_LARGE','DISK_FULL','IO','FFMPEG_MISSING','FFMPEG_FAILED','CANCELLED',
  'PLAYLIST_FULL','INTERNAL'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface AppError { code: ErrorCode; details?: Record<string, string | number | boolean> }
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
// main nunca envía textos: el renderer traduce code → mensaje en español (renderer/src/lib/errors-es.ts)

export type Id = string;                                  // /^[0-9a-f]{32}$/
export type ThemeId = 'fotos' | 'xbox' | 'ps3' | 'macos' | 'album';
export type ColorSchemePref = 'system' | 'light' | 'dark';
export type BuiltinAvatarId = 'aurora'|'bosque'|'coral'|'duna'|'eclipse'|'fresa'
                            |'glaciar'|'hoja'|'lava'|'marea'|'nebula'|'sol';
export type AvatarRef   = { type: 'builtin'; id: BuiltinAvatarId } | { type: 'custom'; rev: number };
export type AvatarInput = { type: 'builtin'; id: BuiltinAvatarId } | { type: 'custom'; token: string };

export interface AppInfo { version: string; platform: 'win32' | 'linux'; ffmpegAvailable: boolean }
export interface WindowState { maximized: boolean; minimized: boolean; fullscreen: boolean;
                               focused: boolean; visible: boolean }
export interface GlobalSettings { pickerThemeId: ThemeId; colorScheme: ColorSchemePref }
export interface ProfileSummary { id: Id; name: string; avatar: AvatarRef;
  vaultStatus: 'ok' | 'unavailable'; themeId: ThemeId | null /* de prefs, para pintar tras desbloquear */ }
export type AutoLockMinutes = 0 | 1 | 2 | 5 | 10 | 15 | 30 | 60;      // 0 = desactivado
export interface ProfilePrefs { themeId: ThemeId | null; colorScheme: ColorSchemePref | null;
  autoLockMinutes: AutoLockMinutes; contentProtection: boolean /* D15, por defecto true */;
  gridSize: 'small' | 'medium' | 'large';
  gallerySort: MediaSort; presentationDefaults: PresentationPlainSettings }
export type SessionState =
  | { state: 'locked' } | { state: 'unlocking'; profileId: Id }
  | { state: 'unlocked'; profileId: Id; maintenance: { jobId: Id } | null }   // maintenance: traslado (8.7)
  | { state: 'locking'; profileId: Id };
export type LockReason = 'manual' | 'inactivity' | 'suspend' | 'os-lock' | 'vault-unavailable'
                       | 'error' | 'shutdown';

export type MediaKind = 'photo' | 'video';
export interface MediaSort { field: 'captured' | 'imported' | 'name' | 'size' | 'duration' | 'position';
                             dir: 'asc' | 'desc' }                 // 'position' solo con playlistId
export interface MediaQuery { kind: 'all' | MediaKind; search?: string; dateFrom?: number; dateTo?: number;
                              playlistId?: Id; sort: MediaSort }
export interface MediaListItem { id: Id; kind: MediaKind; name: string; ext: string;
  capturedAt: number /* naive local, 12.8 */; importedAt: number; sizeBytes: number; durationMs: number | null;
  width: number | null; height: number | null; thumbRev: number }
export interface ExifSummary { cameraMake?: string; cameraModel?: string; lensModel?: string;
  fNumber?: number; exposureS?: number; iso?: number; focalMm?: number }
export interface MediaDetail extends MediaListItem { mime: string; originalSizeBytes: number;
  converted: boolean /* salida de ffmpeg, 9.2 */; hasAudio: boolean | null; fps: number | null; videoCodec: string | null;
  audioCodec: string | null; exif: ExifSummary | null; edits: EditOp[] }
export type EditOp =
  | { t: 'rotate'; q: 1 | 2 | 3 }                              // cuartos de vuelta en sentido horario
  | { t: 'flipH' } | { t: 'flipV' }
  | { t: 'crop'; x: number; y: number; w: number; h: number }; // normalizado [0,1] sobre la vista actual

export interface ImportProgress { jobId: Id; total: number; done: number; imported: number;
  duplicates: number; skipped: number; failed: number; currentName: string | null;
  phase: 'scanning' | 'awaiting-confirmation' | 'encrypting' | 'converting' | 'verifying' | 'finalizing' }
export interface ImportConfirmNeeded { jobId: Id; toConvert: number; toConvertBytes: number }  // 12.5.1
export type ImportFailureCode = 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DISK_FULL' | 'IO' | 'INTEGRITY'
  | 'FFMPEG_MISSING' | 'FFMPEG_FAILED' | 'CANCELLED' | 'CHANGED_DURING_IMPORT';
export interface ImportReport { jobId: Id; imported: number; duplicates: number; skipped: number;
  failed: { name: string; code: ImportFailureCode }[];
  originalsNotDeleted: { path: string; reason: 'IO' | 'CHANGED_DURING_IMPORT' }[]; cancelled: boolean }

export interface PlaylistSummary { id: Id; name: string; itemCount: number; coverMediaId: Id | null;
                                   hasCustomPresentation: boolean; updatedAt: number }
export interface MusicTrack { id: Id; title: string; durationMs: number | null; sizeBytes: number }
export interface MusicImportResult { imported: MusicTrack[];
  failed: { name: string; code: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DISK_FULL' | 'IO' }[] }   // 8.6.1
export type TransitionKind = 'fade' | 'slide' | 'zoom' | 'kenburns';
export type AudioMode = 'video' | 'music' | 'both' | 'mute';  // qué suena DURANTE los vídeos
export interface PresentationPlainSettings { transition: TransitionKind | 'random' | 'none';
  randomPool: TransitionKind[]; transitionMs: number; slideMs: number; loop: boolean;
  startFullscreen: boolean; audioMode: AudioMode; musicEnabled: boolean; musicVolume: number;
  videoVolume: number; musicFadeMs: number }
// Forma del IPC. En disco se separa: lo "plain" va a presentation_json / prefs y trackIds a playlist_music / kv (9.2)
export interface PresentationSettings extends PresentationPlainSettings { trackIds: Id[] }
export interface MergeRequest { leftId: Id; rightId: Id; audio: 'left' | 'right' | 'mix' | 'none';
                                duration: 'shortest' | 'longest'; name: string }
export interface VaultInfo { location: 'default' | 'custom'; path: string; sizeBytes: number; freeBytes: number }
```

### 10.2 Canales (`invoke`, renderer → main)

"U" indica que el canal requiere la bóveda desbloqueada; si no lo está, devuelve `LOCKED`. Todas las respuestas son `Result<T>`.

| Canal | Request | Response | U |
|---|---|---|---|
| `app:getInfo` | – | `AppInfo` | |
| `window:minimize` / `window:toggleMaximize` / `window:close` | – | `void` | |
| `window:setFullScreen` | `{ on: boolean }` | `void` | |
| `window:getState` | – | `WindowState` | |
| `settings:get` | – | `GlobalSettings` | |
| `settings:set` | `Partial<GlobalSettings>` | `GlobalSettings` | |
| `profiles:list` | – | `ProfileSummary[]` | |
| `profiles:pickAvatarPhoto` | – | `{ token: string } \| null` (diálogo nativo; errores `UNSUPPORTED_FORMAT`, `TOO_LARGE`, `IO`; reglas en 14.4) | |
| `profiles:create` | `{ name; avatar: AvatarInput; password: Uint8Array; acknowledgeNoRecovery: true }` | `ProfileSummary` | |
| `profiles:update` | `{ profileId; password: Uint8Array; name?; avatar?: AvatarInput }` | `ProfileSummary` | |
| `profiles:changePassword` | `{ profileId; currentPassword: Uint8Array; newPassword: Uint8Array }` | `void` | |
| `profiles:delete` | `{ profileId; password: Uint8Array; confirmName: string }` | `void` | |
| `session:unlock` | `{ profileId; password: Uint8Array }` | `{ profile: ProfileSummary; prefs: ProfilePrefs }` | |
| `session:lock` | – | `void` | |
| `session:getState` | – | `SessionState` | |
| `session:activity` | – | `void` (el renderer lo envía como mucho 1 vez cada 10 s) | U |
| `session:setPlayback` | `{ active: boolean }` | `void` | U |
| `prefs:get` / `prefs:set` | – / `Partial<ProfilePrefs>` | `ProfilePrefs` | U |
| `media:list` | `MediaQuery` | `{ items: MediaListItem[] }` | U |
| `media:get` | `{ id }` | `MediaDetail` | U |
| `media:rename` | `{ id; name }` | `MediaListItem` | U |
| `media:delete` | `{ ids: Id[] }` | `{ deleted: number }` | U |
| `import:chooseFiles` / `import:chooseFolder` | – | `{ jobId } \| null` (diálogo nativo en main; `BUSY` sin abrir el diálogo si ya hay una importación activa, 12.11) | U |
| `import:paths` (solo vía `importDropped`) | `{ paths: string[] }` | `{ jobId }` (`BUSY` si ya hay una importación activa) | U |
| `import:confirm` | `{ jobId; convert: boolean }` (respuesta a `import:confirmNeeded`, 12.5.1) | `void` (`NOT_FOUND` si el trabajo no está en `awaiting-confirmation`) | U |
| `import:cancel` | `{ jobId }` | `void` | U |
| `vault:getInfo` | – | `VaultInfo` | U |
| `vault:relocate` | `{ target: 'choose' \| 'default' }` | `{ jobId } \| null` (`null` si se cancela el diálogo) | U |
| `vault:relocateCancel` | `{ jobId }` | `void` (se ignora desde el paso 5 de 8.7) | U |
| `vault:locate` | `{ profileId }` | `ProfileSummary \| null` (diálogo nativo) | |
| `edits:save` | `{ mediaId; ops: EditOp[] }` (sustituye la lista completa; `[]` = revertir) | `{ edits: EditOp[]; thumbRev: number }` | U |
| `playlists:list` | – | `PlaylistSummary[]` | U |
| `playlists:create` | `{ name }` | `PlaylistSummary` | U |
| `playlists:rename` | `{ id; name }` | `PlaylistSummary` | U |
| `playlists:delete` | `{ id }` | `void` | U |
| `playlists:addItems` | `{ id; mediaIds: Id[] }` | `{ added: number; alreadyPresent: number }` | U |
| `playlists:removeItems` | `{ id; mediaIds: Id[] }` | `{ removed: number }` | U |
| `playlists:reorder` | `{ id; mediaIds: Id[] }` (permutación completa) | `void` | U |
| `playlists:setPresentation` | `{ id; settings: PresentationSettings \| null }` (reglas abajo) | `void` | U |
| `music:import` | – (diálogo nativo, multiselección, 8.6.1) | `MusicImportResult \| null` (`BUSY` con otra importación de música en curso o durante un traslado) | U |
| `music:list` | – | `MusicTrack[]` | U |
| `music:rename` | `{ id; title }` | `MusicTrack` | U |
| `music:delete` | `{ id }` | `void` | U |
| `presentation:getConfig` | `{ playlistId?: Id }` | `{ settings: PresentationSettings; tracks: MusicTrack[] }` | U |
| `presentation:saveDefaults` | `{ settings: PresentationSettings }` | `void` | U |
| `merge:start` | `MergeRequest` | `{ jobId }` (`BUSY` si ya hay una fusión activa, 12.11) | U |
| `merge:cancel` | `{ jobId }` | `void` | U |

Eventos (`on`, main → renderer, enviados solo a `mainWindow.webContents`):

| Evento | Payload |
|---|---|
| `session:locking` | `{ reason: LockReason }` (primer paso del bloqueo, 13.3: el renderer pinta el velo opaco al recibirlo) |
| `session:locked` | `{ reason: LockReason }` (a la ventana que se va a sustituir, justo antes de crear la nueva, 13.3) |
| `library:changed` | `{ reason: 'import' \| 'delete' \| 'rename' \| 'edit' \| 'merge' \| 'playlist'; ids?: Id[] }` (agrupado durante los trabajos, abajo) |
| `import:progress` / `import:done` | `ImportProgress` / `ImportReport` |
| `import:confirmNeeded` | `ImportConfirmNeeded` (12.5.1) |
| `merge:progress` / `merge:done` | `{ jobId; fraction: number }` / `{ jobId; result: Result<{ mediaId: Id; existed: boolean }> }` (18.6) |
| `relocate:progress` / `relocate:done` | `{ jobId; copiedBytes; totalBytes }` / `{ jobId; result: Result<VaultInfo & { leftoverPath?: string }> }` (8.7) |
| `window:state` | `WindowState` |

Los canales y eventos añadidos en las revisiones (`import:confirm`, `vault:relocateCancel`, `import:confirmNeeded`, `session:locking`) forman parte de `INVOKE_CHANNELS` y `EVENT_CHANNELS` (5.6).

**Agrupación de `library:changed`** (`ipc/library-events.ts`, F2). `media:list` devuelve la biblioteca entera (R13), así que un evento por archivo en una importación de 10 000 archivos provocaría miles de recargas completas:

- mientras haya una importación o una fusión activa, main emite `library:changed` como mucho **una vez por segundo y por `reason`**, sin `ids` (el renderer recarga la consulta actual), y una vez más al terminar el trabajo;
- fuera de los trabajos (renombrar, borrar, editar, playlists), el evento se emite al momento con sus `ids`;
- el renderer recarga `media:list` con un debounce de 500 ms desde el último evento;
- test unitario con reloj falso: 1000 confirmaciones repartidas en 3 s producen ≤ 5 eventos de `import` (como mucho uno por ventana de 1 s más el final) y el último llega después de la última confirmación.

**Música de las presentaciones** (fuente de verdad única, 9.2):

- `playlists:setPresentation { id, settings }`, en una transacción:
  - con `settings` no nulo: `presentation_json` = `settings` sin `trackIds` (validado con el esquema zod de `PresentationPlainSettings`), `DELETE FROM playlist_music WHERE playlist_id = ?` e `INSERT` de cada `settings.trackIds[i]` con `position = i`;
  - con `settings: null`: `presentation_json = NULL` y `DELETE FROM playlist_music WHERE playlist_id = ?`.
- `presentation:saveDefaults { settings }`: `prefs.presentationDefaults` = `settings` sin `trackIds` (JSON en claro) y, en la DB, `kv['presentation.defaultTracks'] = settings.trackIds`.
- `presentation:getConfig { playlistId? }`: si la playlist tiene `presentation_json`, ese JSON + las pistas de `playlist_music` ordenadas por `position`; si no (o sin `playlistId`), `prefs.presentationDefaults` + `kv['presentation.defaultTracks']`. Los ids que ya no existan en `music_tracks` se descartan al componer. `tracks` son las filas de `music_tracks` de esos ids, en el mismo orden.
- `PlaylistSummary.hasCustomPresentation` = `presentation_json IS NOT NULL`.

API del preload (`window.galeria`):

```ts
interface GaleriaApi {
  invoke<C extends InvokeChannel>(channel: C, req: ReqOf<C>): Promise<Result<ResOf<C>>>; // rechaza canales fuera de la allowlist
  on<E extends EventChannel>(event: E, cb: (payload: PayloadOf<E>) => void): () => void; // devuelve unsubscribe
  importDropped(files: File[]): Promise<Result<{ jobId: Id }>>;  // usa webUtils.getPathForFile e invoca import:paths
  readonly initialTheme: { themeId: ThemeId; scheme: 'light' | 'dark' };  // leído de process.argv (--galeria-theme)
}
```

### 10.3 Reglas de validación de entradas (zod, en main)

Todas las cadenas se normalizan a NFC y se recortan (`trim`) antes de validarlas. Cualquier fallo devuelve `VALIDATION`, y la UI ya habrá validado lo mismo antes para dar feedback inmediato.

| Campo | Regla |
|---|---|
| `id`, `profileId`, `mediaId`, `jobId`, `trackId` | Obligatorio, `/^[0-9a-f]{32}$/` |
| Nombre de perfil | 1–40 code points, sin `\p{Cc}`, único (comparación por pliegue de mayúsculas y diacríticos) → si no, `PROFILE_NAME_TAKEN`; máximo 10 perfiles → si no, `PROFILE_LIMIT` |
| Contraseña (`Uint8Array`) | **Main**: 8–1024 bytes UTF-8 (la única regla que se puede comprobar sobre bytes). **UI**, antes de enviar: ≥ 8 code points (`[...NFC(texto)].length`) con el mensaje "Mínimo 8 caracteres", y ≤ 1024 bytes UTF-8 (`TextEncoder`) con el mensaje "Demasiado larga". Como cada code point ocupa al menos un byte, todo lo que acepta la UI lo acepta main. La UI exige además escribirla dos veces y marcar la casilla de "sin recuperación" (`acknowledgeNoRecovery === true`, obligatorio al crear) |
| `confirmName` (al borrar un perfil) | Tiene que coincidir con el nombre del perfil (comparación plegada) |
| Avatar `builtin.id` | Uno de los 12 ids; `custom.token`: 43 caracteres base64url, emitido por `profiles:pickAvatarPhoto` en esta sesión y con caducidad de 10 min |
| Foto de avatar (archivo elegido en `profiles:pickAvatarPhoto`) | Archivo regular sin enlaces (`lstat`, como en 12.3 punto 1); ≤ 50 MiB; formato por firma con las filas de foto de `sniff.ts` (JPEG, PNG, WebP, GIF, AVIF; HEIC, RAW, BMP y el resto se rechazan); ≤ 268 MP. Si no, `UNSUPPORTED_FORMAT` o `TOO_LARGE` (14.4) |
| Nombre de medio (`media:rename`) | 1–255 code points, sin `\p{Cc}`. Al importar, el nombre no viene del renderer: lo calcula main con la regla de 12.4.1, que siempre produce un valor válido para esta misma regla |
| Nombre de playlist | 1–100; título de música 1–200; nombre de fusión 1–255 |
| `search` | Opcional, ≤ 200 code points |
| `dateFrom`, `dateTo` | Opcionales, enteros entre 0 y 253402300799999; `dateFrom ≤ dateTo` |
| `sort.field = 'position'` | Solo con `playlistId` |
| `ids` (`media:delete`, `playlists:addItems`/`removeItems`) | 1–100 000 elementos, sin duplicados |
| `playlists:reorder.mediaIds` | Permutación exacta de los elementos actuales (≤ 2000) |
| `paths` | 1–10 000 elementos, cada uno de 1–32 767 caracteres, absoluto, sin NUL |
| `ops` | ≤ 64 elementos; `crop`: valores finitos en [0, 1], `w, h ≥ 0.01`, `x + w ≤ 1`, `y + h ≤ 1` (tolerancia 1e-9) |
| `PresentationSettings` | `transitionMs` 0–3000; `slideMs` 1000–60000 en pasos de 500; `randomPool` no vacío y sin duplicados; volúmenes en [0, 1]; `musicFadeMs` 0–5000; `trackIds` ≤ 100 y existentes (si no, `NOT_FOUND`) |
| `ProfilePrefs` | Enums cerrados; `autoLockMinutes ∈ {0,1,2,5,10,15,30,60}` |
| `MergeRequest` | `leftId ≠ rightId`, los dos tienen que ser vídeos `ready` (si no, `VALIDATION`) |
| `import:confirm` | `jobId` de un trabajo en `awaiting-confirmation` (si no, `NOT_FOUND`); `convert` booleano obligatorio |
| `vault:relocateCancel` | `jobId` del traslado en curso (si no, `NOT_FOUND`) |
| Música (`music:import`) | Validación por archivo en 8.6.1: ≤ 200 archivos (si no, `VALIDATION`), ≤ 1 GiB cada uno, firma admitida |

---

## 11. Protocolo `vault://` (`src/main/protocol/vault-protocol.ts`)

### 11.1 Formas de URL

| URL | Contenido | ¿Requiere desbloqueo? |
|---|---|---|
| `vault://media/<mediaId>` | Objeto almacenado, descifrado al vuelo | Sí |
| `vault://thumb/<mediaId>?rev=<n>` | Miniatura WebP (se busca `thumb_id`; `rev` solo invalida caché) | Sí |
| `vault://music/<trackId>` | Pista de música (archivo en claro de `music/`) | Sí |
| `vault://avatar/<profileId>?rev=<n>` | Avatar personalizado (en claro) | No |
| `vault://avatar/pending/<token>` | Avatar elegido y aún no guardado (en memoria, caduca a los 10 min) | No |

El renderer construye las URLs con `renderer/src/lib/vault-url.ts`. Nunca recibe rutas de objetos de la bóveda.

### 11.2 Validación y Range

- **Método**: solo `GET` y `HEAD`; si no, 405.
- **Host**: uno de `media`, `thumb`, `music`, `avatar`; si no, 400.
- **Segmentos**: los ids tienen que cumplir la regex; si no, 400. La query solo admite `rev` con dígitos; cualquier otra clave se ignora.
- **Búsqueda**: `media` y `thumb` exigen una fila `media` con `state = 'ready'`, y `music` una fila en `music_tracks`. Si no existe, 404. Un id de otro perfil simplemente no existe en esta DB.
- **Range** (`range.ts`, puro; `P` = tamaño del plaintext):
  - formas aceptadas: `bytes=a-b`, `bytes=a-` y `bytes=-n` (los últimos n bytes), con enteros decimales sin signo;
  - con varios rangos o sintaxis inválida (incluido `a > b`), se ignora la cabecera y se responde 200 con el cuerpo completo (RFC 9110 lo permite);
  - si `P = 0`, cualquier `Range` válido da 416 con `Content-Range: bytes */0`;
  - si `a ≥ P`, 416 con `Content-Range: bytes */<P>`;
  - `bytes=-0` da 416 con `Content-Range: bytes */<P>`;
  - `bytes=-n` con `n > P` sirve `[0, P − 1]`;
  - si `b ≥ P`, se recorta a `P − 1`;
  - un `HEAD` con `Range` válido devuelve 206 con las mismas cabeceras que el `GET` (`Content-Range`, `Content-Length` del rango) y sin cuerpo.
- **Contenido cifrado**: `openObject` (con la DEK en caché) y `createReadStream(a, b)`, convertido con `Readable.toWeb()`. Archivos en claro (música y avatar): `fs.createReadStream` con `{ start, end }`.

### 11.3 Cabeceras de respuesta

```
Content-Type: <media.mime | image/webp | music_tracks.mime>
Content-Length: <bytes del cuerpo>
Accept-Ranges: bytes
Content-Range: bytes a-b/size                (solo 206)
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: <origen del renderer>   (app://bundle | http://127.0.0.1:5173 en desarrollo)
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
```

Código 200 sin `Range` y 206 con `Range` válido. `HEAD` devuelve las mismas cabeceras sin cuerpo.

### 11.4 Errores

Los errores se devuelven con cuerpo vacío y la cabecera `X-Galeria-Error: <code>`.

| Status | Código | Cuándo | Log |
|---|---|---|---|
| 400 | `VALIDATION` | URL mal formada | debug |
| 404 | `NOT_FOUND` | id inexistente, objeto ausente en disco (`ENOENT`) | debug (warn si existe la fila pero falta el archivo) |
| 405 | – | método ≠ GET/HEAD | debug |
| 416 | – | rango no satisfacible | debug |
| 423 | `LOCKED` | sesión no desbloqueada (excepto avatar) | debug |
| 500 | `INTEGRITY` | cabecera o tag inválidos al abrir | warn (`mediaId`, código) |
| 500 | `IO` / `INTERNAL` | otros fallos | error (`err.code`) |
| 503 | `VAULT_UNAVAILABLE` | carpeta de la bóveda inaccesible (además se bloquea, 8.7) | warn |
| 503 | `BUSY` | subestado `maintenance` (traslado de la bóveda, 8.7); no aplica a `avatar` | debug |

Si un chunk falla en mitad de un stream, se llama a `controller.error()`: Chromium aborta la carga y el `<img>`/`<video>` dispara `error`. La UI muestra "No se puede mostrar este archivo (está dañado)" y se registra un `warn`.

### 11.5 Comportamiento con la bóveda bloqueada

`SessionManager` lleva la cuenta de todos los `ObjectReader` abiertos. Desde que el estado pasa a `locking` (13.3, paso 1), toda petición que requiera desbloqueo responde 423. En el paso 2 los streams en curso terminan con error (`controller.error()`); en el paso 4 se llama a `destroyKeys()` de cada reader y se vacía la caché de DEKs (puesta a cero); los descriptores se cierran después, en segundo plano. Tras el evento `session:locked`, la ventana se sustituye por una nueva (13.3) y la antigua se destruye con su proceso de renderer, así que ninguna petición pendiente sobrevive.

---

## 12. Pipeline de importación seguro (`src/main/import/`)

### 12.1 Orígenes

- **"Importar archivos"** (`import:chooseFiles`): `dialog.showOpenDialog({ properties: ['openFile', 'multiSelections', 'dontAddToRecent'], filters: [{ name: 'Fotos y vídeos', extensions: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'avif', 'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi'] }] })`. Sin BMP, HEIC ni RAW. El filtro es solo una ayuda: lo que decide es la firma (12.3).
- **"Importar carpeta"** (`import:chooseFolder`): `properties: ['openDirectory', 'dontAddToRecent']`. Son dos botones distintos porque en Windows no se pueden elegir archivos y carpetas en el mismo diálogo.
- `dontAddToRecent` (Windows; existe en los tipos de Electron 44.9.3) evita que el archivo elegido se añada a "Documentos recientes". No impide que el diálogo común actualice su historial interno (límite 2 de 24.2). Todos los diálogos de la app (importar, música, avatar, mover y localizar la bóveda) lo llevan.
- **Arrastrar y soltar** archivos y carpetas sobre la galería (12.2).

### 12.2 Arrastrar y soltar

- El renderer escucha `dragover`/`drop` en `ImportDropZone`, hace `preventDefault` y muestra el overlay "Suelta para importar". Al soltar llama a `galeria.importDropped(Array.from(e.dataTransfer.files))`.
- Con una importación activa (12.11) el overlay dice "Espera a que termine la importación en curso" y soltar no invoca nada. Si aun así llega un `BUSY` (carrera), se muestra el mismo texto en un toast.
- En el preload, cada elemento tiene que ser `instanceof File`. La ruta se obtiene con `webUtils.getPathForFile(file)` (sirve también para carpetas) y se descartan las vacías, que corresponden a `File` creados en JS y no a archivos del disco. Después se invoca `import:paths`.
- El renderer nunca ve las rutas y no puede inventar rutas para borrar, porque `import:paths` no está en la allowlist genérica.
- Main valida las rutas igualmente (12.3). Las rutas de `chooseFiles` y `chooseFolder` salen del diálogo nativo en main.

### 12.3 Validación de cada candidato (antes de tocar nada)

Todo esto ocurre en la fase `scanning` del trabajo, antes de procesar ningún archivo.

1. `lstat(p, { bigint: true })`:
   - los enlaces simbólicos y las junctions se omiten (`skipped`), así nunca se borra el destino de un enlace;
   - las carpetas se recorren de forma recursiva (`walk.ts`, sin seguir enlaces, hasta 32 niveles de profundidad y 100 000 archivos por trabajo);
   - lo que no es un archivo regular se omite;
   - de cada archivo se guarda `snapshot = { dev, ino, size, mtimeNs }` como `bigint`. En Windows, `ino` es el file index de NTFS, que puede pasar de 2^53 y perdería precisión como `number`. Todas las comparaciones posteriores son exactas sobre los cuatro campos.
2. Se rechazan las rutas dentro de `GaleriaData` o de cualquier `vaultDir` (`skipped`) y las rutas de dispositivo (`\\.\`, `\\?\GLOBALROOT`).
3. **Formato por firma de bytes** (`sniff.ts`, lee hasta 512 bytes; la extensión solo se usa como pista). En las firmas `ftyp`, el brand mayor está en los bytes 8–11 y las compatible brands van de 4 en 4 desde el byte 16 hasta el final de la caja (`uint32_be` de los bytes 0–3, limitado a 512). Las filas con `ftyp` se evalúan en este orden: HEIC (rechazo), AVIF, `mif1`/`msf1`/`miaf`, MOV y, por último, MP4:

| Firma | Formato | Tipo |
|---|---|---|
| `FF D8 FF` | JPEG | foto |
| `89 50 4E 47 0D 0A 1A 0A` | PNG | foto |
| `RIFF....WEBP` | WebP | foto |
| `GIF87a` / `GIF89a` | GIF | foto |
| `....ftyp` con brand mayor `avif` / `avis` | AVIF | foto |
| `....ftyp` con brand mayor `mif1` / `msf1` / `miaf` | AVIF si alguna compatible brand es `avif`/`avis`; HEIC si alguna es `heic`, `heix`, `heim`, `heis`, `hevc` o `hevx` (rechazado, fila HEIC); si no, `UNSUPPORTED_FORMAT` | foto o rechazo |
| `....ftyp` con brand `qt  ` | MOV | vídeo (remultiplexar o convertir según 12.5) |
| `....ftyp` con otro brand (isom, mp41, mp42, avc1, dash, iso5…) | MP4 | vídeo |
| `1A 45 DF A3` + DocType `webm` / `matroska` | WebM / MKV | vídeo (MKV: remultiplexar o convertir según 12.5) |
| `RIFF....AVI ` | AVI | vídeo (remultiplexar o convertir según 12.5) |
| `....ftyp` con brand mayor `heic`/`heix`/`heim`/`heis`/`hevc`/`hevx` (o vía `mif1`/`msf1`/`miaf`, arriba), CR2/NEF/ARW/DNG/ORF/RAF/RW2; `42 4D` con un tamaño de cabecera DIB válido (`uint32_le` del byte 14 ∈ {12, 40, 52, 56, 64, 108, 124}) | HEIC / RAW / BMP | **rechazado**, también dentro de carpetas: cuenta en `failed` con `UNSUPPORTED_FORMAT` ("HEIC, RAW y BMP no son compatibles") y el original no se toca |
| cualquier otra | – | dentro de carpetas, `skipped` sin aviso; si se eligió explícitamente, `UNSUPPORTED_FORMAT` |

Un vídeo (MP4, MOV, WebM, MKV o AVI por firma) cuyo `ffprobe` (12.5) no encuentra ninguna pista de vídeo, por ejemplo un `.m4a` dentro de una carpeta, se trata como "cualquier otra": `skipped` dentro de carpetas y `UNSUPPORTED_FORMAT` si se eligió explícitamente.

4. **Límites**:
   - fotos ≤ 256 MiB (se procesan en memoria) y ≤ 268 megapíxeles (`limitInputPixels` de sharp);
   - vídeos ≤ 64 GiB;
   - por encima, `TOO_LARGE`.
5. **Espacio libre** (`fs.statfs` sobre `vaultDir`): tiene que ser ≥ tamaño × 1,2 + 100 MiB; si no, `DISK_FULL`. Se comprueba de nuevo antes de cada archivo; si falla, se detiene el trabajo, porque los siguientes tampoco cabrían.
6. **Preescaneo de vídeos**: `ffprobe` de cada vídeo candidato (línea de 12.4, paso 0) y decisión de la acción (12.5). Se guarda el resultado por archivo y el paso 0 lo reutiliza. Si hay vídeos que exigen recodificar (12.5.1), el trabajo pasa a `awaiting-confirmation` antes de tocar nada.

### 12.4 Pasos por archivo

Los archivos se procesan de uno en uno, en orden. Al empezar cada archivo se repite `lstat(p, { bigint: true })`: si `{ dev, ino, size, mtimeNs }` no coincide con el `snapshot` del escaneo, el archivo cuenta como `failed: CHANGED_DURING_IMPORT` y su original no se toca.

| # | Paso | Detalle | Si falla |
|---|---|---|---|
| 0 | Sondear | Foto: `readFile` a un buffer (es la única lectura del contenido) y `exifr.parse(buffer, { tiff: true, exif: true, gps: true, ifd0: true, translateValues: false, reviveValues: false })` (las fechas llegan como texto y las convierte `capture-date.ts`, 12.8). Vídeo: se reutiliza el resultado del preescaneo (12.3, punto 6), obtenido con `ffprobe -v error -print_format json -show_format -show_streams -protocol_whitelist file,pipe -f <demuxer> <original>` (timeout 30 s, salida validada con zod), donde `<demuxer>` sale de la firma: `mov` para MP4/MOV, `matroska` para WebM/MKV y `avi` para AVI. Forzar el demuxer evita que ffmpeg autodetecte otro formato a partir del contenido | `UNSUPPORTED_FORMAT`, `FFMPEG_MISSING`, `FFMPEG_FAILED`, `IO`. Original intacto |
| 1 | Duplicado | `hmac = HMAC(K_dedup, original)`. Fotos: sobre el buffer. Vídeos: una pasada previa de lectura en streaming del original, siempre (también si luego se procesa con ffmpeg), para no cifrar ni procesar algo que ya está en la bóveda. Si existe una fila con ese `content_hmac`, va al flujo de duplicado (12.7, que distingue `ready` de `pending`) | `IO` → original intacto |
| 2 | Cifrar a temporal | `createObjectWriter({ kind: 1, fileId: id, tmpPath: tmp/<id>.part })`. Foto: `write(buffer)`. Vídeo tal cual (`converted = 0`): `fs.createReadStream(original)` → writer (SHA-256 del stream = `hashA`). Vídeo procesado con ffmpeg (remultiplexado o recodificado, `converted = 1`, 9.2): `ffmpeg … pipe:1` → writer (12.5). `finish()` hace `fsync` | `DISK_FULL`, `IO`, `FFMPEG_FAILED` → `abort()` (borra `.part`). Original intacto |
| 3 | Verificar | `openObject(tmp)` → descifrar entero en streaming, calculando el SHA-256 (`hashB`). Tiene que ser `hashB == hashA` (`hashA` es el SHA-256 de lo que entró al writer). Foto: además `hashA == SHA-256(buffer)`. Vídeo procesado con ffmpeg, **tanto remultiplexado como recodificado**: además `ffprobe` del temporal por loopback; tiene que tener una pista de vídeo y una duración igual a la del original ±max(1 s, 2 %). Es la comprobación que detecta un remultiplexado truncado que ffmpeg terminó con código 0 (AVI con `+genpts`, audio copiado a MP4) | `INTEGRITY` → borrar `.part`. Original intacto |
| 4 | Miniatura y metadatos | Foto: `const sharp = await getSharp()` (`media/sharp-loader.ts`, abajo) → `sharp(buffer, { sequentialRead: true, limitInputPixels: 268402689 })` → `.autoOrient()` (orientación EXIF) → `.resize(512, 512, { fit: 'inside', withoutEnlargement: true })` → `.webp({ quality: 78 })`. Vídeo: fotograma en `t = min(1 s, 10 % de la duración)` leído **del objeto temporal por loopback**: `ffmpeg -v error -protocol_whitelist http,tcp,pipe -ss <t> -f <mov\|matroska> -i http://127.0.0.1:<p>/<token>/<ref> -frames:v 1 -f image2pipe -c:v png pipe:1` (demuxer según el MIME almacenado: `video/mp4` → `mov`, `video/webm` → `matroska`) → sharp → WebP (si falla, se reintenta en `t = 0`). Miniatura → `createObjectWriter({ kind: 2 })` → `tmp/<thumbId>.part` + `fsync`. Metadatos: dimensiones de visualización (en vídeos, intercambiando ancho y alto si la rotación es ±90°, 12.5), `captured_at` (12.8), EXIF saneado | Si la miniatura falla con el original válido: se importa sin miniatura (`thumb_id = NULL`, la UI muestra un icono genérico) y se registra un `warn`. Otros errores: borrar los `.part` (`IO`). Original intacto |
| 5 | Insertar en DB | Una transacción: `INSERT media (state = 'pending', name, original_ext, …)` + `media_exif`, con `name` y `original_ext` de 12.4.1. Antes del paso 6, `id` y `thumbId` se registran en `inFlight` (12.6) | `IO`/`INTERNAL` → borrar los `.part`. `SQLITE_CONSTRAINT_UNIQUE` en `content_hmac` (una fusión en paralelo insertó el mismo contenido, 12.11): borrar los `.part` y contar el archivo como `skipped`. Original intacto en los dos casos |
| 6 | Renombrar | Primero `rename(tmp/<id>.part → objects/<aa>/<id>)` y después `rename(tmp/<thumbId>.part → thumbs/<aa>/<thumbId>)` (mismo volumen, así que es atómico). Linux: `fsync` de los directorios. Hasta 5 reintentos `EPERM`/`EBUSY` | Borrado criptográfico (12.10) de `objects/<aa>/<id>` si llegó a moverse, borrado de los `.part` que queden, `DELETE` de la fila `pending` y salida de `inFlight`; `IO`. Original intacto |
| 7 | Confirmar | `UPDATE media SET state = 'ready'`, salida de `inFlight` y evento `library:changed` | Lo resuelve la reconciliación (12.6). Original intacto |
| 8 | Comprobar el original | `secure-delete.ts` abre el original con `fs.open(p, O_RDWR \| (linux ? O_NOFOLLOW : 0))` y hace `fstat(fd, { bigint: true })` **sobre el descriptor**, así que lo comprobado es exactamente lo que se va a sobrescribir. `{ dev, ino, size, mtimeNs }` tiene que coincidir con el `snapshot`. Si no se puede abrir para escritura (`EPERM`/`EACCES`/`EROFS`), se hace `lstat(p, { bigint: true })`, se compara igual y se pasa directamente al `unlink` del paso 9 | Si no coincide: se cierra, se conserva el original y se notifica `originalsNotDeleted { reason: 'CHANGED_DURING_IMPORT' }`. La copia queda importada |
| 9 | Borrar el original | **Enlace duro** (`st.nlink > 1n`): no se sobrescribe, porque los ceros llegarían también a los otros nombres del archivo, que no forman parte de la importación. Se cierra, se hace solo `unlink(p)` y se registra `warn` `import.original.hardlink` (sin la ruta). **Caso normal** (`nlink == 1`): sobrescribir con ceros en bloques de 1 MiB por el mismo descriptor, `fsync`, `ftruncate(0)`, `fsync`, cerrar y `unlink`. Linux: limpieza de miniaturas freedesktop (12.9) y de `recently-used.xbel` (12.9.1) | Si `unlink` falla: `originalsNotDeleted { reason: 'IO' }` con la ruta, para que el usuario lo borre a mano; `warn` sin la ruta. La copia queda importada |

Garantía: el original solo se toca en el paso 9, después de que la copia cifrada esté verificada, renombrada a su sitio y confirmada en la DB. Cualquier fallo anterior deja el original intacto. Con enlaces duros, los demás nombres conservan su contenido (límite 1 de 24.2).

**sharp sin temporales en disco** (`src/main/media/sharp-loader.ts`, F1). Es el único módulo que puede cargar `sharp`. En el resto de `src/`, `@typescript-eslint/no-restricted-imports` prohíbe importarlo (con `allowTypeImports: true`, para poder usar sus tipos) y `no-restricted-syntax` prohíbe `ImportExpression[source.value='sharp']`, porque `no-restricted-imports` no revisa los `import()` dinámicos:

```ts
// libvips descomprime a un archivo temporal (%TEMP%/$TMPDIR, "vips-*.v") cuando una carga necesita
// acceso aleatorio y la imagen descomprimida supera VIPS_DISC_THRESHOLD (100 MB por defecto).
// 4g > 268 MP × 4 canales × 2 B ≈ 2,1 GB, el máximo que admite limitInputPixels: nunca usa disco.
let cached: typeof import('sharp') | undefined;
export async function getSharp(): Promise<typeof import('sharp')> {
  if (!cached) {
    process.env.VIPS_DISC_THRESHOLD = '4g';  // antes de cargar libvips
    const mod = (await import('sharp')).default;
    mod.cache(false);                       // sin caché de operaciones con píxeles descifrados
    cached = mod;
  }
  return cached;
}
```

- Se carga de forma perezosa con `import()` porque Rollup coloca los `require()` estáticos de los módulos externos al principio del bundle de main, antes de cualquier código de la app (5.4, punto 10), y así no se podría garantizar que la variable esté puesta antes.
- Todas las llamadas pasan `{ sequentialRead: true, limitInputPixels: 268402689 }` de forma explícita, también en `avatars.ts` y `edits-render.ts` (16.3).
- **Observado el 22-oct-2026 en esta máquina** (sharp 0.35.5, libvips 8.18.7, Windows): con un TEMP privado vigilado con `fs.watch` (control positivo: detecta un archivo de 1 MiB creado y borrado en milisegundos), ninguna de estas operaciones creó archivos, ni siquiera con `VIPS_DISC_THRESHOLD=1m`: PNG entrelazado y PNG normal de 12000×10000, JPEG de 12000×10000 con orientación 6, con `resize`, `autoOrient` y la cadena de edición `autoOrient().flop().rotate(90).extract()`, desde buffer y desde ruta, con `sequentialRead` verdadero y falso. El umbral se fija igualmente: el comportamiento puede cambiar con la versión de libvips, con otros formatos (GIF y WebP animados, AVIF) y en Linux, y el coste es nulo.
- **Test obligatorio** (F2, `tests/unit/main/no-temp-leak.test.ts`, en Windows y en Linux): en un proceso hijo con `TMP`, `TEMP` y `TMPDIR` apuntando a un directorio vacío propio y vigilado con `fs.watch` (con el control positivo anterior), generar y procesar con miniatura y `edits-render` un JPEG de 8000×6000 con orientación 6, un PNG entrelazado de 16 bits de 6000×6000, un GIF animado de 40 fotogramas de 2000×2000 y un AVIF de 6000×4000. El directorio tiene que seguir vacío y el vigilante no puede haber visto ninguna entrada.

**Cancelar** (`import:cancel`, la sesión sigue abierta): en `scanning` o `awaiting-confirmation` el trabajo termina sin haber tocado nada. Durante el procesamiento, el archivo en curso se aborta en el siguiente límite entre pasos si todavía no ha llegado al paso 5. Si ya lo pasó, se completan los pasos 5–7 (unos milisegundos) y **no** se ejecutan el 8 ni el 9: el original se conserva y se notifica como no borrado por cancelación. Los archivos que faltan no se procesan.

**Bloquear** durante un trabajo: el bloqueo **no espera** a la importación más allá de la espera acotada de 13.3, paso 3 (0 ms en suspensión y bloqueo del SO). El `AbortSignal` del trabajo se dispara en el paso 2, el writer en curso pone su DEK a cero en ese mismo instante (7.7) y la DB se cierra en el paso 4. Después de cada `await`, el trabajo comprueba `signal.aborted`: si el archivo en curso no había llegado al paso 5, se abandona; si ya lo pasó, intenta completar los pasos 6 y 7 como con "Cancelar" (solo da tiempo durante la espera de 2 s de los bloqueos `manual`, `inactivity` y `shutdown`). Cualquier acceso a la DB o a las claves después del paso 4 lanza `LOCKED`, que el trabajo trata como cancelación. Nunca se ejecutan los pasos 8 y 9 tras un bloqueo: el original se conserva. Lo que quede a medias lo resuelve la reconciliación del siguiente desbloqueo (12.6): una fila `pending` con su objeto o su `.part`, o `.part` sueltos. Los `.part` del trabajo abortado se borran en segundo plano (`KeylessCleanup`, 13.3, paso 6) y, si no da tiempo, en el siguiente desbloqueo (12.6, punto 4).

Las carpetas de origen no se borran nunca, aunque queden vacías.

#### 12.4.1 Nombre y extensión del medio importado (`import/naming.ts`, puro)

`deriveName(basename, detectedExt) → { name, originalExt }`, a partir del nombre de archivo del original (sin la carpeta):

1. Se busca el **último** punto del nombre. Si existe, `stem` = lo anterior y `suffix` = lo posterior (`".jpg"` da `stem = ""` y `suffix = "jpg"`; `"foto."` da `suffix = ""`). Si no hay punto, `stem` = el nombre entero y `suffix = ""`.
2. Si `suffix.toLowerCase()` cumple `/^[a-z0-9]{1,16}$/`, `originalExt` = ese valor en minúsculas. Si no (vacío, más de 16 caracteres u otros caracteres, como en `"foto.versión final"`), `originalExt = detectedExt` (la extensión canónica del formato detectado por firma: `jpg`, `png`, `webp`, `gif`, `avif`, `mp4`, `webm`, `mkv`, `mov` o `avi`) y el punto deja de considerarse separador: `stem` = el nombre entero.
3. `name` = `stem` normalizado a NFC, sin los caracteres `\p{Cc}` (controles, incluidos `\n` y `\t`), con `trim` y recortado a los primeros 255 code points (`[...s].slice(0, 255).join('')`, que no parte pares sustitutos). Si queda vacío, `name = "Sin nombre"`.
4. `name_fold` se calcula sobre `name` (9.2).

Las fusiones no pasan por aquí: usan el nombre del diálogo (10.3) y `original_ext = 'mp4'`. Test (F2): `.jpg` → `Sin nombre` + `jpg`; un nombre de 300 code points con emojis → 255 code points sin pares rotos; `"a\nb.png"` → `ab` + `png`; `"archivo"` (JPEG por firma) → `archivo` + `jpg`; `"foto.versión final"` → `foto.versión final` + la extensión detectada; `"IMG_0001.JPG"` → `IMG_0001` + `jpg`.

### 12.5 Vídeos: reproducir tal cual, remultiplexar o convertir (`video-pipeline.ts`)

Con la salida de ffprobe (primera pista de vídeo, primera de audio). Si no hay ninguna pista de vídeo, el archivo no es un vídeo admitido (12.3, tras la tabla de firmas). **Dimensiones de visualización**: `width`/`height` de la pista; si su rotación es ±90° o ±270°, se intercambian. La rotación se toma de `side_data_list[].rotation` (Display Matrix) y, si no existe, de `tags.rotate`.

| Contenedor | Vídeo | Audio | Acción | MIME almacenado |
|---|---|---|---|---|
| MP4 | h264, vp9, av1 | aac, mp3, opus, flac o ninguno | Tal cual | `video/mp4` |
| WebM | vp8, vp9, av1 | vorbis, opus o ninguno | Tal cual | `video/webm` |
| MOV/MKV/AVI | h264, vp9, av1 | aac, mp3, opus, flac o ninguno | Remultiplexar `-c copy` a MP4 fragmentado (AVI: añadir `-fflags +genpts` antes de `-i`) | `video/mp4` |
| Cualquiera | h264, vp9, av1 | otro (pcm, ac3, dts, wma…) | Copiar el vídeo y convertir el audio a Opus | `video/mp4` |
| Cualquiera | otro (hevc, mpeg4, mpeg2, wmv, prores, vp8 fuera de WebM…) | cualquiera | Convertir el vídeo a VP9 (+ audio según la fila anterior) | `video/mp4` |

Base de la línea de comandos (todo va a `pipe:1`, nunca a un archivo):

```
ffmpeg -hide_banner -nostdin -v error -progress pipe:2 -nostats -protocol_whitelist file,pipe
       -f <mov|matroska|avi> -i <ruta original> -map 0:v:0 -map 0:a:0? -sn -dn
       <VIDEO> <AUDIO>
       -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1
<VIDEO> copiar:     -c:v copy
<VIDEO> convertir:  -c:v libvpx-vp9 -deadline good -cpu-used 5 -row-mt 1 -crf 31 -b:v 0
                    -pix_fmt yuv420p -force_key_frames "expr:gte(t,n_forced*4)"
<AUDIO> copiar:     -c:a copy
<AUDIO> convertir:  -c:a libopus -b:a 160k -ac 2
```

Detalles:

- El progreso se lee de `out_time_us` en stderr y se compara con la duración de ffprobe. Se emite la fase `converting`.
- Un código de salida ≠ 0 da `FFMPEG_FAILED`. Se registra un `warn` con las últimas 2 KiB de stderr, que no contienen el nombre del archivo porque se pasa `-v error` y el error se recorta para quitar la ruta del input (`replaceAll(ruta, '<input>')`).
- `-f <demuxer>` es el mismo que en el paso 0 de 12.4 (por firma). Para AVI, `-fflags +genpts` va antes de `-f avi -i`.
- Terminología (9.2): "procesar con ffmpeg" = remultiplexar o recodificar, y los dos casos guardan `converted = 1`, calculan el HMAC sobre el original y pasan la comprobación de `ffprobe` del paso 3 de 12.4. "Recodificar" (convertir el vídeo o el audio, las dos últimas filas) es con pérdida y es lo único que pide confirmación (12.5.1, punto de decisión D8).
- MP4 fragmentado: ver 18.4 para la justificación y la verificación de duración y búsqueda.
- **Tests de F2** con fixtures generados: un MKV VP9 + Opus y un MKV VP9 + FLAC se remultiplexan a MP4 con `-c copy`, pasan el paso 3 y se reproducen en `<video>` (duración finita y búsqueda); reimportar el MKV original después cuenta como `duplicates`, no como sustitución (12.7). Si el muxer MP4 de FFmpeg 8.1 exigiera `-strict experimental` para copiar Opus o FLAC (no verificado), ese códec de audio pasa a la fila "Copiar el vídeo y convertir el audio a Opus", con la confirmación de 12.5.1, y se anota aquí; nunca se añade `-strict experimental`.

#### 12.5.1 Confirmación de conversiones (D8)

- **Qué cuenta**: los vídeos cuya acción recodifica el vídeo o el audio (las dos últimas filas de la tabla). Remultiplexar con `-c copy` no pierde calidad y no pide confirmación.
- **Cuándo**: al terminar `scanning` (12.3, punto 6), si `toConvert > 0`. Main pone el trabajo en `phase: 'awaiting-confirmation'`, emite `import:confirmNeeded { jobId, toConvert, toConvertBytes }` (suma de los tamaños de esos originales) y espera. No se ha tocado ningún archivo.
- **Respuesta** (`import:confirm { jobId, convert }`):
  - `convert: true`: se procesa todo;
  - `convert: false`: se omiten esos vídeos, que cuentan como `skipped` con sus originales intactos, y se procesa el resto;
  - `import:cancel { jobId }`: se cancela el trabajo entero sin tocar nada.
- **Sin timeout**. Bloquear la sesión mientras se espera cancela el trabajo. Mientras el trabajo está en `awaiting-confirmation`, el temporizador de inactividad **no** está en pausa (13.2, D18): si el usuario se va con el diálogo abierto, la sesión se bloquea y el trabajo se cancela sin haber tocado nada.
- **UI** (14.6): `AlertDialog` "N vídeos (X GB) se convertirán a un formato compatible, con pérdida de calidad, y su original se borrará al terminar." con "Convertir y borrar originales", "Omitir esos vídeos" y "Cancelar importación". El foco inicial está en "Omitir esos vídeos", la opción que no pierde nada. Esc equivale a "Cancelar importación".

### 12.6 Reconciliación al desbloquear (`vault/reconcile.ts`)

Antes de mostrar la galería:

1. Para cada `media` con `state = 'pending'` (al desbloquear no hay trabajos, así que `inFlight` está vacío):
   - **objeto**:
     - si el objeto final `objects/<aa>/<id>` existe, se sigue con la miniatura;
     - si no existe pero `tmp/<id>.part` sí, se verifica (`openObject` con `kind = 1` y el `fileId` esperado + leerlo entero con todos los tags). Si verifica, se renombra a su sitio. Si **no** verifica (por ejemplo, un `.part` sin cabecera porque el bloqueo llegó antes de `finish()`), se hace el borrado criptográfico del `.part` (12.10), se borra la fila (con la miniatura, abajo) y se registra un `warn` (`reconcile.pending.dropped`, con el `mediaId`);
     - si no hay ninguno de los dos, se borran la fila y su miniatura;
   - **miniatura** (solo si la fila sigue y `thumb_id` no es `NULL`): si `thumbs/<aa>/<thumbId>` no existe pero `tmp/<thumbId>.part` sí, se verifica igual (`kind = 2`) y, si verifica, se renombra a `thumbs/<aa>/<thumbId>`; si no verifica, borrado criptográfico del `.part`, y el punto 3 la regenera;
   - se marca `ready`.
2. **Sustituciones a medias** (12.7, punto 3): para cada clave `kv` `import.replace.<newId>` con valor `{ old, hmac }`:
   - si la fila `newId` existe (ya `ready` tras el punto 1), se ejecuta la transacción B de 12.7 y, tras el `COMMIT`, el borrado criptográfico de los objetos antiguos;
   - si la fila `newId` ya no existe, se restaura `UPDATE media SET content_hmac = :hmac WHERE id = :old`, con `:hmac` enlazado como `Buffer.from(valor.hmac, 'hex')` (nunca interpolado en el SQL), y se borra la clave. La fila antigua vuelve a su estado anterior (dañada, pero visible y deduplicable).
   - Si el valor no valida con su esquema zod (9.2), no se toca nada, se registra un `error` (`reconcile.replace.invalid`) y la clave se conserva para diagnóstico; la fila antigua sigue visible con un HMAC aleatorio (no deduplica).
3. **Miniaturas ausentes**: cada fila `ready` cuyo `thumb_id` no tiene archivo en `thumbs/` pasa a `thumb_id = NULL` y su id entra en una cola de regeneración de esta sesión (en segundo plano, una cada vez, con 16.5 pasos 2–6 para fotos y la extracción de fotograma de 12.4 para vídeos). Las filas que ya tenían `thumb_id = NULL` desde la importación no se reintentan.
4. Se borran los `tmp/*.part` que queden.
5. **Música** (8.6.1): se borran `music/*.part` y los archivos de `music/` sin fila; las filas de `music_tracks` sin archivo se borran y su id se quita de `kv['presentation.defaultTracks']`.
6. **`pendingCleanup`** (8.2): si el perfil lo tiene, `removeVaultDir(pendingCleanup, id, 'vault')` en segundo plano a través de `KeylessCleanup` (13.3, paso 6; si ya hay una tarea sobre esa ruta, se une a ella); si termina bien, se quita el campo.
7. En segundo plano y con baja prioridad (1 directorio `aa` cada 50 ms), los objetos y miniaturas sin fila en la DB (huérfanos de borrados interrumpidos) se borran con borrado criptográfico (12.10). El barrido **ignora los ids del conjunto `inFlight`** (`vault/in-flight.ts`): importación, edición (16.5) y fusión (18.6) registran el id de cada objeto y miniatura nuevos antes de renombrarlos a su sitio y los liberan después del `COMMIT` que los referencia, o tras limpiar un fallo. Además, el barrido vuelve a consultar la DB justo antes de borrar cada archivo.

Los originales afectados por un fallo nunca se borraron, así que si el usuario los reimporta se detectan como duplicados (12.7).

### 12.7 Duplicados

Búsqueda: `SELECT id, state, converted FROM media WHERE content_hmac = ?`.

- Si no hay fila, es una importación nueva.
- Si la fila está `pending` (de otro trabajo en curso, como una fusión en paralelo, 12.11, o de un archivo de esta sesión cuyo paso 7 falló y que resolverá la reconciliación), el archivo cuenta como `skipped` y su original no se toca. Nunca se trata como "objeto dañado".
- Si la fila está `ready`, se sigue con estos pasos:

1. Se verifica que el objeto existente está sano (`openObject` + descifrarlo entero, con el tag correcto). Si `converted = 0` (lo almacenado es el original byte a byte, 9.2), además se exige `HMAC(K_dedup, descifrado) == content_hmac`. Con `converted = 1` (salida de ffmpeg, incluidos los remultiplexados) esa comprobación no aplica, porque el HMAC se calculó sobre el original y no sobre lo almacenado.
2. Si la verificación pasa, se cuenta como `duplicates` y **el original se borra** (pasos 8 y 9), porque su contenido ya está a salvo en la bóveda. Es coherente con "importar = mover a la bóveda" (punto de decisión D7).
3. Si la verificación falla (objeto dañado), se trata como una importación nueva que **sustituye** al objeto dañado (`:old`) y conserva su nombre, su fecha de importación, sus ediciones y sus posiciones en las playlists. Sigue los pasos de 12.4 con id nuevo (`:new`), salvo los pasos 5 y 7:
   - **Paso 5 (transacción A)**:
     ```sql
     UPDATE media SET content_hmac = randomblob(32) WHERE id = :old;   -- libera el UNIQUE
     INSERT INTO media (…, state, content_hmac, …) VALUES (…, 'pending', :hmac, …);
     INSERT INTO media_exif …;
     INSERT INTO kv (key, value_json) VALUES ('import.replace.' || :new, json_object('old', :old, 'hmac', lower(hex(:hmac))));  -- hex() da mayúsculas
     ```
   - **Paso 7 (transacción B**, en lugar del `UPDATE … 'ready'` normal):
     ```sql
     UPDATE media SET state = 'ready',
       name        = (SELECT name        FROM media WHERE id = :old),
       name_fold   = (SELECT name_fold   FROM media WHERE id = :old),
       imported_at = (SELECT imported_at FROM media WHERE id = :old)
     WHERE id = :new;
     INSERT INTO media_edits (media_id, seq, op_json, created_at)
       SELECT :new, seq, op_json, created_at FROM media_edits WHERE media_id = :old;
     UPDATE playlist_items SET media_id = :new WHERE media_id = :old;   -- :new aún no está en ninguna playlist
     DELETE FROM media WHERE id = :old;                                -- la cascada solo borra ya su EXIF y sus ediciones copiadas
     DELETE FROM kv WHERE key = 'import.replace.' || :new;
     ```
   - **Después del `COMMIT`**: borrado criptográfico (12.10) del objeto y la miniatura de `:old`. Si se copiaron ediciones, se regenera la miniatura de `:new` con 16.5, pasos 2–6. Después se siguen los pasos 8 y 9 (borrar el original) como en una importación normal.
   - **Caída entre A y B**: la reconciliación (12.6, punto 2) termina la sustitución o la deshace con el HMAC guardado en `kv`. No se pierde nada.
   - **Test** (F2): un objeto existente corrompido + reimportar el mismo archivo conserva el nombre, la fecha de importación, las ediciones y la posición en dos playlists; y la misma prueba con una caída simulada entre A y B, antes y después de la reconciliación.

### 12.8 Fecha de captura (`import/capture-date.ts`, puro)

- **Foto**: `DateTimeOriginal` → `CreateDate` → `mtime` del archivo, con `captured_at_source` = `exif` o `file_mtime`.
- **Vídeo**: `format.tags.creation_time` (UTC) convertido a hora local naive (`container`) → `mtime`.
- **Fusión**: la fecha actual (`generated`).

La hora "naive" son los componentes de la fecha de pared codificados con `Date.UTC(...)`. Para que una hora de pared que no existe en la zona de la máquina (el hueco del cambio de hora) no se desplace, las fechas EXIF **nunca** pasan por un `Date` local:

- `exifr.parse` se llama con `reviveValues: false` (12.4, paso 0), así que `DateTimeOriginal` y `CreateDate` llegan como texto `"YYYY:MM:DD HH:MM:SS"` (comprobado en la documentación y el código de exifr 7.1.3).
- `parseExifDate(s)`: `/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/`; se exige año 1900–2999, mes 1–12, día válido para ese mes (años bisiestos incluidos), hora 0–23, minuto y segundo 0–59, y se devuelve `Date.UTC(y, m − 1, d, hh, mm, ss)`. Cualquier otro valor (vacío, `"0000:00:00 00:00:00"`, fuera de rango, sin coincidencia o que no sea string) devuelve `null` y se pasa a la siguiente fuente.
- `OffsetTimeOriginal` (`"+02:00"`) se parsea con `/^([+-])(\d{2}):(\d{2})$/` a `tz_offset_min`; no cambia `captured_at`.
- GPS: exifr 7.1.3 calcula `latitude`/`longitude` a partir de las etiquetas crudas también con `reviveValues: false` (comprobado en su código); se guardan solo si son números finitos dentro de [−90, 90] y [−180, 180].
- Las demás etiquetas numéricas (`FNumber`, `ExposureTime`, `ISO`, `FocalLength`, `Orientation`) se usan solo si son números finitos; si no, se omiten.

Instantes reales (`creation_time` del contenedor, `mtime`), que sí son un momento concreto, se pasan a componentes de pared locales con los getters locales, que no tienen el problema del hueco:

```ts
const d = new Date(Number(mtimeNs / 1_000_000n));   // o new Date(creation_time) si es una fecha ISO válida
Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
```

Tests (F2, con `TZ=Europe/Madrid` en el proceso de Vitest): `"2026:03:29 02:30:00"` (hora que no existe en Madrid) da exactamente `Date.UTC(2026, 2, 29, 2, 30, 0)`; `"0000:00:00 00:00:00"`, `"2026:02:30 10:00:00"` y `""` pasan a `mtime`; un `creation_time` `"2026-10-25T00:30:00Z"` da la hora de pared de Madrid de ese instante.

### 12.9 Linux: miniaturas freedesktop (`linux-thumbnails.ts`)

Después de borrar el original (solo en `process.platform === 'linux'`):

1. `uri = 'file://' + percentEncode(rutaAbsoluta)`, con la misma regla que `g_filename_to_uri` de GLib (`g_escape_uri_string` con la máscara `UNSAFE_PATH` de la tabla `acceptable` de `glib/gconvert.c`): se codifica en UTF-8 y se escapa en `%XX` mayúsculas todo byte que no esté en `A–Z a–z 0–9 - . _ ~ ! $ & ' ( ) * + , = : @ /`. En particular se escapan el espacio, `"`, `#`, `%`, `;`, `<`, `>`, `?`, `[`, `\`, `]`, `^`, `` ` ``, `{`, `|`, `}`, DEL y todos los bytes ≥ 0x80. (La versión 1 de este diseño dejaba `;` sin escapar, lo que no coincide con esa tabla.)
   - **Vectores fijados con GLib** (F2, en Linux o WSL2; F7 los vuelve a comprobar): `python3 -c "import sys; from gi.repository import GLib; print(GLib.filename_to_uri(sys.argv[1], None))" <ruta>` para nombres que contengan `; # ? % [ ] & = + , ' ! $ ~ @`, un espacio y `á`. Los pares ruta → URI → MD5 resultantes quedan fijos en `tests/unit/main/linux-thumbnails.test.ts`; si algún carácter difiere de la regla anterior, manda GLib y se corrige la regla.
2. `md5 = MD5(uri)` en hex.
3. Para `base` en `${XDG_CACHE_HOME:-~/.cache}/thumbnails` y en la carpeta antigua `~/.thumbnails`, se borra `<base>/{normal,large,x-large,xx-large}/<md5>.png` y `<base>/fail/*/<md5>.png` (con sobrescritura best-effort).
4. Los errores se ignoran (`debug`).

Vector de test del spec: `file:///home/jens/photos/me.png` → `c6ee772d9e49320e97ec29a7eb5b1697` (comprobado con `node:crypto`).

Windows no tiene un equivalente por archivo: `thumbcache_*.db` no se puede limpiar selectivamente (límite documentado).

#### 12.9.1 Linux: archivos recientes de GTK (`linux-recent.ts`)

El selector de archivos de GTK (y el del portal de escritorio) añade los archivos elegidos a `${XDG_DATA_HOME:-~/.local/share}/recently-used.xbel`. Después de borrar cada original, y solo en Linux, best-effort:

1. Si el archivo no existe o pesa más de 16 MiB, no se hace nada.
2. Se lee como UTF-8 y se buscan los elementos `<bookmark …>…</bookmark>` con `/<bookmark\b[^>]*?\bhref="([^"]*)"[^>]*>[\s\S]*?<\/bookmark>\s*/g` (formato que escribe `GBookmarkFile`). Se decodifican las entidades XML de `href` (`&amp; &lt; &gt; &quot; &apos;`).
3. Se eliminan los elementos cuyo `href` es igual a la URI del original (12.9, punto 1). Si no hay ninguno, no se escribe nada.
4. Se escribe de forma atómica con el procedimiento de 8.3 (temporal `<archivo>.tmp-<8 hex>` en la misma carpeta + `fsync` + `rename`, sin la validación zod), conservando byte a byte el resto del archivo y sus permisos (`chmod` del temporal con el `mode` del original).
5. Cualquier error se ignora (`debug`). Si el contenido no tiene la forma esperada (no empieza por `<?xml` o no contiene `<xbel`), no se toca.

Para importaciones de muchos archivos se agrupa: una sola lectura y escritura al final de cada trabajo con el conjunto de URIs borradas.

### 12.10 Borrar medios de la bóveda (`media:delete`)

1. La UI confirma: "Se eliminarán N elementos de forma permanente. No se puede deshacer." con el foco inicial en "Cancelar".
2. En main, en una transacción, `DELETE FROM media WHERE id IN (…)`. Por cascada se borran los EXIF, las ediciones y los elementos de playlist.
3. Después del `COMMIT`, para cada objeto y miniatura se hace un **borrado criptográfico**: sobrescribir los 108 bytes de la cabecera con bytes aleatorios, `fsync` y `unlink`. Sin la DEK envuelta, el resto del archivo es ilegible aunque quede en el disco. Los objetos de la bóveda nunca tienen enlaces duros (los crea la app con nombres aleatorios), así que aquí no aplica la comprobación de `nlink` de 12.4.
4. Si algún `unlink` falla, se registra un `warn` y el barrido de la reconciliación lo borrará como huérfano.
5. Se emite `library:changed { reason: 'delete' }`.

### 12.11 Trabajos largos: concurrencia y auto-bloqueo (`session/jobs.ts`)

`JobRegistry` vive en `SessionManager` (una instancia por sesión desbloqueada) y es el único sitio que crea trabajos:

```ts
type JobKind = 'import' | 'merge' | 'music-import' | 'edit' | 'relocate';
interface JobHandle { id: Id; kind: JobKind; signal: AbortSignal; setPausesAutoLock(on: boolean): void; done(): void }
interface JobRegistry {
  start(kind: JobKind): JobHandle;     // lanza AppError('BUSY') si la regla de abajo no lo permite
  active(kind?: JobKind): JobHandle[];
  abortAll(reason: LockReason): void;  // síncrono: controller.abort(reason) de todos (13.3, paso 2)
}
```

La cola de regeneración de miniaturas de la reconciliación (12.6, punto 3) y el barrido de huérfanos (12.6, punto 7) no son trabajos de la tabla de abajo, pero se registran con el mismo `AbortController` de sesión, así que `abortAll` también los detiene.

**Reglas** (las aplica `start`, antes de abrir ningún diálogo):

| Trabajo | Como mucho | Puede coexistir con | Si se supera |
|---|---|---|---|
| `import` | 1 | `merge`, `edit`, `music-import` | `BUSY` en `import:chooseFiles`, `import:chooseFolder` e `import:paths`; la UI deshabilita "Importar" y el overlay de arrastre lo explica (12.2) |
| `merge` | 1 | `import`, `edit`, `music-import` | `BUSY` en `merge:start`; la UI deshabilita "Crear vídeo fusionado" mientras hay una en curso |
| `music-import` | 1 | `import`, `merge`, `edit` | `BUSY` en `music:import` (8.6.1) |
| `edit` | 1 por `mediaId` | todo salvo `relocate` | `BUSY` en `edits:save` del mismo medio |
| `relocate` | 1 | nada (8.7, paso 1) | `BUSY` en `vault:relocate` |

Una importación y una fusión en paralelo solo pueden producir el mismo contenido en un caso muy improbable (importar un archivo idéntico byte a byte a la fusión que se está generando), y está cubierto: la búsqueda de duplicados distingue `ready` de `pending` (12.7) y un `SQLITE_CONSTRAINT_UNIQUE` en el `INSERT` se trata como `skipped` en la importación (12.4, paso 5) y como "ya existía" en la fusión (18.6, paso 4).

**Auto-bloqueo por inactividad durante trabajos largos (D18)**. `auto-lock.ts` lleva un conjunto de motivos de pausa (`'playback'`, `'maintenance'`, `'job'`); el temporizador corre solo con el conjunto vacío y, cuando se vacía, se reinicia desde cero.

- **Fusión en curso**: pausa el temporizador (`setPausesAutoLock(true)` al empezar, `false` al terminar). **Confirmado por el usuario.**
- **Importación en curso**: pausa el temporizador en todas sus fases salvo `awaiting-confirmation`, en la que corre (12.5.1). **Recomendado, pendiente de confirmar por el usuario** (D18).
- `music-import`, `edit` y `relocate` no usan este motivo (las dos primeras son cortas; el traslado ya pausa con `'maintenance'`).
- En todos los casos, la **suspensión**, el **bloqueo del SO** y el **bloqueo manual** bloquean al momento y cancelan el trabajo (13.3).
- Mientras la pausa por trabajo está activa, el panel de progreso de la importación o de la fusión sigue visible.

Tests (F2 y F5, Vitest con reloj falso): con una importación en `scanning` o en `encrypting` y 10 min sin actividad no hay bloqueo; al entrar en `awaiting-confirmation` el temporizador arranca desde cero y bloquea a los `autoLockMinutes`, cancelando el trabajo sin tocar nada; con una fusión en curso no hay bloqueo por inactividad, pero un `suspend` simulado bloquea y cancela la fusión.

---

## 13. Sesión y bloqueo (`src/main/session/`)

### 13.1 Máquina de estados

`locked → unlocking → unlocked → locking → locked`. Dentro de `unlocked` existe el subestado `maintenance { jobId }`, solo mientras dura un traslado de la bóveda (8.7).

- `unlock` con otro perfil ya desbloqueado bloquea primero el actual (motivo `manual`).
- Las operaciones que requieren desbloqueo durante `unlocking`/`locking` devuelven `LOCKED`.
- En `maintenance`, los canales "U" devuelven `BUSY` salvo los de 5.6 (punto 4), el protocolo responde 503 `BUSY`, y el temporizador de inactividad y el vigilante de la bóveda están en pausa.

**Desbloqueo**:

1. Esperar a las tareas de traslado sin claves de ese perfil que estén entre los pasos 5 y 6 (13.3, paso 6) y cargar el perfil.
2. Comprobar `vault.json` (`VAULT_UNAVAILABLE` si falta o no coincide `profileId`).
3. Argon2id y desenvolver la MK (`WRONG_PASSWORD`).
4. HKDF para crear el KeyRing.
5. Abrir la DB y aplicar migraciones (`VAULT_CORRUPT`).
6. Reconciliar (12.6).
7. Arrancar el auto-bloqueo y el vigilante de la bóveda. Si `prefs.contentProtection`, `win.setContentProtection(true)` (D15, 5.2).
8. Pasar a `unlocked` (con `maintenance: null`).

Si falla cualquier paso, se deshace todo lo anterior (cerrar la DB, poner a cero el KeyRing) y se vuelve a `locked`.

### 13.2 Disparadores del bloqueo

| Disparador | Implementación |
|---|---|
| Manual | Botón de candado en la barra de título o la barra lateral y `Ctrl+L` → `session:lock` |
| Inactividad | Temporizador en main con `prefs.autoLockMinutes` (5 por defecto; 0 = desactivado). Se reinicia con `session:activity`, que el renderer envía con `pointerdown`, `keydown`, `wheel` y `pointermove`, como mucho una vez cada 10 s. Se **pausa** mientras haya algún motivo de pausa (12.11): `'playback'` con `session:setPlayback { active: true }` (una presentación o un vídeo reproduciéndose, D12), `'maintenance'` durante un traslado y `'job'` con una fusión o una importación en curso fuera de `awaiting-confirmation` (D18). Al quitarse el último motivo se reinicia desde cero |
| Suspensión | `powerMonitor.on('suspend')` en los dos SO |
| Bloqueo del SO | `powerMonitor.on('lock-screen')` (Windows). En Linux, ese evento no existe en Electron: se consulta `powerMonitor.getSystemIdleState(60)` cada 5 s y se bloquea si devuelve `'locked'`. Es best-effort: algunos escritorios Wayland no lo informan, y entonces solo actúan la suspensión y la inactividad (documentado) |
| Bóveda no disponible | Vigilante cada 10 s y errores de E/S (8.7). En pausa durante `maintenance` |
| Cierre de la app | `before-quit` → bloqueo (`shutdown`) antes de salir |

La suspensión, el bloqueo del SO, el bloqueo manual, la bóveda no disponible y los errores bloquean siempre, aunque el temporizador de inactividad esté en pausa, y cancelan los trabajos en curso (13.3).

### 13.3 Secuencia de bloqueo (main)

Principio: **las claves se ponen a cero sin esperar a los trabajos**. Esperar a que un trabajo termine (una importación de 2 GB, el borrado de una bóveda antigua de 100 000 objetos en un disco externo) dejaría la MK y las K_* en RAM durante ese tiempo, y en una suspensión el sistema no espera: Windows da muy poco margen tras `PBT_APMSUSPEND`, logind limita el inhibidor de tipo *delay* a 5 s por defecto y Electron no puede retrasar el reposo. Por eso los pasos 1–4 son **síncronos** con suspensión, bloqueo del SO, error y bóveda no disponible: se ejecutan dentro del mismo manejador del evento, antes de devolver el control al bucle de eventos.

1. **Velo**: estado `locking` y evento `session:locking { reason }` a la ventana actual; el renderer pinta al recibirlo un velo opaco del color de fondo del tema (abajo). Con `suspend` y `os-lock`, además, `win.hide()` de la ventana actual, que es una llamada nativa síncrona y saca el contenido de la pantalla aunque el renderer no llegue a pintar el velo antes del reposo. Desde este momento, los canales "U" devuelven `LOCKED` y `vault://` responde 423 (11.5).
2. **Abortar**: `jobs.abortAll(reason)` (12.11), que dispara de forma síncrona el `AbortController` de cada trabajo, de la cola de miniaturas y del barrido. Los manejadores de `abort` de cada trabajo, también síncronos: `destroyKeys()` de su `ObjectWriter` (7.7), `kill()` de sus procesos ffmpeg/ffprobe, `close()` + `closeAllConnections()` de su servidor loopback (18.5). Además, `controller.error()` en todos los streams de `vault://` abiertos (11.5).
3. **Espera acotada**: 0 ms si `reason ∈ { suspend, os-lock, error, vault-unavailable }`. Con `manual`, `inactivity` y `shutdown`, como mucho 2 s (`Promise.race` con los `done` de los trabajos abortados), solo para que una importación que esté entre sus pasos 5 y 7 confirme su transacción y deje menos trabajo a la reconciliación. Durante la espera las claves siguen en memoria, pero la UI ya está tapada y los trabajos ya están abortados.
4. **Claves y DB**: `db.close()`; `keyRing.zeroize()`; vaciar la caché de DEKs; `destroyKeys()` de todos los `ObjectReader` y `ObjectWriter` que sigan registrados (6.7). Todo síncrono.
5. **Fin del bloqueo**: detener el auto-bloqueo, el vigilante y el `powerSaveBlocker`; estado `locked`; evento `session:locked { reason }` a la ventana actual; y, salvo con `shutdown`, **sustituir la ventana** (abajo). Con `shutdown`, `app.quit()` (el manejador de `before-quit` hizo `preventDefault()` la primera vez y deja pasar la segunda).
6. **Limpiezas sin claves en segundo plano** (`session/keyless-cleanup.ts`), que ya no forman parte del bloqueo: cerrar los descriptores de los readers y writers abortados; `unlink` de los `.part` de los trabajos abortados (12.4, "Bloquear"); `SIGKILL` a los 2 s, en Linux, de los procesos ffmpeg que no hayan salido; continuar o deshacer el traslado de la bóveda según 8.7 (borrar `<destino>.partial`, completar los pasos 5–6 o el paso 8) y `pendingCleanup`. Ninguna de estas tareas puede leer ni escribir la DB ni usar claves: reciben solo rutas y descriptores. `KeylessCleanup` serializa por ruta: si ya hay una tarea sobre una ruta, otra petición para la misma (por ejemplo, `pendingCleanup` en el siguiente desbloqueo, 12.6 punto 6) se une a ella en lugar de empezar otra. El desbloqueo de un perfil (13.1, paso 1) espera antes a que terminen sus pasos 5–6 de traslado pendientes (unos milisegundos; como mucho 10 s, y si no, `IO`), para leer ya la ruta definitiva de `profiles.json`. Con `shutdown` no se arrancan; si se interrumpen (cierre de la app o caída), las retoman `pendingCleanup` (8.2) al arrancar y la reconciliación (12.6, punto 4) en el siguiente desbloqueo.

**Invariantes que hacen seguro cerrar la DB en cualquier punto de espera** (las comprueba la revisión de código y las fuerza el diseño de los repos):

- Ninguna transacción ni iterador de SQLite abarca un `await`. better-sqlite3 es síncrono: cada `db.transaction(fn)` se ejecuta entera en un solo turno del bucle de eventos (y better-sqlite3 lanza si `fn` devuelve una promesa), y `stmt.iterate()` se consume dentro del mismo turno. ESLint `no-restricted-syntax` en `src/main/**` prohíbe pasar funciones `async` a `.transaction(...)` (selector `CallExpression[callee.property.name='transaction'] > :function[async=true]`).
- Los repos obtienen la DB con `getDb()`, que lanza `AppError('LOCKED')` si la DB está cerrada (desde el paso 4, o antes de desbloquear). Durante los pasos 1–3 la DB sigue abierta para los trabajos que ya estaban en marcha, aunque los canales IPC "U" ya respondan `LOCKED` a las peticiones nuevas.
- Los trabajos comprueban `signal.aborted` después de cada `await` y tratan `LOCKED` como cancelación. Lo que quede a medias lo resuelve la reconciliación (12.6).

**Tests**:

- Vitest (F1, `session-manager.test.ts`, con fakes inyectados): con un trabajo falso bloqueado en un `await` que nunca se resuelve, `lock('suspend')` deja el KeyRing, la caché de DEKs y la DEK del writer a cero **antes de devolver** (comprobación síncrona justo después de la llamada) y sin que el trabajo haya terminado; con `lock('manual')` la espera no pasa de 2 s.
- Vitest (F2, `relocate.test.ts`): traslado después del paso 6 con un `removeVaultDir` falso que espera indefinidamente + bloqueo → claves a cero antes de que termine `removeVaultDir`, que sigue en `KeylessCleanup`.
- E2E (F2): importar un MP4 de ≥ 1 GiB (generado por `tests/fixtures/generate.mjs` con `-stream_loop -1 -c copy -fs 1G`) y, a mitad, `electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))`. Con `GALERIA_E2E=1` (y sin empaquetar), main expone `globalThis.__galeriaLastZeroizeMs` (tiempo entre el evento y el fin del paso 4): ≤ 200 ms. El original sigue intacto (mismo SHA-256) y, tras el siguiente desbloqueo, no quedan filas `pending` ni `.part` en `tmp/`; como el bloqueo llegó antes del paso 5, el vídeo no aparece en la galería.

**Sustitución de la ventana** (`window.ts`, `replaceMainWindow()`, paso 5):

1. se leen la geometría y el estado maximizado de la ventana actual (la pantalla completa no se conserva);
2. se crea una ventana nueva con `show: false`, los mismos `webPreferences` de 5.2 y `additionalArguments` calculados **ahora** con `settings.json` (tema y esquema globales actuales, 15.4), y carga el renderer;
3. `getMainWindow()` pasa a devolver la nueva antes de que cargue, así que el IPC (5.6) y los eventos solo aceptan y llegan a la nueva;
4. en `ready-to-show` de la nueva: `show()` (con `maximize()` si lo estaba) y `destroy()` de la antigua. Como la nueva ya existe, `window-all-closed` no se dispara;
5. si la nueva no llega a `ready-to-show` en 10 s, se destruye la antigua igualmente y se muestra la nueva.

La ventana nueva es un BrowsingInstance nuevo y debe tener un proceso de renderer nuevo; al destruir la antigua termina su proceso con todo su heap (nombres, listas, imágenes decodificadas, buffers de vídeo y el AudioContext). `webContents.reload()` no se usa porque una recarga del mismo origen reutiliza el proceso del renderer y además conservaría el tema inicial de cuando se creó la ventana.

**Proceso nuevo: comprobación obligatoria** (no está verificado que Chromium no reutilice un proceso del mismo sitio, por ejemplo con la función `ProcessPerSiteUpToMainFrameThreshold`). E2E de F1: antes de bloquear, `oldPid = getMainWindow().webContents.getOSProcessId()`; tras `lockAndGetNewWindow()`, `newPid` de la nueva. Se exige `oldPid !== newPid` y que `process.kill(oldPid, 0)` lance `ESRCH` antes de 5 s. Si falla, se añade `app.commandLine.appendSwitch('disable-features', 'ProcessPerSiteUpToMainFrameThreshold')` en el paso 7 de 5.2 y se repite; si sigue fallando, este punto del diseño se reabre (R20).

**El renderer antiguo**, al recibir `session:locking` (paso 1), pinta al momento un velo opaco del color de fondo del tema, encima de todo y sin animación, para que no se vea contenido hasta que lo destruyan; `session:locked` ya no cambia nada visible. **El nuevo** arranca en el selector de perfiles: al montar consulta `session:getState` y, si está `locked`, muestra el selector.

---

## 14. Pantallas de la UI y accesibilidad

### 14.1 Reglas comunes

- `lang="es"`. Todos los textos son en español.
- **Teclado**: cada control se alcanza con Tab en orden visual. `:focus-visible` dibuja un anillo de `--g-focus-ring` de 2 px con 2 px de separación y contraste ≥ 3:1 en todos los temas (15.11). No se usa `outline: none` sin un sustituto.
- **Componentes Radix**: `Dialog`, `AlertDialog`, `DropdownMenu`, `ContextMenu`, `Popover`, `Select`, `Slider`, `Tabs`, `ToggleGroup`, `RadioGroup`, `Checkbox`, `Switch`, `Tooltip`. Aportan la trampa de foco, el cierre con Esc y la devolución del foco al control que abrió el elemento.
- **Cambio de pantalla**: el foco pasa al `<h1 tabIndex={-1}>` de la pantalla nueva. Cada shell empieza con un enlace "Saltar al contenido".
- **Avisos dinámicos**: una región global `aria-live="polite"` para toasts y progreso, y `assertive` solo para errores de contraseña. En los formularios, `aria-invalid` + `aria-describedby` con el mensaje.
- **Movimiento**: `<MotionConfig reducedMotion="user">` en la raíz. Con `prefers-reduced-motion: reduce` desaparecen escalados, desplazamientos, Ken Burns y fondos animados, y solo quedan fundidos de ≤ 150 ms.
- **Errores**: el renderer traduce cada `ErrorCode` a un mensaje en español (`lib/errors-es.ts`).
- **Atajos globales** (con la bóveda abierta y sin foco en un campo de texto):

| Atajo | Acción |
|---|---|
| `Ctrl+L` | Bloquear |
| `Ctrl+I` | Importar archivos |
| `Ctrl+Shift+I` | Importar carpeta |
| `Ctrl+F` | Ir a la búsqueda |
| `F5` | Presentación de la selección, o de todo lo visible si no hay selección |
| `F1` | Ayuda |
| `Ctrl+,` | Ajustes |

### 14.2 Selector de perfiles (estilo Netflix / HBO Max)

- **Estructura** (la misma en todos los temas; la variante visual se describe en 15.10):
  - fondo oscuro a pantalla completa con el título "¿Quién eres?";
  - fila centrada de avatares grandes (160 px, o 120 px con más de 5 perfiles, en varias filas si hace falta) con el nombre debajo;
  - un mosaico "Añadir perfil" mientras haya menos de 10;
  - debajo, el botón "Administrar perfiles";
  - un botón discreto de tema (icono de paleta) para cambiar el tema global, que no revela nada.
- **Avatares**: 12 ilustraciones SVG propias (`aurora`, `bosque`, `coral`, `duna`, `eclipse`, `fresa`, `glaciar`, `hoja`, `lava`, `marea`, `nebula`, `sol`), sin parecido con marcas existentes.
- **Animación**:
  - entrada escalonada de 40 ms entre avatares (fundido + 12 px hacia arriba);
  - en reposo, "respiración" suave (escala 1 → 1,02 en 4 s);
  - con hover o foco: escala 1,08, anillo de acento y nombre en negrita;
  - al elegir, el avatar se desplaza al diálogo de desbloqueo con una animación de layout compartido de Motion.
  - Con movimiento reducido solo queda el anillo.
- **Teclado**: lista con roving tabindex (`role="list"` y un `<button>` por avatar).
  - `←/→/↑/↓` mueven el foco, `Home/End` van a los extremos y `Enter/Espacio` abre el desbloqueo.
  - Tab sale hacia "Administrar perfiles".
  - Al cerrar el desbloqueo, el foco vuelve al avatar.
- **Bóveda no disponible**: el avatar lleva la insignia de texto e icono "Disco no conectado" (no solo color).
- **Primer arranque** (sin perfiles): bienvenida con el botón "Crear perfil".

### 14.3 Desbloqueo

Diálogo modal sobre el selector. En el tema `macos` va en línea bajo el avatar (15.10).

- Contiene: avatar y nombre, campo de contraseña con foco automático, botón "Mostrar/Ocultar" (`aria-pressed`), "Entrar" y "Cancelar".
- `Enter` envía. Mientras se calcula Argon2 se muestra "Comprobando…" con `aria-busy`.
- **`WRONG_PASSWORD`**: "Contraseña incorrecta" (`assertive`) y el texto del campo queda seleccionado.
- **`VAULT_UNAVAILABLE`**: "No se encuentra la bóveda (¿está conectado el disco?)", con la ruta y los botones "Reintentar" y "Buscar la bóveda…".
- **`VAULT_CORRUPT`**: mensaje explicativo, sin opciones de reparación.
- No hay ningún enlace del tipo "¿Olvidaste tu contraseña?".

### 14.4 Administrar perfiles

- **Lista**: cada perfil con "Editar", "Cambiar contraseña" y "Eliminar"; además "Añadir perfil" y "Listo".
- **Crear** (`ProfileForm`):
  - Nombre.
  - Avatar: `RadioGroup` de los 12 integrados, navegable con flechas. Opción "Usar una foto…", que muestra siempre el aviso: "Esta foto se guardará **sin cifrar** y la verá cualquiera que abra Galería en este equipo." La foto se recorta a 256×256 WebP sin metadatos y el archivo original no se toca.
  - **Foto de avatar en main** (`profiles:pickAvatarPhoto`, `avatars.ts`):
    1. diálogo nativo con `properties: ['openFile', 'dontAddToRecent']` y filtro "Imágenes" `jpg, jpeg, png, webp, gif, avif` (sin BMP, HEIC ni RAW); cancelar devuelve `null`;
    2. `lstat` como en 12.3, punto 1: solo un archivo regular, sin enlaces simbólicos ni junctions; si no, `UNSUPPORTED_FORMAT`;
    3. tamaño ≤ 50 MiB; si no, `TOO_LARGE`, sin leer el contenido;
    4. `readFile` a un buffer y formato por firma con las filas de foto de `sniff.ts` (12.3): JPEG, PNG, WebP, GIF o AVIF; HEIC, RAW, BMP y cualquier otra firma dan `UNSUPPORTED_FORMAT`;
    5. `getSharp()` (12.4) con `{ sequentialRead: true, limitInputPixels: 268402689 }` (≤ 268 MP; el error de sharp por exceso de píxeles se traduce a `TOO_LARGE`, cualquier otro error de decodificación a `UNSUPPORTED_FORMAT`) → `.autoOrient().resize(256, 256, { fit: 'cover' }).webp({ quality: 85 })`. sharp no copia metadatos a la salida salvo con `withMetadata()`, que no se usa; de un GIF animado se toma el primer fotograma;
    6. el WebP resultante queda en memoria con un token aleatorio de 10 min (servido por `vault://avatar/pending/<token>`); el archivo elegido no se toca y el buffer original se descarta.
    7. Errores de E/S: `IO`. Ningún fallo deja nada en disco. Log `debug` con el código, sin la ruta.
  - Contraseña y "Repetir contraseña" (mínimo 8 caracteres, contados como code points, y máximo 1024 bytes UTF-8, con un indicador de longitud; reglas y mensajes en 10.3).
  - Recuadro de advertencia destacado (`role="note"`, con el icono de alerta y el color `--g-warning`): "**No hay forma de recuperar la contraseña.** Si la olvidas, nadie podrá descifrar tus fotos y vídeos: ni tú, ni otra persona, ni el desarrollador. Galería tampoco tiene función de exportar."
  - Casilla obligatoria "Entiendo que si olvido la contraseña perderé el acceso para siempre".
  - "Crear perfil" queda deshabilitado hasta que todo es válido.
  - Mientras `profiles:create` está en curso (incluye la calibración de Argon2, unos 1–4 s) el formulario muestra "Preparando tu bóveda…" con `aria-busy`. Al terminar se vuelve al selector con el foco en el avatar nuevo.
- **Flujo de creación en main** (`profile-service.createProfile`):
  1. Validar con 10.3: nombre único, ≤ 10 perfiles, contraseña y `acknowledgeNoRecovery`; si el avatar es personalizado, que el token sea válido.
  2. `id = randomBytes(16)` en hex. Calibrar (6.1), generar la sal, derivar la KEK, `MK = randomFillSync(Buffer.alloc(32))` y envolver la MK (6.2).
  3. Crear `GaleriaData/vaults/<id>.creating/`, escribir dentro `vault.json` de forma atómica (8.3) y después crear `objects/`, `thumbs/`, `tmp/` y `music/`.
  4. HKDF → K_db. Crear `library.db` (9.1, `fileMustExist: false`), aplicar las migraciones (9.3) y cerrarla.
  5. Si el avatar es personalizado: escribir el WebP ya procesado del token (256×256 sin metadatos, punto anterior) en `avatars/<id>.webp` de forma atómica.
  6. `rename(vaults/<id>.creating → vaults/<id>)`, con los reintentos `EPERM`/`EBUSY` de 8.3.
  7. **Punto de confirmación**: añadir el perfil (con `vault: { location: "default" }`) a `profiles.json` y a su `.bak` (8.3).
  8. Poner a cero la MK, la KEK, K_db y la contraseña. El perfil queda bloqueado; crear no lo desbloquea.
  - **Fallos antes del paso 7**: se borra `vaults/<id>.creating` o `vaults/<id>` con `removeVaultDir(…, 'creating' | 'vault')` (8.5.1) y `avatars/<id>.webp`; `profiles.json` no cambia. El llamador recibe `IO`, `DISK_FULL` o `INTERNAL { reason: 'kdf-memory' }` (21.1). Las claves se ponen a cero también en este camino.
  - **Fallo del paso 7**: igual que el anterior; como la escritura es atómica, `profiles.json` queda como estaba.
  - **Al arrancar** (antes de mostrar el selector), se borran los `vaults/*.creating` con `removeVaultDir(dir, <id del nombre>, 'creating')`, porque solo los crea este flujo. Una carpeta `vaults/<id>` sin entrada en `profiles.json` no se borra nunca automáticamente: se registra un `warn` (`vault.orphan-dir`, sin la ruta).
- **Editar** nombre o avatar: exige la contraseña del perfil (D14).
- **Cambiar contraseña**: actual, nueva y repetir. Incluye la nota de 6.6 sobre las copias antiguas.
- **Eliminar** (`AlertDialog`):
  - Texto: "Se borrarán para siempre todas las fotos, vídeos, playlists y música de «Nombre». No se puede deshacer."
  - **Contraseña obligatoria** y el campo "Escribe el nombre del perfil para confirmar".
  - "Eliminar perfil" (estilo peligro) solo se habilita con los dos campos rellenos. El foco inicial está en "Cancelar".
- **Flujo de borrado en main** (`profile-service.deleteProfile`):
  1. Desenvolver la MK con la contraseña (`WRONG_PASSWORD`). No se toca nada antes de este paso.
  2. Si el perfil estuviera desbloqueado, bloquearlo.
  3. Quitar la entrada de `profiles.json` y del `.bak`. Desde ese momento la bóveda es criptográficamente inaccesible.
  4. Borrar `prefs/<id>.json` y `avatars/<id>.webp`.
  5. Borrar la bóveda con `removeVaultDir(<vaultDir>, id, 'vault')` (8.5.1), nunca con un borrado recursivo directo de la ruta de `profiles.json`, mostrando el progreso. Si existía `pendingCleanup`, se borra igual. Si queda algo (`leftoverPath`), se avisa con la ruta para borrarla a mano y se registra un `warn`.
- **Decisión cerrada (anexo, punto 1)**: la app **nunca** ofrece borrar, restablecer ni "olvidé la contraseña" para un perfil sin su contraseña. Ningún flag, variable de entorno, CLI ni diálogo lo evita. Como hecho, y no como función: quien tenga acceso al sistema operativo (por ejemplo, un administrador) puede borrar a mano la carpeta de una bóveda. La app no lo guía ni lo facilita.

### 14.5 Shell y navegación (con la bóveda abierta)

`NavModel` es común a todos los temas:

- Galería, con los subelementos Todo, Fotos y Vídeos (equivalen al filtro de tipo);
- Playlists, con cada playlist como subelemento;
- Vídeo dual;
- Ajustes;
- Ayuda.

Barra de comandos (`CommandBar`): búsqueda, filtros, orden, tamaño de miniatura, "Importar" (menú: Archivos… / Carpeta…) y "Bloquear". El shell la coloca y le da estilo según el tema (15.5).

### 14.6 Galería

- **Rejilla virtualizada**: `useVirtualizer` (TanStack) sobre filas.
  - Las filas son cabeceras de mes ("octubre de 2026", con `Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' })`) y filas de mosaicos.
  - Solo se agrupa al ordenar por fecha de captura o de importación. Con los demás órdenes la lista es plana.
  - Mosaicos cuadrados con `object-fit: cover`, de 120, 180 (por defecto) o 260 px CSS y separación `--g-tile-gap`. Columnas: `floor((ancho + gap) / (tamaño + gap))`. Overscan de 3 filas.
  - Cada miniatura es `<img src="vault://thumb/<id>?rev=<n>" loading="lazy" decoding="async" alt="<nombre>">`. Los vídeos llevan icono y la insignia de duración (`1:23`).
- **Búsqueda**: debounce de 200 ms; Esc limpia.
- **Filtros** (`Popover`):
  - tipo: `ToggleGroup` con Todo / Fotos / Vídeos;
  - rango de fechas: dos `<input type="date">` (desde/hasta, sobre `captured_at`; `dateFrom` = 00:00:00.000 y `dateTo` = 23:59:59.999 del día, en hora naive);
  - playlist: `Select`.
  - Los filtros activos aparecen como chips, cada uno con su botón "Quitar".
- **Orden** (`DropdownMenu` con radios): Fecha de captura (por defecto, descendente), Fecha de importación, Nombre, Tamaño, Duración, más Ascendente/Descendente. Con un filtro de playlist se añade "Orden de la playlist". El orden elegido se guarda en `prefs.gallerySort`.
- **Vacía**: "Tu bóveda está vacía. Importa fotos y vídeos o arrástralos aquí."
- **Selección** (`selection-store`: `Set<Id>` + ancla):

| Gesto | Efecto |
|---|---|
| Clic | Abre el visor |
| Ctrl+clic, o clic en la casilla (visible con hover o foco) | Alterna la selección |
| Shift+clic | Selecciona el rango desde el ancla, en el orden actual (que es total y estable, 9.2, así que el rango es determinista) |
| `Ctrl+A` | Selecciona todo el resultado actual |
| Esc | Limpia la selección |

  Si cambia la consulta, se conserva la intersección con el nuevo resultado.
- **Barra de selección** (visible con al menos un elemento):
  - "N seleccionados";
  - Presentación, Añadir a playlist (playlists existentes + "Nueva playlist…"), Renombrar (solo con 1), Vídeo dual (solo con exactamente 2 vídeos), Quitar de la playlist (con filtro de playlist) y Eliminar;
  - "Cancelar selección".
- **Teclado y ARIA**:
  - la rejilla es `role="grid"` con `aria-multiselectable="true"`, `aria-rowcount` total y `aria-rowindex` en cada fila; las celdas son `gridcell` con `aria-selected`; las cabeceras de mes son una fila con un `rowheader`;
  - una sola parada de Tab (roving tabindex);
  - las flechas mueven el foco (con `scrollToIndex`), Home/End van al principio y al final de la fila, `Ctrl+Home/End` al principio y al final de todo, RePág/AvPág por páginas;
  - Espacio alterna la selección, `Shift+flechas` la amplía, Enter abre el visor, Supr elimina (con confirmación) y F2 renombra;
  - menú contextual con clic derecho, tecla Menú o `Shift+F10`, con las mismas acciones.
- **Renombrar**: diálogo con el nombre seleccionado (sin la extensión, que se muestra aparte). Validación de 10.3; Enter guarda.
- **Importación**:
  - mientras se arrastra encima, overlay "Suelta para importar";
  - durante la importación, panel no modal abajo a la derecha (`aria-live="polite"`) con la barra, "12 de 40", la fase y "Cancelar"; el menú "Importar" y `Ctrl+I`/`Ctrl+Shift+I` quedan deshabilitados (`aria-disabled`, con el tooltip "Espera a que termine la importación en curso"), porque solo puede haber una importación activa (12.11);
  - si llega `import:confirmNeeded`, el `AlertDialog` de conversión de 12.5.1 (foco inicial en "Omitir esos vídeos"); al cerrarlo, el foco vuelve al panel de importación;
  - al terminar, un resumen: importados, duplicados, omitidos, fallidos (nombre + motivo) y "originales que no se pudieron borrar" (ruta seleccionable para borrarlos a mano).
  - Es el único sitio donde el renderer ve rutas de disco, y son rutas de los originales del usuario, no de la bóveda.

### 14.7 Visor, editor y reproductor

Ver la sección 16.

### 14.8 Playlists

- **Pantalla Playlists**:
  - tarjetas con la miniatura del primer elemento como portada, el nombre y el número de elementos;
  - "Nueva playlist";
  - menú por tarjeta: Abrir, Presentación, Renombrar y Eliminar (con confirmación; borra la playlist, no los medios).
  - En el tema `xbox`, las tarjetas forman un mosaico de tamaños distintos (15.2).
- **Detalle**:
  - cabecera con el nombre, "Reproducir presentación" y "Ajustes de presentación de esta playlist" (17.2, con el interruptor "Usar los ajustes predeterminados");
  - lista vertical reordenable (`@dnd-kit/sortable`) con miniatura, nombre, tipo o duración y el botón "Quitar".
- **Teclado al reordenar**: Tab hasta la fila; Espacio o Enter la levanta; ↑/↓ la mueve; Espacio la suelta; Esc cancela. Además, `Alt+↑/↓` mueve directamente una posición. Los anuncios en español van por `announcements` de dnd-kit ("Elemento levantado, posición 3 de 20", etc.).
- **Guardado**: al soltar se envía `playlists:reorder` con la permutación completa. La UI se actualiza de forma optimista; si hay error, se revierte y se muestra un toast.
- **Límite**: 2000 elementos por playlist (`PLAYLIST_FULL`). La lista no está virtualizada.
- Añadir a playlist desde la galería ignora los elementos que ya están (`alreadyPresent`).

### 14.9 Ajustes

Secciones en `Tabs` verticales:

- **Apariencia**: tema (`ThemePicker`, 15.8), esquema Claro/Oscuro/Sistema (solo si el tema lo admite), "Aplicar a: solo mi perfil / toda la app" (15.9) y tamaño de miniaturas.
- **Seguridad**:
  - bloqueo por inactividad (`Select`: Nunca, 1, 2, 5, 10, 15, 30, 60 min);
  - texto fijo según la plataforma (13.2): en Windows, "Galería se bloquea siempre al suspender el equipo y al bloquear la sesión"; en Linux, "Galería se bloquea siempre al suspender el equipo y, si tu escritorio lo informa, al bloquear la sesión";
  - interruptor "Ocultar Galería en capturas de pantalla y grabaciones" (`prefs.contentProtection`, activado por defecto, D15), con la nota "Solo en Windows. Mientras esté activado, tampoco podrás hacer capturas de Galería ni compartir su ventana." En Linux el interruptor aparece deshabilitado con el texto "No disponible en Linux";
  - "Cambiar contraseña".
- **Almacenamiento**: ubicación actual, tamaño de la bóveda y espacio libre; "Mover bóveda…" y "Volver a la ubicación predeterminada". Durante el traslado, `AlertDialog` de progreso no descartable con "Cancelar" (8.7, paso 2); con foco inicial en "Cancelar", que pasa a "Terminando…" deshabilitado desde el paso 5. Si queda una bóveda antigua por borrar (`leftoverPath`), se muestra su ruta seleccionable.
- **Presentación**: valores por defecto (17.2), incluida la música por defecto.
- **Música**: biblioteca del perfil (importar, escuchar un fragmento con un `<audio>` simple, renombrar, eliminar). Aviso fijo: "La música se guarda sin cifrar. Importarla copia el archivo; el original no se borra." Tras importar, un resumen con las pistas añadidas y las que fallaron, con su nombre y el motivo (8.6.1).
- **Acerca de**: versión, licencias (FFmpeg LGPL con la versión exacta, el commit y el tag de los scripts de compilación, y el aviso de que el código fuente correspondiente se entrega bajo petición, 19.1; fuentes OFL y librerías) y acceso a la Ayuda. Las URLs se muestran como texto, sin enlaces activos, porque no hay red.

### 14.10 Ayuda y límites

Texto estático con los límites de 24.2, en el mismo orden, y la tabla de atajos de teclado. Se abre con F1 o desde la navegación.

---

## 15. Temas visuales intercambiables

Requisito del anexo `.agents/tasks/requirements-addendum.md`, punto 2. El revisor y el planner deben validar esta sección contra ese archivo.

### 15.1 Modelo

Un tema es la combinación de cuatro piezas, todas opcionales salvo los tokens:

1. **Tokens de diseño** (variables CSS).
2. **Variante de shell**, es decir, el patrón de navegación.
3. **Renderer de fondo**.
4. **Preset de movimiento**.

La lógica de negocio, los stores, las llamadas IPC y los componentes de las pantallas son **comunes**. Un tema nunca bifurca funcionalidad: galería, búsqueda/filtros/orden, selección, visor, editor, reproductor, playlists, configuración de la presentación, vídeo dual, ajustes, selector de perfiles, desbloqueo y bloqueo funcionan en los 5.

```ts
// src/shared/themes.ts (catálogo) + src/renderer/src/themes/registry.ts (definiciones completas)
interface ThemeDefinition {
  id: ThemeId;                                   // 'fotos' | 'xbox' | 'ps3' | 'macos' | 'album'
  displayName: string;                           // nombre neutro visible (D10)
  schemes: ('light' | 'dark')[];                 // admitidos; el primero es el predeterminado
  tokens: Partial<Record<'light' | 'dark', ThemeTokens>>;
  shell: 'sidebar' | 'pivot' | 'xmb' | 'vibrancy' | 'topbar';
  titlebar: 'fluent' | 'xbox' | 'xmb' | 'traffic-lights' | 'album';
  background: 'mica' | 'solid' | 'waves' | 'wallpaper' | 'paper';
  tile: 'rounded' | 'flat' | 'xmb' | 'vibrancy' | 'polaroid';
  picker: 'fluent' | 'tiles' | 'xmb-row' | 'login' | 'polaroid';
  motion: MotionPreset;   // { fastMs, normalMs, slowMs, ease: {standard, emphasized, decelerate},
                          //   focusScale, hoverScale, staggerMs }
  bgExtremes: Record<'light' | 'dark', [string, string]>; // colores extremos que puede pintar el fondo (test de contraste)
}
```

### 15.2 Catálogo

| id | Nombre visible (D10) | Inspirado en | Esquemas | Shell | Fondo | Mosaico | Fuentes | Acento |
|---|---|---|---|---|---|---|---|---|
| `fotos` (**predeterminado**) | Clásico | Fotos de Windows 11 (Fluent) | claro + oscuro (sigue al sistema) | `sidebar`: panel de navegación a la izquierda (280 px, se pliega a iconos por debajo de 1100 px) + barra de comandos arriba | `mica`: degradado radial estático del acento al 15 % + ruido propio de 128 px al 3 %, imitando Mica | `rounded`, radio 8 px | Inter | claro `#005FB8`, oscuro `#60CDFF` |
| `xbox` | Mosaico | Panel de Xbox One (Metro/Fluent) | oscuro | `pivot`: pestañas horizontales grandes arriba | `solid`: `#0E0E0E` con viñeta | `flat`: rectángulos sin radio; foco con escala 1,06 + borde de 3 px; la pantalla Playlists y el selector usan un mosaico de tamaños 2×2 / 2×1 / 1×1 | Noto Sans | verde `#2E9E44` |
| `ps3` | Ondas | XrossMediaBar de PS3 | oscuro | `xmb`: fila horizontal de categorías con iconos + columna vertical de subelementos | `waves`: ondas animadas en canvas 2D; el color sigue al mes (tabla propia de 12 colores) y el brillo a la hora (0,75–1,0) | `xmb`: lista con miniatura + texto en las secciones; galería en rejilla translúcida | Nunito | blanco sobre el color del mes |
| `macos` | Cristal | macOS Sonoma/Sequoia, Fotos para Mac | claro + oscuro | `vibrancy`: barra lateral translúcida + barra de herramientas unida a la de título | `wallpaper`: degradado SVG propio + `backdrop-filter: blur(24px) saturate(1.6)` solo en la barra lateral y la de herramientas | `vibrancy`, radio 10 px, sombras suaves | Inter | `#2F7CF6` |
| `album` | Álbum | Álbum de fotos analógico (diseño propio) | claro | `topbar`: pestañas como separadores de papel | `paper`: textura de papel propia (PNG de 256 px en mosaico) + grano estático al 4 % | `polaroid`: marco blanco de 8/8/28 px, rotación determinista entre −2° y 2° según el hash del id (se endereza al enfocar) | Fraunces (títulos), Caveat (rótulos), Noto Sans (cuerpo) | teja `#B5452F` |

### 15.3 Tokens (`--g-*`)

| Grupo | Tokens |
|---|---|
| Color | `bg`, `bg-elevated`, `surface`, `surface-2`, `surface-hover`, `surface-pressed`, `surface-alpha`, `border`, `border-strong`, `text`, `text-muted`, `text-on-accent`, `accent`, `accent-hover`, `accent-pressed`, `accent-muted`, `focus-ring`, `selection`, `selection-border`, `danger`, `danger-text`, `warning`, `success`, `scrim`, `tile-placeholder` |
| Tipografía | `font-sans`, `font-display`, `font-hand`, `text-xs` … `text-3xl`, `weight-regular`, `weight-strong`, `tracking-display` |
| Forma | `radius-sm`, `radius-md`, `radius-lg`, `radius-tile`, `radius-avatar`, `border-width` |
| Elevación y material | `shadow-sm`, `shadow-md`, `shadow-lg`, `blur-surface`, `saturate-surface` |
| Espaciado | `space-unit` (4 px), `tile-gap`, `nav-width` |
| Movimiento | `dur-fast`, `dur-normal`, `dur-slow`, `ease-standard`, `ease-emphasized`, `ease-decelerate`, `focus-scale`, `hover-scale` |

En Tailwind v4 se mapean en `styles/base.css` con `@theme inline { --color-surface: var(--g-surface); --radius-tile: var(--g-radius-tile); --font-sans: var(--g-font-sans); … }`, así que las clases (`bg-surface`, `rounded-tile`, …) resuelven en tiempo de ejecución.

### 15.4 Implementación

- La fuente de verdad son los objetos TS `themes/tokens/<id>.ts`. Así se pueden testear (contraste) y aplicar en subárboles (previsualizaciones).
- `build-css.ts` genera reglas `[data-theme="<id>"][data-scheme="<s>"] { --g-…: …; }` para todos los temas y esquemas. `ThemeProvider`, antes del primer render, las añade con `new CSSStyleSheet()` + `replaceSync()` + `document.adoptedStyleSheets`, que la CSP permite con `style-src 'unsafe-inline'`.
- Los estilos estructurales propios de cada tema (marco polaroid, cinta adhesiva, pestañas de papel) van en `src/renderer/src/styles/themes.css` con selectores `[data-theme="album"] …`. `fotos` va en F1 y el resto en F6.
- `<html>` lleva `data-theme`, `data-scheme` y `data-reduced-motion`. El preload los pone en `DOMContentLoaded` a partir de `--galeria-theme` y `--galeria-scheme` (`additionalArguments`), para que no haya un destello con el tema equivocado. Main calcula esos valores cada vez que crea una ventana, también la que sustituye a la anterior al bloquear (13.3): el tema global de `settings.json` en ese momento, y el esquema con `system` resuelto mediante `nativeTheme.shouldUseDarkColors`. Así, si el tema global cambió durante la sesión, el selector de perfiles aparece con el tema nuevo.
- Si se elige un esquema que el tema no admite, se usa el primero de `schemes`.

### 15.5 Shells (`themes/shells/*`)

Todos implementan `ShellProps { nav: NavModel; active: NavKey; onNavigate(k): void; commandBar: ReactNode; children: ReactNode }` y colocan la barra de título, el fondo y el contenido.

- **`sidebar`**: `<nav>` con lista vertical (↑/↓ dentro de la lista, Enter abre) y botón de plegar.
- **`pivot`**: `Tabs` de Radix horizontales (←/→), con el contenido debajo. Foco muy visible (escala + borde), pensado para teclado y mando.
- **`xmb`**:
  - categorías en una fila en el tercio superior; ←/→ cambia de categoría con un deslizamiento (la fila hace `translateX` en 250 ms para que la categoría activa quede en una columna fija);
  - ↑/↓ recorre la columna de subelementos y Enter abre la pantalla en el panel de contenido, translúcido sobre las ondas;
  - Esc o Retroceso devuelven el foco a la barra XMB.
- **`vibrancy`**: barra lateral translúcida agrupada por secciones; barra de herramientas unida a la de título, con los botones de ventana a la izquierda.
- **`topbar`**: barra superior con pestañas de papel (`Tabs`); el contenido se presenta como la página de un álbum.

Las pantallas no saben qué shell las envuelve. Si una pantalla necesita una variante visual, usa `useTheme().tile` o `[data-theme]` en CSS, nunca una rama de lógica distinta.

### 15.6 Ventana sin marco y barra de título

`frame: false` en los dos SO desde la Fase 1. El marco no se puede cambiar en vivo, y el tema `macos` necesita botones de semáforo propios. `Titlebar.tsx` tiene variantes:

| Variante | Diseño |
|---|---|
| `fluent` | Título a la izquierda; Minimizar, Maximizar/Restaurar y Cerrar a la derecha (46×32 px) |
| `xbox` | Barra mínima con los botones a la derecha |
| `xmb` | Barra translúcida con los botones a la derecha |
| `traffic-lights` | Tres círculos de 12 px a la izquierda, con colores propios `#EE6A5F`, `#F5BE4F` y `#62C554` e iconos al pasar el ratón |
| `album` | Tira de papel |

- Zona de arrastre con `-webkit-app-region: drag`; los botones llevan `no-drag`. El doble clic maximiza.
- Los botones tienen `aria-label` ("Minimizar", "Maximizar"/"Restaurar", "Cerrar") y van al final del orden de Tab. Se comunican con main por `window:*`.
- El botón de bloqueo (candado) va en la barra de título en todos los temas.
- En pantalla completa (presentación, visor) la barra se oculta.
- Riesgos (24.1): sin el menú de "snap layouts" de Windows 11 (Win+flechas sí funciona); en Linux/Wayland Electron gestiona el redimensionado de ventanas sin marco, a verificar en F7.

### 15.7 Fondos y rendimiento

`BackgroundHost` monta el renderer de fondo del tema detrás del shell y le pasa `paused`, que es verdadero si se cumple cualquiera de:

- `document.hidden`;
- `windowState.minimized`;
- `!windowState.visible`;
- una presentación activa;
- un vídeo reproduciéndose (visor o dual).

Comportamiento:

- **`waves`**:
  - canvas 2D (no WebGL) a 30 fps como máximo, con acumulador de tiempo en rAF;
  - backing store a la mitad de resolución y DPR 1, escalado por CSS (las ondas son suaves);
  - 3 cintas, cada una suma de 2 senos;
  - presupuesto ≤ 3 ms por fotograma;
  - con `paused`, se cancela el rAF;
  - con movimiento reducido, se dibuja un único fotograma estático.
- **`mica`, `solid`, `paper`**: CSS estático, coste 0.
- **`wallpaper`**: `backdrop-filter` limitado a la barra lateral y la de herramientas.
- **Criterio de F6**: con `waves` visible, ≤ 5 % de un núcleo de media en la máquina de desarrollo; con `paused`, 0 %. Se mide con el Performance Monitor de las DevTools (en desarrollo).

### 15.8 Cambio en vivo y selector de temas

`applyTheme(id, scheme)`:

1. Con movimiento reducido, cambia los atributos sin transición.
2. Si no, usa `document.startViewTransition(() => flushSync(() => setTheme(...)))`, con `::view-transition-old(root), ::view-transition-new(root) { animation-duration: 200ms; }`. Es un fundido corto que cubre también el cambio de shell.
3. Los stores no cambian, así que la selección, la consulta, la pantalla actual y el scroll se conservan (la posición del virtualizer se guarda en `library-store` y se restaura al montar).

`ThemePicker` es un `RadioGroup` de 5 tarjetas. Cada una contiene un `ThemePreview`:

- es una maqueta ligera y estática del shell (barra de título, navegación y 6 mosaicos de degradado; nunca contenido del usuario) dentro de un contenedor con su propio `data-theme`/`data-scheme`;
- elegir una tarjeta aplica el tema al momento;
- las flechas mueven la selección.

### 15.9 Persistencia (sin cifrar)

El tema no es contenido de la bóveda, así que se guarda sin cifrar.

- **Global**: `settings.json.pickerThemeId` y `colorScheme`. Se usa en el selector de perfiles, el desbloqueo y tras bloquear. Se cambia con el botón de paleta del selector o desde Ajustes con "Aplicar a: toda la app".
- **Por perfil (opcional)**: `prefs/<id>.json.themeId` y `colorScheme`, donde `null` significa heredar el global. Se aplica después de desbloquear. "Aplicar a: solo mi perfil" escribe `prefs.themeId`; "toda la app" escribe el global y pone `prefs.themeId = null`.

### 15.10 Selector de perfiles por tema (punto de decisión D9)

Todas las variantes mantienen la estructura de 14.2 (avatares grandes, nombre debajo, "Añadir perfil" y "Administrar perfiles") y el mismo orden del DOM y modelo de teclado. Cambia solo la presentación:

| Tema | Variante del selector |
|---|---|
| `fotos` | Fondo oscuro forzado (estilo Netflix) aunque el esquema sea claro; avatares cuadrados con radio 8 px; anillo de acento al enfocar |
| `xbox` | Avatares en mosaicos planos con el nombre dentro; el enfocado escala a 1,06 con un borde blanco de 3 px |
| `ps3` | Fila horizontal sobre las ondas; el avatar enfocado se agranda y se centra con un deslizamiento; "Pulsa Intro" debajo |
| `macos` | Avatares circulares sobre un fondo difuminado, como la pantalla de inicio de sesión; la contraseña aparece en línea bajo el avatar elegido |
| `album` | Avatares como fotos instantáneas sujetas con cinta sobre papel; el nombre con letra manuscrita (Caveat) |

### 15.11 Accesibilidad de los temas

`tests/unit/renderer/theme-contrast.test.ts` recorre cada tema y esquema, y para las superficies translúcidas compone `surface-alpha` sobre los dos `bgExtremes`. Exige (WCAG 2.x AA):

- `text`/`bg`, `text`/`surface`, `text-muted`/`surface`, `text-on-accent`/`accent` y `danger-text`/`surface` ≥ 4,5:1;
- `focus-ring` contra `bg` y contra `surface` ≥ 3:1;
- `border-strong`/`surface` y `accent`/`surface` ≥ 3:1 (componentes de UI).

Además:

- Los textos sobre fotos (nombres en polaroids, insignias de duración) siempre van sobre una etiqueta de fondo sólido.
- El foco visible es obligatorio en todos los temas.
- Con movimiento reducido: no hay escalados del foco (queda el borde o el anillo), las ondas son estáticas, no hay deslizamiento en la XMB (cambio inmediato) y las rotaciones de las polaroids se mantienen (no son movimiento).
- La verificación completa de WCAG requiere pruebas manuales con tecnologías de asistencia (lector de pantalla NVDA/Orca) y revisión de un experto. El test automatizado solo cubre el contraste.

### 15.12 Fuentes, assets y legalidad

- Todas las fuentes van empaquetadas con `@fontsource-variable/*` (2.2, OFL-1.1) e importadas en `styles/fonts.css`. No hay CDN. Las licencias se copian a `resources/licenses/`.
- No se copian logotipos, iconos, sonidos, fondos de pantalla ni fuentes propietarias de Microsoft, Sony o Apple. Segoe UI y SF Pro no son redistribuibles; se sustituyen por Inter y Noto Sans. Los iconos son de lucide. Las texturas, fondos, avatares y la tabla de colores de las ondas son propios del proyecto (SVG/PNG generados para él). La app no tiene sonidos de interfaz.
- Los temas están "inspirados en", no son clones. Los nombres visibles son neutros (Clásico, Mosaico, Ondas, Cristal, Álbum) y los ids internos (`fotos`, `xbox`, `ps3`, `macos`, `album`) solo aparecen en el código (D10).

### 15.13 Ubicación en el plan

- **F1**: arquitectura completa de temas (tokens → CSS, `ThemeProvider`, registro, abstracción de shell, barra de título, `BackgroundHost`, persistencia, cambio en vivo, `ThemePicker` con previsualización). Incluye `fotos` completo y un **stub de `ps3`** (`XmbShell` navegable + ondas básicas) para validar pronto la abstracción con un shell radicalmente distinto.
- **F6** (antes de instaladores/E2E): `xbox`, `ps3`, `macos` y `album` completos en todas las pantallas, con verificación visual mediante capturas de Playwright por tema y pantalla (`tests/e2e/themes.spec.ts`, `toHaveScreenshot` con máscaras sobre el contenido dinámico).

---

## 16. Visor, editor y reproductor de vídeo

### 16.1 Visor (`screens/viewer/Viewer.tsx`)

- **Apertura**: clic o Enter sobre un mosaico. La lista de navegación es el resultado actual de la galería, o la playlist, en su orden.
- **Animación de apertura (FLIP)**:
  1. Se mide el rect del mosaico.
  2. La capa del visor arranca con la miniatura ya decodificada en ese rect, recortada con `clip-path: inset(…)` para imitar el `cover`.
  3. Motion anima `transform` (translate + scale) y `clip-path` hasta el rect "contain" centrado, en 280 ms con `ease-emphasized`. El fondo (`--g-scrim`, que no depende del tema) pasa de opacidad 0 a 1.
  4. Cuando el original (`vault://media/<id>`) completa `img.decode()`, sustituye a la miniatura dentro de la misma caja, sin salto.
- **Cierre**: animación inversa hacia el mosaico si sigue en el DOM; si no, un fundido de 150 ms. Con movimiento reducido, fundidos de 120 ms.
- **Navegación**:
  - ←/→ y botones laterales para anterior/siguiente, con fundido cruzado de 150 ms; Home/End para el primero y el último;
  - precarga de los vecinos ±1: `decode()` en fotos y solo el póster en vídeos;
  - el panel de información (`I`) muestra nombre, fecha, tamaño, dimensiones, duración y EXIF resumido;
  - `E` abre el editor (solo fotos);
  - Supr elimina (con confirmación) y pasa al siguiente;
  - `F` alterna pantalla completa;
  - Esc sale del zoom primero, si lo hay, y si no cierra el visor.
- **Foco**: el visor es `role="dialog"` `aria-modal` con `aria-label` = nombre. Al abrirse recibe el foco, y al cerrarse lo devuelve al mosaico (con `scrollToIndex` si hace falta).
- **Contenido**: es independiente del tema. Solo los controles superpuestos usan tokens.

### 16.2 Zoom y desplazamiento (`ZoomPan.tsx` + `zoom-math.ts`, puro)

- **Escala**: `s ∈ [1 (ajustar), 8]`.
- **Rueda**: `s ← clamp(s · 1.1^(−deltaY/100))`, centrado en el cursor. El pellizco del trackpad llega como `ctrl+wheel` y se trata igual.
- **Doble clic**: alterna entre 1 y 2, centrado en el punto.
- **Teclado**: `+`/`−` (×1,25), `0` vuelve a ajustar. Con `s > 1`, las flechas desplazan un 10 % en vez de navegar.
- **Arrastre**: con `s > 1`, arrastrar desplaza (con pointer capture y cursor `grab`/`grabbing`). El desplazamiento se limita para que no aparezca hueco más allá de los bordes.
- **Render**: `transform: translate(x, y) scale(s)` sobre un contenedor con `will-change: transform`.
- No hay zoom en vídeos.

### 16.3 Modelo de edición no destructiva (`src/shared/edits.ts`)

Las operaciones (`EditOp`, 10.1) se guardan en orden en `media_edits`. El original no se modifica nunca.

**Estado canónico**: `EditState = { q: 0..3, flip: boolean, crop: {x, y, w, h} }`.

- La transformación de orientación es `T = F^flip ∘ R^q`: primero se rota `q` cuartos de vuelta en sentido horario y después, opcionalmente, se voltea en horizontal.
- `crop` está normalizado en el marco ya orientado.
- La rotación base es la orientación EXIF, que se aplica siempre antes.

**`foldEdits(ops)`** parte de `{ q: 0, flip: false, crop: {0, 0, 1, 1} }` y aplica cada operación:

| Op | Orientación | Recorte `(x, y, w, h)` |
|---|---|---|
| `rotate q'` | `q ← flip ? (q − q') mod 4 : (q + q') mod 4` | por cada cuarto horario: `(1−y−h, x, h, w)` |
| `flipH` | `flip ← !flip` | `(1−x−w, y, w, h)` |
| `flipV` | equivale a `rotate 2` y luego `flipH` | `(x, 1−y−h, w, h)` |
| `crop (cx, cy, cw, ch)` | sin cambio | `(x + cx·w, y + cy·h, cw·w, ch·h)` |

La regla de `rotate` con volteo sale de que `R ∘ F = F ∘ R⁻¹`.

**Render en el renderer** (`EditedImage.tsx`, se usa en el visor y en la presentación):

1. `W×H` son las dimensiones naturales tras EXIF. El marco orientado mide `(W', H') = q impar ? (H, W) : (W, H)`.
2. Un contenedor exterior con `overflow: hidden` y la relación de aspecto `(w·W') / (h·H')`.
3. Dentro, un lienzo de `W'·k × H'·k` desplazado `(−x·W'·k, −y·H'·k)`.
4. Dentro, la `<img>` de `W·k × H·k` centrada, con `transform: scaleX(flip ? −1 : 1) rotate(q·90deg)`. CSS aplica las funciones de derecha a izquierda, así que primero rota y luego voltea, igual que `T`.

**Render en main** (`media/edits-render.ts`, para las miniaturas):

```
(await getSharp())(buf, { sequentialRead: true, limitInputPixels: 268402689 }).autoOrient()
  .flop(flip).rotate(q2 * 90)                       // sharp aplica flop ANTES de la rotación
  .extract({ left, top, width, height })            // región del recorte en píxeles del marco orientado
  .resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 })
con q2 = flip ? (4 − q) mod 4 : q    // F ∘ R^q = R^(−q) ∘ F
    left = round(x·W'), top = round(y·H'), width = max(1, round(w·W')), height = max(1, round(h·H'))
```

**Test obligatorio** (F3): una imagen asimétrica de 4×2 píxeles con colores distintos, en los 8 estados D4 combinados con un recorte. Se compara píxel a píxel el resultado de sharp con la matriz esperada que calcula `foldEdits`. Si el encadenamiento de sharp no diera el orden documentado, el plan B es hacerlo en dos pasadas: (1) `autoOrient().rotate()/flop()` a un PNG sin pérdida en memoria, y (2) `extract` + `resize`.

### 16.4 Editor (`Editor.tsx`)

Se abre sobre el visor con `E` (solo fotos).

- **Barra de herramientas**:
  - Recortar, con proporciones Libre, Original, 1:1, 4:3, 3:2, 16:9 y sus versiones verticales;
  - Girar a la izquierda (`rotate q=3`) y Girar a la derecha (`q=1`);
  - Voltear horizontal y Voltear vertical;
  - Deshacer (`Ctrl+Z`) y Rehacer (`Ctrl+Y`);
  - "Restablecer original", "Cancelar" y "Guardar".
- **Recorte**:
  - un rectángulo con 8 asas, que se mueve arrastrando su interior, y una rejilla de tercios;
  - con teclado, el rectángulo y cada asa son enfocables (`aria-label`, p. ej. "Esquina superior izquierda del recorte"); las flechas mueven un 1 % (un 10 % con Shift).
- **Sesión**:
  - parte de las operaciones guardadas `L` y añade las del usuario para formar `L'`; la pila de deshacer vive en el renderer;
  - "Guardar" envía `edits:save { ops: L' }`; si `L'` supera 64 operaciones, antes se colapsa a su forma canónica (≤ 3 ops: `rotate`, `flipH`, `crop`);
  - "Restablecer original" deja `L' = []`;
  - "Cancelar" descarta los cambios.
- Los vídeos no se editan, porque el requisito limita la edición a recortar, voltear y girar fotos.

### 16.5 Guardar ediciones y regenerar la miniatura (main)

1. Validar los datos (10.3) y que el medio sea una foto `ready`. Registrar el trabajo `edit` en `JobRegistry` (12.11): `BUSY` si ya hay una edición del mismo medio en curso (en `maintenance`, el canal ya devuelve `BUSY`, 5.6).
2. Descifrar el original (`readAll`).
3. Renderizar (16.3) con `getSharp()` (12.4, paso 4).
4. Escribir un objeto miniatura nuevo con `thumbId` nuevo en `tmp/<thumbId>.part` (`fsync`), registrar `thumbId` en `inFlight` (12.6) y renombrarlo a `thumbs/<aa>/<thumbId>` **antes** de la transacción.
5. Transacción: sustituir las filas de `media_edits`, poner `thumb_id` nuevo y hacer `thumb_rev += 1`. Si falla, borrado criptográfico de la miniatura nueva (ya renombrada) y salida de `inFlight`.
6. Tras el `COMMIT`, salida de `inFlight` y borrado criptográfico de la miniatura antigua.
7. Evento `library:changed { reason: 'edit', ids: [id] }`.

La regeneración de la reconciliación (12.6, punto 3) y la de una sustitución con ediciones (12.7, punto 3) usan estos mismos pasos 2–6 con las ediciones ya guardadas.

| Fallo | Recuperable | El llamador recibe | Log |
|---|---|---|---|
| El original no descifra | No (archivo dañado) | `INTEGRITY` | warn |
| sharp no decodifica o renderiza | Sí (sin cambios) | `INTERNAL` | warn (código de sharp) |
| Otra edición del mismo medio en curso | Sí | `BUSY` | – |
| Bloqueo durante la edición | Sí (sin cambios; la reconciliación limpia la miniatura nueva si llegó a renombrarse, 12.6, punto 7) | `LOCKED` (la ventana se sustituye) | info |
| Disco lleno | Sí | `DISK_FULL` | warn |
| Error de E/S o de DB | Sí | `IO` | error |

En todos los casos se borra el `.part` y las ediciones guardadas no cambian.

### 16.6 Reproductor de vídeo (`VideoPlayer.tsx`, `PlayerControls.tsx`)

- **Elemento**: `<video src="vault://media/<id>" preload="metadata" autoplay playsInline disablePictureInPicture disableRemotePlayback controlsList="nodownload noremoteplayback">`, sin `controls` nativos.
- **Controles** (solo los básicos):
  - reproducir/pausar;
  - barra de progreso (`Slider`), con los rangos ya cargados y un tooltip con el tiempo;
  - −10 s y +10 s;
  - tiempo actual / total;
  - volumen (`Slider`) y silencio;
  - velocidad (menú 0,25×, 0,5×, 0,75×, 1×, 1,25×, 1,5×, 1,75× y 2×, con `preservesPitch = true`);
  - bucle (`video.loop`);
  - pantalla completa (`window:setFullScreen`).
  - Sin subtítulos.
- **Teclado**:

| Tecla | Acción |
|---|---|
| Espacio / `K` | Reproducir/pausar |
| `J` / `L` | −10 s / +10 s |
| `Shift+←` / `Shift+→` | −10 s / +10 s |
| ←/→ | Anterior/siguiente elemento en el visor, salvo que el foco esté en la barra de progreso (entonces la mueve) |
| ↑/↓ | Volumen ±5 % cuando el foco está dentro del reproductor |
| `M` | Silencio |
| `F` | Pantalla completa |
| `Shift+,` / `Shift+.` | Velocidad −/+ un paso |
| `R` | Alterna el bucle |

- **Visibilidad de los controles**: se ocultan a los 2,5 s sin movimiento mientras se reproduce, y siguen visibles si el foco está dentro.
- **Duración**: `video.duration`, o `durationMs` de la DB si no es finita (18.4).
- **Errores**: el evento `error` muestra "No se puede reproducir este vídeo". Si la cabecera `X-Galeria-Error` era `INTEGRITY`, el mensaje es "archivo dañado".
- **Reproducción activa**: con el vídeo en marcha se envía `session:setPlayback { active: true }`, que pausa el auto-bloqueo, pausa los fondos animados y activa `powerSaveBlocker` (`prevent-display-sleep`).
- El volumen y la velocidad se recuerdan durante la sesión, solo en memoria.

---

## 17. Presentación (`screens/presentation/`)

### 17.1 Inicio y secuencia

Formas de empezar una presentación:

- desde la galería, con "Presentación" o F5: las diapositivas son los elementos seleccionados en el orden actual de la galería (o todo el resultado visible si no hay selección);
- desde una playlist: sus elementos en el orden de la playlist.

El renderer pide `presentation:getConfig { playlistId? }`, que devuelve los ajustes efectivos (los propios de la playlist o los predeterminados) y las pistas de música. `PresentationScreen` se monta como una capa por encima del shell. Fotos y vídeos se mezclan en la misma secuencia.

### 17.2 Ajustes

| Campo | Por defecto | Rango y notas |
|---|---|---|
| `transition` | `fade` | `fade`, `slide`, `zoom`, `kenburns`, `random` o `none` |
| `randomPool` | `[fade, slide, zoom, kenburns]` | Subconjunto no vacío. Sirve para quitar transiciones concretas del modo aleatorio |
| `transitionMs` | 700 | 0–3000; 0 equivale a `none` |
| `slideMs` | 5000 | 1000–60000 en pasos de 500 (solo fotos; los vídeos duran lo que duran) |
| `loop` | `true` | Tras la última diapositiva sigue la primera |
| `startFullscreen` | `true` | `false` = presentación en la ventana |
| `audioMode` | `video` | Qué suena **durante los vídeos**: `video` (solo el audio del vídeo), `music` (solo la música), `both` (los dos) o `mute` (nada) |
| `musicEnabled` | `false` | Interruptor global de la música de fondo |
| `trackIds` | `[]` | ≤ 100 pistas en orden; se repiten en bucle. Van en la DB cifrada |
| `musicVolume` / `videoVolume` | 0,7 / 1,0 | 0–1 |
| `musicFadeMs` | 1500 | 0–5000 |

Dónde se editan:

- en el panel de la presentación (icono de engranaje), en vivo, con "Guardar como predeterminado" y, si viene de una playlist, "Guardar para esta playlist";
- en Ajustes → Presentación (los valores por defecto);
- en el detalle de una playlist (ajustes propios de esa playlist).

Los cambios de transición y duración se aplican desde la diapositiva siguiente. Los de audio, al momento.

Interpretación del requisito (punto de decisión D16, para que el usuario la confirme): "silenciar todo" (`mute`) y "los dos activos" (`both`) se refieren a lo que suena durante los vídeos. Durante las fotos suena la música si `musicEnabled`. Para silencio total en toda la presentación se desactiva la música (`musicEnabled = false`) y se elige `mute`. En el menú de modo de audio de la presentación, la opción `mute` se rotula "Silencio en los vídeos" y debajo aparece el interruptor "Música de fondo", para que las dos piezas se vean juntas.

### 17.3 Transiciones (`transitions.ts`, descripción pura → Motion `animate()`)

Dos capas absolutas (A/B). Solo se animan `opacity` y `transform`, que se componen en GPU. `D = transitionMs`.

| Tipo | Entrante | Saliente | Curva |
|---|---|---|---|
| `fade` | opacidad 0 → 1 | opacidad 1 → 0 | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `slide` | `translateX(100%)` → 0 (o desde −100 % al retroceder) | 0 → `translateX(−100%)` (o +100 %) | `cubic-bezier(0.2, 0, 0, 1)` |
| `zoom` | escala 1,08 → 1 y opacidad 0 → 1 | escala 1 → 0,96 y opacidad 1 → 0 | `cubic-bezier(0, 0, 0.2, 1)` |
| `kenburns` | fundido como `fade`; además, en **fotos** la capa hace durante `D + slideMs + D` (lineal) un zoom-in de 1,0 a 1,12 o un zoom-out de 1,12 a 1,0, alternando, con un desplazamiento aleatorio del 3–5 % en una de 8 direcciones | como `fade` | lineal / `fade` |
| `none` | corte instantáneo | – | – |
| `random` | en cada diapositiva elige uno de `randomPool`, sin repetir el anterior si hay más de uno | | |

Los vídeos con `kenburns` usan `fade`. Con `prefers-reduced-motion`, cualquier tipo se convierte en `fade` de 150 ms, sin Ken Burns.

### 17.4 Temporización (`scheduler.ts`, puro, con reloj inyectable)

- **Estados de cada diapositiva**: `preparing → entering (D) → showing → leaving (D, solapado con el entering de la siguiente)`.
- **Duración de `showing`**: una foto se muestra `slideMs` desde que termina de entrar. Un vídeo empieza a reproducirse al terminar `entering` y se muestra hasta `ended`.
- **Eventos**: `next`, `prev`, `pause`, `resume`, `loaded(i)`, `failed(i)`, `ended(i)` y `tick`.
- **Pausa**: congela el tiempo que queda y pausa el vídeo y la música.
- **Siguiente/anterior manual**: cancela el temporizador y empieza la transición de inmediato.
- **Diapositiva no lista a tiempo**: se mantiene la actual hasta 8 s más. Si sigue sin estar lista, `failed` la omite con el toast "Se omitió un elemento que no se pudo cargar".

### 17.5 Precarga

En cuanto la diapositiva `i` entra en `showing`, se prepara la `i+1` (vuelve a la 0 si `loop`):

- **Foto**: `media:get` (para las ediciones), `img.src = vault://media/<id>` y `await img.decode()`.
- **Vídeo**: se asigna a uno de los 3 `<video crossOrigin="anonymous">` del pool, que se crean al empezar y quedan conectados a Web Audio una sola vez. `preload="auto"`, `src`, `load()` y espera a `canplay` (timeout de 8 s); el póster es `vault://thumb/<id>`.

Los elementos del pool que no se usan se liberan con `pause()`, `removeAttribute('src')` y `load()`.

### 17.6 Bucle y final

- **`loop = true`**: después de la última diapositiva viene la 0, con la transición normal.
- **`loop = false`**: al acabar la última, aparece la capa "Fin de la presentación" con "Volver a empezar" (Enter) y "Salir" (Esc), y la música se desvanece en `musicFadeMs`.

### 17.7 Ventana o pantalla completa

- **Al empezar**: si `startFullscreen`, `window:setFullScreen { on: true }`. `F` alterna. Al salir se restaura el estado anterior.
- **Modo ventana**: la presentación ocupa toda el área de contenido bajo la barra de título del tema, que se mantiene para poder mover y redimensionar la ventana, sobre fondo negro.
- **Durante la reproducción**: `session:setPlayback { active: true }`. Main activa `powerSaveBlocker.start('prevent-display-sleep')` y pausa el temporizador de inactividad. Al pausar o salir se desactiva todo. Los fondos animados también se pausan (15.7).

### 17.8 Grafo de Web Audio (`audio-graph.ts`)

```
AudioContext({ latencyHint: 'playback' })            (se crea con el clic que inicia la presentación)

<audio crossOrigin="anonymous" src="vault://music/<trackId>"> ─▶ MediaElementSource ─▶ musicGain ─┐
<video #0 crossOrigin="anonymous"> ─▶ MediaElementSource ─▶ videoGain[0] ───────────────────────┤
<video #1 …>                       ─▶ MediaElementSource ─▶ videoGain[1] ───────────────────────┼─▶ master ─▶ destination
<video #2 …>                       ─▶ MediaElementSource ─▶ videoGain[2] ───────────────────────┘
```

`vault://` responde con `Access-Control-Allow-Origin` (11.3). Sin CORS, `MediaElementSource` entregaría silencio.

**Fundidos** (`fadeTo`, en `audio-graph.ts`). No se usa `setValueCurveAtTime`: la especificación de Web Audio lanza `NotSupportedError` si se programa cualquier otro evento dentro del intervalo de una curva activa, y eso rompería el control cuando el usuario mueve el volumen durante un fundido. La curva de potencia constante se aproxima con 32 rampas lineales, que `cancelAndHoldAtTime` sí puede cortar en cualquier momento:

```ts
export function fadeTo(ctx: BaseAudioContext, p: AudioParam, target: number, ms: number): void {
  const t0 = ctx.currentTime;
  p.cancelAndHoldAtTime(t0);                 // corta curvas o rampas en curso y fija el valor actual
  const from = p.value;
  if (ms <= 0) { p.setValueAtTime(target, t0); return; }
  const up = target > from;
  for (let k = 1; k <= 32; k++) {
    const u = k / 32;
    const g = up ? from + (target - from) * Math.sin((u * Math.PI) / 2)     // subida: sin
                 : target + (from - target) * Math.cos((u * Math.PI) / 2);  // bajada: cos
    p.linearRampToValueAtTime(g, t0 + (u * ms) / 1000);
  }
}
```

**Volumen del usuario**: mover `musicVolume` o `videoVolume` actualiza el valor en el estado de la presentación. Solo se llama a `fadeTo(…, nuevoValor, 100)` si, según `audioPlan`, esa ganancia tiene que estar sonando en ese momento (por ejemplo, la música durante una foto); si no, el valor nuevo se usa en el siguiente fundido de entrada. Todos los cambios de ganancia, del usuario o automáticos, pasan por `fadeTo`; ningún código llama directamente a los métodos de `AudioParam`.

**Tests**: `tests/unit/renderer/audio-fade.test.ts` (Vitest, Node, sin Web Audio) usa un `AudioParam` falso que registra los eventos y aplica las reglas de la especificación: solo se llaman `cancelAndHoldAtTime`, `setValueAtTime` y `linearRampToValueAtTime`; nunca `setValueCurveAtTime`; los tiempos son estrictamente crecientes; los valores son monótonos y terminan en `target`; un segundo `fadeTo` a mitad de otro empieza con `cancelAndHoldAtTime`. En F4, el E2E de la presentación cambia el volumen de la música en mitad de un fundido de vídeo y comprueba que no hay ningún `pageerror`.

**Decisión de audio por diapositiva** (`audioPlan(mode, kind)`, puro y testeado):

| `audioMode` | Diapositiva de **foto** | Diapositiva de **vídeo**: música | Diapositiva de vídeo: audio del vídeo |
|---|---|---|---|
| `video` (**por defecto**) | música a `musicVolume` (si `musicEnabled`) | se desvanece a 0 en `musicFadeMs` desde que empieza la transición de entrada; después `musicEl.pause()` | `videoGain` 0 → `videoVolume` en 300 ms al empezar a reproducir |
| `music` | música | sigue sonando | `videoGain` = 0 |
| `both` | música | sigue sonando | 0 → `videoVolume` en 300 ms |
| `mute` | música | desvanecer y pausar (igual que `video`) | `videoGain` = 0 |

- **Al salir de un vídeo** (`ended`, `next` o `prev`): `videoGain` baja a 0 en `min(300, D)` ms. Si la música estaba pausada por el vídeo, `musicEl.play()` y sube a `musicVolume` en `musicFadeMs`, empezando con la transición de salida. Así la música se reanuda donde se quedó.
- **Música**: las pistas se encadenan en orden y en bucle (`ended` pasa a la siguiente, sin fundido entre pistas). Una pista que falla se salta, y si fallan todas se desactiva la música con un toast.
- **Inicio**: la música sube de 0 a `musicVolume` en `musicFadeMs`.
- **Pausa**: se pausan los elementos.
- **Salir**: `master` baja a 0 en 300 ms y luego `ctx.close()`.
- **Si no se puede crear el `AudioContext`**: la presentación sigue sin música, y los vídeos suenan directamente desde el elemento con `volume = videoVolume` y `muted` según el modo.

### 17.9 Controles y teclado

- **Barra inferior**, que se oculta a los 3 s sin movimiento: anterior, reproducir/pausar, siguiente, posición ("3 / 25"), música sí/no, menú de modo de audio, ajustes (engranaje), pantalla completa y salir.
- **Teclado**:
  - Espacio: reproducir/pausar;
  - ←/→: anterior/siguiente;
  - `F`: pantalla completa;
  - `M`: música sí/no;
  - Esc: cierra el panel de ajustes si está abierto y, si no, sale.
- **Foco**: queda atrapado en la presentación (`role="dialog"`, `aria-label="Presentación"`). Al salir vuelve al control que la inició.
- **Anuncios**: la región `aria-live` dice "Diapositiva 3 de 25" solo al navegar a mano.

### 17.10 Errores

| Fallo | Comportamiento | Log |
|---|---|---|
| `presentation:getConfig` falla | No empieza; toast con el mensaje del código | warn (main) |
| Una diapositiva no carga (404/500/timeout) | Se omite (17.4) | debug (renderer, solo en desarrollo) |
| Fallan todas | Sale con el mensaje "No se pudo reproducir ningún elemento" | – |
| Falla una pista de música | Se pasa a la siguiente; si fallan todas, la música se desactiva | – |
| Se bloquea la sesión durante la presentación | La sustitución de la ventana lo cierra todo (13.3) | – |

---

## 18. Vídeo dual y fusión

### 18.1 Reproducción dual (`screens/dual/DualVideoScreen.tsx`, `sync.ts`)

- **Cómo se llega**:
  - desde la galería, con exactamente 2 vídeos seleccionados y "Vídeo dual";
  - desde la navegación ("Vídeo dual"), donde hay dos huecos "Elegir vídeo…". Cada uno abre un diálogo con la rejilla de la galería filtrada a vídeos.
- **Disposición**: dos `<video src="vault://media/<id>">` al 50 % de ancho con `object-fit: contain`, fondo negro y 2 px de separación.
- **Audio por defecto**: el izquierdo suena y el derecho está silenciado. Cada lado tiene su volumen y su silencio.
- **Modo sincronizado** (por defecto; interruptor "Controles sincronizados"):
  - Línea de tiempo común de `max(dL, dR)`. El vídeo más largo es el reloj maestro.
  - Una sola barra de controles, igual que la de 16.6, que actúa sobre los dos: reproducir/pausar, buscar, ±10 s, velocidad y bucle.
  - Al buscar a `t`: `maestro.currentTime = t` y `esclavo.currentTime = min(t, dEsclavo)`. Si `t ≥ dEsclavo`, el esclavo se queda pausado en su último fotograma.
  - Corrección de deriva cada 250 ms, mientras los dos se reproducen, con `drift = esclavo.currentTime − maestro.currentTime`:
    - si `|drift| > 0,5 s`, `esclavo.currentTime = maestro.currentTime`;
    - si `0,04 < |drift| ≤ 0,5`, `esclavo.playbackRate = rate · (1 − sign(drift) · 0,05)` hasta que `|drift| < 0,02`, y entonces vuelve a `rate`.
  - Si uno emite `waiting`, se pausa el otro hasta que los dos emitan `canplay`.
  - En bucle, los dos vuelven a 0 cuando termina el maestro.
- **Modo independiente**: cada lado tiene su propia barra de 16.6.
- **Teclado**:
  - en sincronizado, los atajos de 16.6 actúan sobre los dos;
  - en independiente, sobre el lado que tiene el foco;
  - Tab recorre los grupos de controles, y `Ctrl+←/→` mueve el foco al lado izquierdo o derecho.
- Envía `session:setPlayback` igual que el reproductor.
- **"Crear vídeo fusionado"** abre `MergeDialog`:
  - Audio: Izquierdo / Derecho / Mezcla / Ninguno. Por defecto Mezcla si los dos tienen audio, y si no el que lo tenga. Las opciones sin audio aparecen deshabilitadas.
  - Duración: "La del más corto" (por defecto) / "La del más largo".
  - Nombre: por defecto "Fusión AAAA-MM-DD HH.mm".
  - Mientras se crea se muestra el progreso con "Cancelar". Solo puede haber una fusión activa (12.11): mientras tanto, "Crear vídeo fusionado" aparece deshabilitado. Una fusión en curso pausa el bloqueo por inactividad (D18, confirmado por el usuario); suspender, bloquear el SO o bloquear a mano la cancelan.

### 18.2 Parámetros calculados (`merge-service.ts`, con los datos de la DB)

- `H = 2 · floor(min(hL, hR, 1080) / 2)`, con las dimensiones de visualización, que ya tienen aplicada la rotación.
- `FPS = min(60, max(fpsL ?? 30, fpsR ?? 30))`, con 3 decimales.
- `D = shortest ? min(dL, dR) : max(dL, dR)` en segundos (3 decimales).
- `Δ = |dL − dR|`.

### 18.3 Línea de comandos exacta

```
ffmpeg -hide_banner -nostdin -v error -progress pipe:2 -nostats
  -protocol_whitelist http,tcp,pipe
  -seekable 1 -f <DEMUX_L> -i http://127.0.0.1:<P>/<T>/l
  -seekable 1 -f <DEMUX_R> -i http://127.0.0.1:<P>/<T>/r
  -filter_complex "<GRAFO>"
  -map "[v]" <MAPA_AUDIO>
  -t <D>
  -c:v libvpx-vp9 -deadline good -cpu-used 5 -row-mt 1 -crf 32 -b:v 0 -pix_fmt yuv420p
  -force_key_frames "expr:gte(t,n_forced*4)"
  <CODEC_AUDIO>
  -map_metadata -1 -map_chapters -1
  -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof
  pipe:1
```

```
<GRAFO> =
  [0:v]scale=-2:<H>:flags=bicubic,setsar=1,fps=<FPS>,format=yuv420p<PAD_L>[l];
  [1:v]scale=-2:<H>:flags=bicubic,setsar=1,fps=<FPS>,format=yuv420p<PAD_R>[r];
  [l][r]hstack=inputs=2:shortest=1[v]<AUDIO>

<PAD_X>  = ",tpad=stop_mode=clone:stop_duration=<Δ>"  solo si duration=longest y X es el más corto; si no, vacío
<AUDIO>  left  : ";[0:a:0]aresample=48000,apad[a]"
         right : ";[1:a:0]aresample=48000,apad[a]"
         mix   : ";[0:a:0]aresample=48000[a0];[1:a:0]aresample=48000[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=1,apad[a]"
         mix con un solo lado con audio → igual que ese lado
         none o ningún lado con audio → vacío
<DEMUX_X>     = mov  (media.mime = video/mp4)  |  matroska  (media.mime = video/webm)
<MAPA_AUDIO>  = -map "[a]"  |  -an
<CODEC_AUDIO> = -c:a libopus -b:a 160k -ac 2  |  (vacío con -an)
```

- `scale=-2` deja el ancho par.
- `tpad` alarga el vídeo más corto congelando su último fotograma.
- `apad` junto con `-t D` iguala la duración del audio.
- `-t D` recorta en modo `shortest`.
- La rotación de los vídeos de origen la aplica el autorotate de ffmpeg (activo por defecto).

### 18.4 Contenedor y códec de salida (decisión): MP4 fragmentado con VP9 + Opus

**Contenedor**. La salida va por una tubería, nunca a un archivo, así que el contenedor tiene que poder escribirse sin hacer seek. Opciones:

| Opción | Resultado | ¿Elegida? |
|---|---|---|
| MP4 normal o `+faststart` | Necesita hacer seek en la salida; no funciona con una tubería | No |
| WebM/MKV por tubería | El muxer Matroska no escribe `Cues` ni `Duration` si no puede hacer seek. `<video>.duration` sería `Infinity` y la búsqueda quedaría degradada | No |
| MP4 fragmentado (`frag_keyframe+empty_moov+default_base_moof`) | Se escribe en secuencia. El demuxer mov de FFmpeg, que es el que usa Chromium en la reproducción progresiva, lee todos los `moof` cuando la fuente admite seek (`vault://` con Range) y obtiene la duración y los puntos de búsqueda | **Sí** |

**Códec**. El build LGPL no incluye un codificador H.264 por software (libx264 es GPL; ver 19). Como la app no exporta, la compatibilidad fuera de ella no importa. Chromium decodifica VP9 (por hardware en la mayoría de GPUs) y Opus dentro de MP4. Con un fotograma clave cada 4 s salen unos 150 fragmentos por cada 10 minutos, así que abrir el vídeo cuesta unas 150 lecturas pequeñas.

Lo mismo vale para las conversiones de la importación (12.5).

**Verificación obligatoria** (primera tarea de F5; en F2 la misma prueba se hace con un vídeo convertido):

1. Generar dos vídeos sintéticos con `testsrc2` + `sine` (20 s y 12 s).
2. Fusionarlos.
3. En el reproductor, comprobar que `video.duration` es finita e igual a `D ± 0,5 s`, y que un `currentTime = 0,75·D` dispara `seeked` en menos de 3 s.

Si falla, el reproductor ya usa `durationMs` de la DB para la barra (16.6), pero **este punto de diseño se reabre** (no se improvisa en la fase).

### 18.5 Servidor loopback (`media/loopback-server.ts`)

Es la entrada de ffmpeg y ffprobe cuando el origen es un objeto cifrado: fusiones, miniaturas y verificación de vídeos importados.

- `http.createServer()` con `listen({ host: '127.0.0.1', port: 0, exclusive: true })`, en un puerto aleatorio del SO.
- **Token**: `randomBytes(32).toString('base64url')`. Las rutas son `/<token>/<ref>`, donde `ref` es una etiqueta corta (`l`, `r`, `src`) registrada por el trabajo, que apunta a `{ ruta, fileId, kind }`.
- **Validación**:
  - `req.headers.host === '127.0.0.1:<P>'` (defensa contra DNS rebinding);
  - método GET o HEAD;
  - token comparado con `timingSafeEqual`;
  - `ref` registrada.

  Cualquier fallo devuelve 404 sin cuerpo y cierra el socket.
- **Respuesta**: Range y cabeceras como en 11.2/11.3 (reutiliza `range.ts` y `object-reader.ts`), pero sin CORS.
- **Límites**: `headersTimeout = 10 000`, `requestTimeout = 0` (streams largos), `keepAliveTimeout = 5000` y `maxConnections = 8`.
- **Vida**: un servidor por trabajo, que se cierra (`close()` + `closeAllConnections()`) al terminar, al cancelar y al bloquear. No registra las peticiones.
- **Por qué no tuberías**: los MP4 con `moov` al final necesitan seek en la entrada, la fusión tiene dos entradas, y los descriptores extra (`pipe:3`) no son fiables en Windows.
- Otro proceso local podría conectarse mientras el servidor está abierto, pero necesitaría el token de 256 bits. El malware activo queda fuera del modelo (5.1).

### 18.6 De ffmpeg al cifrador e importación del resultado

1. `spawn(ffmpeg, args)` y `pipeline(child.stdout, objectWriter(kind 1, tmp/<id>.part))`, con backpressure. `hashA` es el SHA-256 de la salida y el HMAC de duplicados se calcula sobre la salida.
2. El progreso es `fraction = out_time_us / (D·10⁶)` y se emite con `merge:progress` como mucho cada 250 ms.
3. Con código de salida 0, se verifica: descifrar el temporal (`hashB == hashA`), y `ffprobe -f mov` por loopback sobre el temporal, que tiene que tener una pista de vídeo, duración `D ± 0,5 s` y ancho = la suma de los dos anchos escalados.
4. **Fusión idéntica ya existente**: VP9 con `-map_metadata -1` es determinista, así que fusionar dos veces el mismo par con los mismos parámetros produce los mismos bytes. Si `SELECT id FROM media WHERE content_hmac = ? AND state = 'ready'` devuelve una fila, se borra el `.part` (borrado criptográfico, 12.10) y se emite `merge:done { jobId, result: { ok: true, data: { mediaId: <existente>, existed: true } } }`; la UI muestra el toast "Ya existía un vídeo idéntico" y abre ese vídeo. Si el `INSERT` del paso 6 fallara igualmente con `SQLITE_CONSTRAINT_UNIQUE` (otra escritura en paralelo), se trata igual.
5. Miniatura, como en 12.4.
6. Inserción en la DB con `source = 'merge'`, `kind = 'video'`, `mime = 'video/mp4'`, `original_ext = 'mp4'`, `converted = 1` (9.2), `captured_at = ahora (naive)`, `captured_at_source = 'generated'` y los códecs `vp9`/`opus`. Registrar los ids del objeto y de la miniatura en `inFlight` (12.6).
7. Renombrar (con el tratamiento de fallos de 12.4, paso 6) y marcar `ready`; salida de `inFlight`; `library:changed { reason: 'merge' }` y `merge:done { jobId, result: { ok: true, data: { mediaId, existed: false } } }`. No hay ningún original que borrar.

### 18.7 Errores de la fusión

| Fallo | Recuperable | El llamador recibe | Log |
|---|---|---|---|
| ffmpeg ausente | Sí (falta instalarlo o empaquetarlo) | `FFMPEG_MISSING`; el botón aparece deshabilitado si `!ffmpegAvailable` | warn |
| ffmpeg sale con código ≠ 0 | Sí | `merge:done` con `FFMPEG_FAILED` | warn (últimas 2 KiB de stderr, que no contienen nombres porque las entradas son URLs con ids) |
| Disco lleno | Sí | `DISK_FULL` | warn |
| La verificación falla | Sí | `INTEGRITY` | warn |
| Ya existe un vídeo idéntico | – (no es un fallo) | `ok` con `existed: true` y el `mediaId` existente (18.6, paso 4) | info |
| Ya hay una fusión activa | Sí | `BUSY` en `merge:start` (12.11) | – |
| Cancelación o bloqueo | – | `CANCELLED` (con bloqueo, `merge:done` no llega: la ventana se sustituye) | info |

En todos los casos se mata el proceso, se cierra el loopback y se borran los `.part`.

---

## 19. ffmpeg/ffprobe: empaquetado y licencias

### 19.1 Opciones

| Opción | Licencia | Codificar H.264 | Tamaño (zip/tar, por plataforma) | Valoración |
|---|---|---|---|---|
| A. `ffmpeg-static` (npm) | GPL-3.0-or-later | Sí (libx264) | unos 80 MB por binario | GPL: obligación de ofrecer el código fuente; la app podría seguir siendo no GPL al ser un ejecutable aparte ("agregación"), pero la licencia es más restrictiva y no trae ffprobe |
| B. **BtbN `lgpl-shared` 8.1.3** | LGPL-2.1-or-later | No por software (no hay libx264 ni x265). Los codificadores por hardware `h264_mf`/`nvenc`/`qsv`/`amf`/`vaapi` dependen de la máquina y no se usan | 77,2 MB (Windows), 62,8 MB (Linux) | Licencia permisiva para distribuir. Incluye libvpx (BSD), libopus (BSD), dav1d (BSD) y los decodificadores nativos de FFmpeg (h264, hevc, mpeg4, prores…) |
| C. BtbN GPL | GPL-3.0 | Sí | 86–184 MB | Igual que A |
| D. ffmpeg del sistema (Linux) | Variable | Variable | 0 | Versiones y códecs distintos en cada distro; no encaja con AppImage |
| E. Compilar uno propio | LGPL | – | Mínimo | Mucho mantenimiento |

**Recomendación (D4): B.** Conversiones y fusiones salen en VP9 + Opus (18.4), así que no hace falta codificar H.264 y se evitan las obligaciones de la GPL. La decodificación de H.264/HEVC la hace el decodificador nativo de FFmpeg (LGPL). Si algún día se distribuye la app comercialmente, conviene consultar las patentes de H.264/HEVC con un abogado; para uso privado no aplica.

**Obligaciones LGPL**:

- incluir `LICENSE` y el texto de la LGPL-2.1 en `resources/licenses/`;
- avisar en "Acerca de";
- dar el código fuente correspondiente o una oferta válida (LGPL-2.1, sección 6): el binario es FFmpeg `n8.1.3-23-g5c4f5744cd` (rama `release/8.1`, commit `5c4f5744cd`), compilado con los scripts de BtbN/FFmpeg-Builds del tag `autobuild-2026-10-22-13-06`. Como BtbN borra los releases con el tiempo, señalar el release no basta: `fetch-ffmpeg.mjs` guarda también **una copia propia** de los dos paquetes de código fuente (19.3) y "Acerca de" indica que se entregan bajo petición. Mientras el uso sea privado esta obligación no se activa, pero queda prevista;
- no modificar los binarios;
- ffmpeg se ejecuta como proceso aparte.

### 19.2 Artefactos fijados (`resources/ffmpeg/manifest.json`)

| Plataforma | Archivo (del release `autobuild-2026-10-22-13-06` de github.com/BtbN/FFmpeg-Builds) | SHA-256 (de `checksums.sha256` oficial) |
|---|---|---|
| win-x64 | `ffmpeg-n8.1.3-23-g5c4f5744cd-win64-lgpl-shared-8.1.zip` | `c41df73a3f3259e81d5d53e6ce0c4c80b4841a30894fb77954650e445daa6c53` |
| linux-x64 | `ffmpeg-n8.1.3-23-g5c4f5744cd-linux64-lgpl-shared-8.1.tar.xz` | `97fa301cf2bbc0609f0879a3db4440a9829585dd14d3bfcf9d5d2080cc180705` |

URL: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-22-13-06/<archivo>`.

**Código fuente correspondiente** (LGPL, 19.1), también en el manifiesto:

| Paquete | URL | SHA-256 |
|---|---|---|
| FFmpeg en el commit del binario | `https://github.com/FFmpeg/FFmpeg/archive/<hash completo de 5c4f5744cd>.tar.gz` | Se fija en F2 en la primera descarga |
| Scripts de BtbN del tag fijado | `https://github.com/BtbN/FFmpeg-Builds/archive/refs/tags/autobuild-2026-10-22-13-06.tar.gz` | Se fija en F2 en la primera descarga |

F2 resuelve el hash completo del commit (40 hex) desde la página del commit `5c4f5744cd` de FFmpeg y lo escribe en el manifiesto. Los archivos que genera GitHub al vuelo no tienen garantizados los mismos bytes con el tiempo, así que el SHA-256 se registra en la **primera** descarga (`node scripts/fetch-ffmpeg.mjs --record-sources`, que solo escribe los campos vacíos) y las siguientes ejecuciones lo verifican; la copia guardada es la que vale.

BtbN borra los autobuilds pasado un tiempo. El script guarda los binarios y los dos paquetes de código fuente en `.cache/ffmpeg/` (en `.gitignore`) y acepta `GALERIA_FFMPEG_ARCHIVE_DIR` para usar una copia propia sin red. Recomendación: guardar los cuatro archivos fuera de git pero junto al proyecto.

### 19.3 `scripts/fetch-ffmpeg.mjs` (F2)

Recibe `--platform win|linux` (por defecto, el actual) y hace:

1. Busca el archivo en la caché o en `GALERIA_FFMPEG_ARCHIVE_DIR`; si no está, lo descarga. Es una herramienta de desarrollo, no de la app.
2. Comprueba el SHA-256 contra el manifiesto.
3. Extrae con `tar -xf`, que en Windows 10+ es bsdtar y admite zip.
4. Copia a `resources/ffmpeg/<os>-x64/`:
   - `bin/ffmpeg(.exe)` y `bin/ffprobe(.exe)`;
   - en Windows, `bin/*.dll`;
   - en Linux, `lib/*.so*`;
   - `LICENSE.txt`.

   No copia ffplay.
5. En la plataforma actual comprueba que `ffmpeg -hide_banner -encoders` incluye `libvpx-vp9` y `libopus`, y que `ffprobe -version` termina con código 0.
6. Descarga (si no están en la caché) los dos paquetes de código fuente de 19.2 a `.cache/ffmpeg/sources/` y comprueba su SHA-256; con `--record-sources` escribe los SHA-256 que falten en el manifiesto. No los copia a `resources/` ni al instalador.
7. Escribe `BUILDINFO.json`.

La verificación de Linux solo puede hacerse en Linux.

### 19.4 Uso en tiempo de ejecución (`media/ffmpeg.ts`)

- **Ruta**:
  - empaquetado: `join(process.resourcesPath, 'ffmpeg', 'bin', 'ffmpeg' + (win ? '.exe' : ''))`;
  - en desarrollo: `resources/ffmpeg/<os>-x64/bin/…`.
- **Disponibilidad**: al arrancar se comprueba con `fs.access(X_OK)` y se expone en `AppInfo.ffmpegAvailable`.
- **Sin ffmpeg**:
  - la importación de vídeos falla con `FFMPEG_MISSING`; las fotos funcionan;
  - la fusión queda deshabilitada;
  - la duración de la música queda en `null`.
- **`spawn(bin, args, opciones)`**:
  - `windowsHide: true` y `stdio: ['ignore', 'pipe', 'pipe']`;
  - `signal` del trabajo (12.11): al abortar, `kill()` inmediato (13.3, paso 2);
  - entorno mínimo: `SystemRoot` en Windows; `LD_LIBRARY_PATH=<dir>/lib` en Linux.
- **Timeouts**: ffprobe 30 s; miniatura 30 s; conversión y fusión sin timeout, pero cancelables.
- **Argumentos**: se construyen solo con funciones de `ffmpeg.ts` que fijan siempre `pipe:1` como salida y nunca aceptan una ruta de salida.
- **Demuxer forzado**: toda invocación lleva `-f <demuxer>` antes de cada `-i`, sin autodetección. Originales: según la firma (12.4, paso 0). Objetos de la bóveda por loopback: `mov` para `video/mp4` y `matroska` para `video/webm`. Música: `mp3`, `aac`, `mov`, `ogg`, `flac` o `wav` según la firma (8.6.1).
- **`child_process`** solo se importa en este archivo (regla ESLint de 5.4, punto 10).

---

## 20. Empaquetado y builds

### 20.1 `electron-builder.yml` (versión completa en F7; el scaffold crea solo `appId`, `productName`, `directories`, `files`, `asar`, `npmRebuild` y `publish`)

```yaml
appId: app.galeria.desktop
productName: Galería
executableName: galeria
directories:
  output: release
  buildResources: resources/build
files:
  - out/**
  - package.json
asar: true
asarUnpack:
  - "**/*.node"
  - "node_modules/sharp/**"
  - "node_modules/@img/**"
extraResources:
  - from: resources/ffmpeg/${os}-x64
    to: ffmpeg
  - from: resources/licenses
    to: licenses
npmRebuild: false            # todos los módulos nativos son N-API precompilados (2.1)
publish: null                # sin auto-actualización
electronFuses:
  runAsNode: false
  enableCookieEncryption: false   # no hay cookies que proteger (sesión en memoria); evita el llavero/D-Bus en Linux
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true   # Windows; en Linux no aplica
  onlyLoadAppFromAsar: true
  loadBrowserProcessSpecificV8Snapshot: false
  grantFileProtocolExtraPrivileges: false
win:
  target: [nsis]
  icon: resources/build/icon.ico
  artifactName: Galeria-${version}-win-${arch}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: false   # desinstalar NUNCA borra bóvedas
linux:
  target: [AppImage, deb]
  category: Graphics
  icon: resources/build/icon.png
  artifactName: Galeria-${version}-linux-${arch}.${ext}
```

Las `dependencies` de producción las incluye electron-builder automáticamente en `app.asar`. Las del renderer están en `devDependencies` y ya van empaquetadas en `out/renderer`. Los datos están en `%LOCALAPPDATA%\Galeria` y `~/.local/share/Galeria`, que el desinstalador no toca.

**Llavero en Linux**: con el cifrado de cookies activo, Chromium usa Secret Service o KWallet por D-Bus y algunos escritorios piden desbloquear o crear el llavero al arrancar, aunque la app no use cookies (la ventana usa una sesión en memoria y no carga contenido remoto). Por eso `enableCookieEncryption: false` y, en Linux, `--password-store=basic` (5.2). F7 verifica en GNOME y KDE que no aparece ningún aviso del llavero.

### 20.2 Fuses e implicaciones para los tests

Con `enableNodeCliInspectArguments: false` y `runAsNode: false`, Playwright no puede controlar el binario empaquetado, porque `_electron.launch` necesita el inspector. Por eso los E2E se ejecutan contra `out/` con el Electron de desarrollo (`electron .`), y el build empaquetado tiene una lista de comprobación manual en F7: arranca, crear perfil, importar, ver, presentación, bloquear.

### 20.3 Linux

- **Dónde compilar**: en Windows solo se instalan los binarios nativos de win32 (`@img/sharp-win32-x64`, `@node-rs/argon2-win32-x64-msvc`), así que **los paquetes de Linux se construyen en Linux**. Recomendación (D11): WSL2 con Ubuntu 24.04 en esta misma máquina (local, sin nube), con `npm ci`, `npm run fetch:ffmpeg -- --platform linux` y `npm run dist:linux`. Alternativa: GitHub Actions `ubuntu-24.04`, que implica subir el código a GitHub.
- **Distros objetivo**: Ubuntu 22.04+, Debian 12+ y Fedora 39+ (glibc moderna exigida por sharp y los prebuilds). Se verifica en F7.
- **AppImage y el sandbox**: en Ubuntu 24.04+ AppArmor restringe los user namespaces sin privilegios y Electron no puede iniciar su sandbox desde un AppImage. Se recomienda el **.deb**, que instala `chrome-sandbox` con SUID. Para el AppImage se documenta que requiere un perfil AppArmor (o ajustar `kernel.apparmor_restrict_unprivileged_userns`). **Nunca** se usa `--no-sandbox`.
- **Windows**: los binarios no están firmados, así que SmartScreen avisará. La firma de código queda fuera de alcance (24.1).

---

## 21. Manejo de errores y logging

### 21.1 Política

- Main nunca lanza errores al renderer: devuelve `Result<T>` con un `ErrorCode` (10.1) y, como mucho, `details` sin datos de contenido. El renderer elige el mensaje.
- Cada operación que puede fallar tiene su tabla o su descripción de fallos: desbloqueo, perfiles, música y traslado de la bóveda en esta sección; importación 12.4 (y 12.7 para la sustitución de duplicados); protocolo 11.4; ediciones 16.5; presentación 17.10; fusión 18.7; DB 9.3.
- "Recuperable" significa que la app sigue funcionando y el usuario puede reintentar. "Fatal para la sesión" significa que no se desbloquea (`VAULT_CORRUPT`). No hay errores que tumben la app: `process.on('uncaughtException' | 'unhandledRejection')` registra un `error`, bloquea la sesión (motivo `error`) y muestra un diálogo nativo "Se produjo un error inesperado; la bóveda se ha bloqueado" antes de seguir.

Tabla del desbloqueo:

| Fallo | Recuperable | El llamador recibe | Log |
|---|---|---|---|
| El perfil no existe | Sí | `PROFILE_NOT_FOUND` | warn |
| Contraseña incorrecta | Sí | `WRONG_PASSWORD` | info (sin datos) |
| Argon2 sin memoria | Sí | `INTERNAL { reason: 'kdf-memory' }` | error |
| Falta `vault.json` o no coincide | Sí | `VAULT_UNAVAILABLE` | warn |
| La DB rechaza la clave con la contraseña correcta | Fatal para la sesión | `VAULT_CORRUPT { stage: 'open' }` | error |
| Falla una migración, o la DB es de una versión más nueva | Fatal para la sesión | `VAULT_CORRUPT { stage: 'migration' \| 'newer-version' }` | error |

Crear, editar, cambiar la contraseña o borrar un perfil:

| Fallo | Recuperable | El llamador recibe | Log |
|---|---|---|---|
| Validación (nombre, longitud, confirmación) | Sí | `VALIDATION` / `PROFILE_NAME_TAKEN` / `PROFILE_LIMIT` | – |
| Contraseña incorrecta (editar, cambiar, borrar) | Sí | `WRONG_PASSWORD` | info |
| Error al escribir `profiles.json` | Sí (sin cambios: la escritura es atómica) | `IO` | error |
| Al crear: falla Argon2 por memoria | Sí (no se ha creado nada) | `INTERNAL { reason: 'kdf-memory' }` | error |
| Al crear: falla crear la carpeta, `vault.json`, la DB, el avatar o el `rename` (pasos 3–6 de 14.4) | Sí (se deshace con `removeVaultDir`; `profiles.json` no cambia) | `IO` / `DISK_FULL` | error |
| Al crear: caída antes del punto de confirmación | Sí (al arrancar se borra `vaults/<id>.creating`) | – | warn |
| Al borrar: `removeVaultDir` deja restos después de quitar la entrada | Sí (la bóveda ya es inaccesible) | `ok` con `details.leftoverPath` | warn |

Importar música (8.6.1), por archivo:

| Fallo | Recuperable | El llamador recibe | Log |
|---|---|---|---|
| Firma no admitida | Sí | `failed[]` con `UNSUPPORTED_FORMAT` | debug |
| Más de 1 GiB | Sí | `failed[]` con `TOO_LARGE` | debug |
| Disco lleno | Sí (se detiene la importación) | `failed[]` con `DISK_FULL` para ese archivo y los restantes | warn |
| Error de E/S o de DB | Sí (se borra la copia) | `failed[]` con `IO` | warn (`errno`) |
| ffprobe falla | Sí (no es un fallo) | La pista se importa con `durationMs: null` | debug |

Traslado de la bóveda (8.7):

| Fallo | Recuperable | El llamador recibe | Log |
|---|---|---|---|
| Validación, espacio o trabajos en curso (paso 1) | Sí (sin cambios) | `VALIDATION` / `DISK_FULL` / `BUSY` / `IO` | – / warn |
| Fallo de copia o verificación (pasos 3–5) | Sí (se borra `<destino>.partial`, se reabre la DB original) | `relocate:done` con `IO` / `DISK_FULL` / `INTEGRITY` | warn |
| Cancelación antes del paso 5, o bloqueo antes del paso 5 | Sí (el borrado de `<destino>.partial` sigue sin claves en segundo plano tras un bloqueo, 13.3 paso 6) | `relocate:done` con `CANCELLED` (con bloqueo no llega: la ventana se sustituye) | info |
| Bloqueo desde el paso 5 | Sí (los pasos 5–6 y 8 terminan sin claves en segundo plano; el siguiente desbloqueo abre la bóveda nueva) | – | info |
| La DB no abre en el destino (paso 7) | Sí (se vuelve a la ubicación anterior) | `relocate:done` con `IO` | error |
| Restos al borrar la bóveda antigua (paso 8) | Sí (`pendingCleanup` lo reintenta) | `ok` con `leftoverPath` | warn |

### 21.2 Logging (`src/main/log.ts`)

- **Niveles**: `error`, `warn`, `info` y `debug` (este último solo con `!app.isPackaged`).
- **Destino**: `GaleriaData/logs/main.log`, rotado en 1 MiB × 3. En desarrollo también va a la consola.
- **API tipada que impide filtrar datos**:

```ts
log.warn(event: LogEvent, fields?: { code?: ErrorCode; mediaId?: Id; jobId?: Id; count?: number;
          ms?: number; bytes?: number; errno?: string; syscall?: string; stage?: string; scheme?: string })
```

  `LogEvent` es una unión cerrada de literales (`'import.file.failed'`, `'protocol.integrity'`, …). No acepta strings arbitrarios.
- **Nunca** se registran: nombres de archivo, rutas de originales, nombres de perfil o de playlist, títulos, términos de búsqueda, EXIF, contraseñas, claves, tokens, URLs ni `err.message`.
- El renderer no reenvía logs a main.

---

## 22. Invariantes y quién las hace cumplir

| Invariante | Responsable | Por qué ahí, y cómo se verifica |
|---|---|---|
| El renderer nunca recibe claves | main: `KeyRing` privado de `SessionManager`; ningún tipo del contrato IPC contiene claves | Es la única capa con claves. Revisión del contrato + test de que `ipc-contract.ts` no exporta ningún tipo `Buffer` en las respuestas |
| Nada descifrado se escribe en disco **por la propia app** (lo que el usuario arrastre o copie fuera de la ventana está fuera de alcance, 5.1) | main: `object-reader` solo produce memoria y streams; `ffmpeg.ts` solo admite `pipe:1` como salida; SQLite `temp_store=MEMORY`; sesión en memoria; `Cache-Control: no-store`; sharp solo vía `sharp-loader.ts` con `VIPS_DISC_THRESHOLD=4g` (12.4, paso 4) | Main controla toda la E/S. `tests/unit/main/no-temp-leak.test.ts` (F2) comprueba que libvips no crea temporales. E2E (F2/F5): tras importar y fusionar, ningún archivo bajo la raíz de datos de prueba (salvo la carpeta `music/`, que va en claro) contiene los primeros 64 bytes de ningún fixture, ni el marcador aleatorio de 32 bytes inyectado en el EXIF y en el nombre de los fixtures. No se buscan firmas cortas como `FF D8 FF`, porque aparecen por azar en el ciphertext |
| El original solo se borra después de verificar, renombrar y confirmar | `import-service` (orden de 12.4) | Test con inyección de fallos en cada paso: el original sigue presente y con el mismo hash |
| Borrar un perfil exige siempre su contraseña | `profile-service.deleteProfile`: lo primero es desenvolver la MK; no existe otra ruta de código | La UI no es una frontera de seguridad. Test: `profiles:delete` con una contraseña incorrecta no cambia nada |
| No hay red | `network-guard` (Chromium, con un solo listener por evento y sesión), proxy inexistente con `<-loopback>`, `node-egress-guard` (Node en main, en tiempo de ejecución), CSP, `host-resolver-rules`, **WebRTC** (`lockdown.ts` + `disable_non_proxied_udp` + proxy), reglas ESLint | E2E del scaffold con contador por capa, prueba de WebRTC con TURN/TCP y STUN/UDP a servidores del test, y unitario del guard de Node (5.4) |
| Las claves se ponen a cero al bloquear sin esperar a los trabajos (0 ms con suspensión y bloqueo del SO) | `SessionManager` (13.3): velo, `abortAll`, espera acotada, `db.close` + `zeroize` + `destroyKeys` síncronos; limpiezas sin claves en `KeylessCleanup` | Es el único que conoce el KeyRing y los objetos abiertos. Tests de 13.3 (Vitest con trabajo colgado; E2E con `suspend` simulado y ≤ 200 ms) |
| Ninguna transacción ni iterador de SQLite abarca un `await` | Repos de `src/main/db/**` y `getDb()` (13.3) | better-sqlite3 rechaza transacciones que devuelven promesas; ESLint `no-restricted-syntax`; así cerrar la DB en cualquier espera es seguro |
| Como mucho una importación y una fusión activas | `JobRegistry.start` (12.11) | Punto único donde nacen los trabajos; tests de BUSY por canal |
| El binario empaquetado no acepta switches de depuración de Chromium | `startup-checks.ts`, antes de cualquier ventana (5.2) | Unitario de la función pura y comprobación manual en F7 |
| Nunca se borra recursivamente una carpeta que no sea una bóveda | `removeVaultDir` (8.5.1): identidad por `vault.json`, lista blanca de entradas, sin seguir enlaces | Es la única función con borrado recursivo de bóvedas; `vault.path` no está autenticado. Test de 8.5.1 |
| Importar no destruye datos fuera del archivo importado | `secure-delete.ts`: comprobación sobre el descriptor, sin sobrescribir con `nlink > 1` (12.4, pasos 8–9) | Test con `fs.link`: tras importar, el segundo nombre conserva su hash |
| Las operaciones de la bóveda requieren desbloqueo | `ipc/register.ts` (`requiresUnlock`) y el protocolo (423) | Punto único de control. Test por canal en estado bloqueado |
| (DEK, nonce) únicos | `object-writer` genera la DEK; `object-store` no reabre objetos para escribir | Encapsulado en crypto. Test: dos escrituras del mismo contenido producen DEK y ciphertext distintos |
| Contenido único en la bóveda | `UNIQUE(content_hmac)` en la DB | Es atómico frente a carreras |
| Integridad de las referencias | `FOREIGN KEY … ON DELETE CASCADE` y `foreign_keys=ON` | La DB es la fuente de verdad |
| Un solo escritor | `requestSingleInstanceLock`, llamado después de `app.setPath('userData', …)` (5.2, pasos 3–4) | E2E de F1 con dos instancias (misma raíz: la segunda sale; raíces distintas: arrancan las dos) |
| El bloqueo crea un proceso de renderer nuevo | `replaceMainWindow()` (13.3) | E2E de F1 con `getOSProcessId()`; plan B con `--disable-features` |
| Las rutas de importación vienen del usuario | `importDropped` en el preload y diálogos en main; main valida (12.3) | El renderer no puede construir rutas |
| Los logs no tienen contenido | API tipada de `log.ts` | Comprobación de tipos |
| Los temas no bifurcan funcionalidad | Shells con el mismo `NavModel`; pantallas compartidas | E2E de F6: el mismo recorrido funcional en los 5 temas |

---

## 23. Testabilidad

### 23.1 Unitarios e integración (Vitest, Node del sistema)

Los módulos nativos se cargan directamente porque son N-API. Los módulos de main reciben las rutas por parámetro (inyección) y los tests usan directorios temporales en `tests/.tmp/`.

| Área | Casos |
|---|---|
| crypto | Ida y vuelta con P ∈ {0, 1, 65535, 65536, 65537, 3·65536, 1 MiB+123}; contraseña incorrecta; descifrar con un tag de 12 bytes falla (`authTagLength: 16`, 6); cambiar un bit de cada campo de la cabecera, de un ciphertext y de un tag; reordenar chunks; truncar (quitar el último chunk, cortar a mitad de chunk, dejar solo la cabecera); extender (+1 byte, +un chunk copiado); intercambiar `fileId`; 200 rangos aleatorios más los bordes de chunk comparados con el plaintext; ejemplo de 7.6 con los valores fijos; vector de nonce; wrap/unwrap de la MK; etiquetas HKDF distintas; el cambio de contraseña conserva la MK y la antigua deja de funcionar; `zeroize` deja todo a cero. Argon2 con parámetros pequeños (8 MiB, t=1) salvo un test "lento" con los de producción |
| DB | Apertura cifrada, clave incorrecta, sin plaintext en el archivo (9.1), migraciones, consultas de `media-repo` (filtros, orden, búsqueda con pliegue de acentos, orden natural por nombre) |
| seguridad y perfiles | `node-egress-guard` (5.4); `removeVaultDir` con carpetas ajenas, enlaces y junctions (8.5.1); creación de perfil con fallo inyectado en cada paso y limpieza de `*.creating` (14.4); medición de memoria de Argon2 en el test lento (6.1) |
| sesión y trabajos | secuencia de bloqueo (13.3: claves a cero antes de devolver con `suspend`, espera ≤ 2 s con `manual`, `KeylessCleanup` tras el bloqueo), `JobRegistry` (reglas de `BUSY` de 12.11), motivos de pausa del auto-bloqueo (D12, D18, `maintenance`), `startup-checks` (5.2), agrupación de `library:changed` (10.2) |
| import | `sniff` (firmas, HEIC/RAW/BMP rechazados también dentro de carpetas, `mif1`/`msf1`/`miaf` con sus compatible brands, contenedor sin pista de vídeo), `walk` (omite enlaces simbólicos), `naming` (12.4.1), `capture-date` con `TZ=Europe/Madrid` (12.8), avatar con foto (límites y formatos de 14.4), duplicado `pending` → `skipped` y `UNIQUE` en el paso 5 (12.7, 12.11), reimportar un MKV remultiplexado → `duplicates` (12.5), reconciliación de un `.part` que no verifica y de la miniatura `.part` (12.6), restauración de `import.replace.*` con el HMAC en minúsculas (12.7), pipeline con fixtures, fallos inyectados en cada paso (incluido un fallo entre los dos renombrados del paso 6), cambio del original entre escaneo y proceso, duplicados, sustitución de un duplicado dañado con caída entre A y B (12.7), confirmación de conversiones (12.5.1), reconciliación (incluida la carrera del barrido con `inFlight`), `secure-delete` (con `fs.link`: el otro nombre conserva su hash), `no-temp-leak` (12.4), `linux-thumbnails` (vector MD5 del spec + vectores de GLib, 12.9), `linux-recent` (12.9.1) |
| música | firmas y MIME (8.6.1), límites, título, reconciliación, `music:delete` limpia `kv` |
| protocolo y loopback | `range.ts` (todas las formas, `P = 0`, `bytes=-0`, `bytes=-n` con `n > P`, `HEAD` con Range, 416), handler con requests simulados (incluido 503 `BUSY` en `maintenance`), loopback (token, Host, Range) |
| DB (consultas y escritura) | orden total de 9.2 (empates, `NULL` de duración al final en los dos sentidos), `playlists:setPresentation` y `presentation:getConfig` (10.2), fusión idéntica repetida (18.6) |
| shared y renderer puro | `foldEdits` (propiedades: 4 giros = identidad, `flipH`² = identidad, `flipV` = `rotate 2` + `flipH`, composición de recortes), render de ediciones con sharp (píxeles), `scheduler` (reloj falso), `audioPlan`, `fadeTo` con `AudioParam` falso (17.8), `transitions`, controlador de deriva del vídeo dual, contraste de temas, reductor de selección (Ctrl/Shift/Ctrl+A), `zoom-math` |

### 23.2 E2E (Playwright `_electron` contra `out/`)

- **Aislamiento**: `GALERIA_DATA_DIR` con un directorio temporal por test.
- **KDF rápido**: `GALERIA_TEST_FAST_KDF=1` solo se respeta con `!app.isPackaged`. Usa Argon2 de 8 MiB, t=1, p=1 y registra un `warn`. Nunca se aplica a builds empaquetados.
- **Diálogos nativos**: se simulan con `electronApp.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, paths)`.
- **Estado para los tests**: solo en desarrollo, la raíz de la presentación expone atributos `data-slide-index`, `data-phase` y `data-music-gain` para comprobar el bucle y los modos de audio. Con `GALERIA_E2E=1` (y `!app.isPackaged`), main expone `globalThis.__galeriaNetBlocked` (5.4) y `globalThis.__galeriaLastZeroizeMs` (13.3). Ninguno de los dos contiene datos de la bóveda.
- **Bloqueo y ventana nueva**: como bloquear sustituye la ventana (13.3), los tests esperan la nueva con `electronApp.waitForEvent('window')` y siguen con ella; el helper `tests/e2e/helpers/launch.ts` ofrece `lockAndGetNewWindow()`.
- **Fixtures**: los genera `tests/fixtures/generate.mjs` (F2):
  - imágenes con sharp (JPEG con EXIF `DateTimeOriginal` y un marcador de texto, PNG, WebP, GIF, AVIF); un BMP de 24 bits escrito a mano, solo para comprobar que se rechaza con `UNSUPPORTED_FORMAT` y que su original queda intacto;
  - vídeos con el ffmpeg empaquetado (`testsrc2` + `sine`): MP4 VP9/Opus, WebM, MKV VP9 + Opus y MKV VP9 + FLAC (remultiplexar, 12.5), MOV mpeg4 (convertir) y un MP4 de ≥ 1 GiB (`-stream_loop -1 -c copy -fs 1G`) para la prueba de bloqueo durante la importación (13.3).
  - Los fixtures H.264 solo se generan si hay un codificador H.264 disponible; si no, esos tests se marcan `skip`.
  - Nunca se usan fotos reales.
- **Recorridos por fase** (el detalle está en PLAN):
  - smoke (scaffold);
  - perfiles y bloqueo (F1), incluidos el proceso de renderer nuevo tras bloquear (13.3) y las dos instancias con raíces iguales y distintas (5.2);
  - importar, ver la galería y comprobar que se borró el original y que no queda plaintext (F2);
  - visor, editor y reproductor (F3);
  - presentación (F4);
  - fusión (F5);
  - capturas por tema (F6);
  - todo lo anterior otra vez en F7.

---

## 24. Riesgos y límites

### 24.1 Riesgos técnicos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | La ruta de usuario y la del proyecto tienen un carácter no ASCII ("á") y node-gyp y algunas herramientas fallan con eso | Los tres módulos nativos son N-API precompilados, así que no se compila nada (2.1). El spike del scaffold verifica que cargan dentro de Electron. `userData` y la raíz de datos usan carpetas ASCII. Si electron-builder o NSIS fallan con la ruta: `subst G: "c:\Users\AlbertoVázquezAguila\Documents\Galeria_App"`, compilar desde `G:\` y fijar `ELECTRON_BUILDER_CACHE=C:\ebcache`. El "mojibake" de la consola de npm (`V├ízquez`) es solo de visualización |
| R2 | Los binarios nativos de Linux solo se instalan en Linux | Construir en WSL2 o CI (20.3, D11) |
| R3 | El AppImage no arranca en Ubuntu 24.04+ (AppArmor y user namespaces) | Recomendar el .deb y documentar el perfil AppArmor (20.3) |
| R4 | Duración y búsqueda del MP4 fragmentado en Chromium | Verificación obligatoria en F2/F5 (18.4) |
| R5 | `db.key(Buffer)` no acepta la clave cruda `x'…'` | Test en F1 y plan B con PRAGMA (9.1) |
| R6 | Las importaciones grandes cargan el hilo de main | Medición en F2; plan B con `utilityProcess` (3) |
| R7 | Electron 45 acaba de salir; nos quedamos en 44 | Electron mantiene las 3 últimas versiones mayores; reevaluar en F7 (D13) |
| R8 | Ventana sin marco: sin el menú de snap layouts de Windows 11; posibles rarezas de redimensionado en Wayland | Se acepta; verificación en F7 |
| R9 | BtbN borra los autobuilds (binarios y la referencia al código fuente LGPL) | Caché local de binarios y de los dos paquetes de código fuente con SHA-256 en el manifiesto, y `GALERIA_FFMPEG_ARCHIVE_DIR` (19.2, 19.3) |
| R10 | Codificar VP9 es lento (conversiones y fusiones largas) | `-cpu-used 5 -row-mt 1`, progreso y cancelación |
| R11 | Binarios sin firmar (SmartScreen) | Fuera de alcance; documentado |
| R12 | El Node de la máquina (26.10.0) no es LTS | Cumple todos los `engines`; recomendado actualizar el parche o usar 24 LTS |
| R13 | Bibliotecas de más de 100 000 elementos: `media:list` devuelve todo de una vez | Aceptable hasta 100 000 (unos 12 MB por structured clone); por encima, paginación futura |
| R14 | Decodificación AVIF en el prebuilt de sharp | Test con fixture AVIF en F2 |
| R15 | Playwright no puede probar el binario empaquetado con fuses | Lista de comprobación manual en F7 (20.2) |
| R16 | libvips descomprime a un temporal del sistema con imágenes grandes y acceso aleatorio | `VIPS_DISC_THRESHOLD=4g` antes de cargar sharp, carga perezosa y test `no-temp-leak` en Windows y Linux (12.4). No se reprodujo en Windows con sharp 0.35.5 |
| R17 | `webRequest` podría no interceptar `electron.net.fetch` | El E2E lo distingue con el contador; si falla, el guard de Node también sustituye `net.fetch`/`net.request` (5.4, punto 10) |
| R18 | La regla de escape de `g_filename_to_uri` difiere en algún carácter de la implementada | Vectores generados con GLib en F2/F7 (12.9) |
| R19 | WebRTC: que `disable_non_proxied_udp` + el proxy inexistente con `<-loopback>` no cierren del todo el TCP/UDP de ICE (comportamiento de Chromium no ejecutado todavía) | E2E del scaffold con TURN/TCP y STUN/UDP contra servidores del test (5.4, verificación 5); si recibe algo, se reabre el punto |
| R20 | Chromium reutiliza el proceso del renderer antiguo para la ventana nueva del bloqueo | E2E de F1 con `getOSProcessId()`; plan B `--disable-features=ProcessPerSiteUpToMainFrameThreshold` (13.3) |
| R21 | El muxer MP4 de FFmpeg 8.1 exige `-strict experimental` para copiar Opus o FLAC | Fixtures de F2; si ocurre, ese audio se recodifica a Opus con confirmación (12.5) |

### 24.2 Límites documentados (aparecen literalmente en la Ayuda)

1. **El borrado de los originales no es forense.** En SSD (wear leveling, TRIM), NTFS y ext4 (journaling), y con instantáneas o copias del sistema (Historial de archivos, Timeshift, snapshots de Btrfs/ZFS, carpetas sincronizadas con OneDrive u otros servicios, incluida Descargas), pueden quedar copias recuperables. Si el archivo importado tenía otros nombres (enlaces duros), Galería solo quita el nombre importado y no sobrescribe el contenido, porque destruiría también esos otros nombres: el contenido sigue en el disco bajo ellos. Galería sobrescribe y borra lo mejor que puede, pero no lo garantiza. **Recomendación: cifra el disco con BitLocker (Windows) o LUKS (Linux).**
2. **Windows guarda miniaturas en `thumbcache` y no se pueden borrar archivo a archivo.** En Linux, Galería borra las miniaturas freedesktop (`~/.cache/thumbnails`) y quita los archivos importados de la lista de recientes de GTK (`~/.local/share/recently-used.xbel`), pero otros visores y escritorios pueden tener cachés e historiales propios. Windows también puede guardar el nombre o la carpeta del original en "Archivos recientes", "Acceso rápido", las jump lists y el historial de los diálogos de abrir archivo (`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSavePidlMRU` y `LastVisitedPidlMRU`). Galería pide a Windows que no añada los archivos elegidos a "Recientes", pero no puede limpiar ese historial del registro.
3. **Mientras la bóveda está desbloqueada, los datos descifrados están en la RAM** y el sistema puede moverlos al archivo de paginación, al swap o al archivo de hibernación. Si Galería o el sistema fallan, un volcado de memoria (Informe de errores de Windows con `LocalDumps` en `%LOCALAPPDATA%\CrashDumps`, `systemd-coredump` o `apport` en Linux) puede guardar en disco parte de esos datos y de las claves. El cifrado de disco también mitiga esto. Bloquea Galería cuando no la uses.
4. **Lo que puede ver alguien con acceso a los archivos:** cuántos archivos hay en cada bóveda y su tamaño aproximado, sus fechas de modificación, la lista de perfiles (nombres y avatares), la música, los ajustes y los avatares personalizados. No puede ver las fotos, los vídeos, los nombres, las fechas de captura, el EXIF, las playlists ni las ediciones.
5. **No hay protección contra malware activo, keyloggers ni capturas de pantalla** en tu sesión. En Windows, mientras la bóveda está abierta, Galería pide al sistema que excluya su ventana de las capturas, las grabaciones y Recall (Ajustes → Seguridad), pero un programa malicioso con acceso a tu sesión puede saltarse eso. En Linux esa protección no existe.
6. **No hay recuperación de contraseña ni exportación.** Si olvidas la contraseña, el contenido no se puede descifrar nunca.
7. **Cambiar la contraseña no invalida las copias antiguas** de `profiles.json`: con una copia antigua y la contraseña antigua se sigue pudiendo abrir la bóveda (6.6). **Restaurar copias antiguas de la base de datos o de `profiles.json`** (por ejemplo, desde una copia de seguridad) revierte su contenido (nombres, playlists, ediciones) sin aviso.
8. **Galería no hace copias de seguridad.** Si el disco se pierde o se estropea, el contenido se pierde.
9. **Algunos vídeos se procesan al importarlos.** Los MKV, AVI y MOV con códecs compatibles se pasan a MP4 sin pérdida de calidad; los que tienen códecs poco comunes se convierten con pérdida de calidad, previa confirmación. En los dos casos el original se borra después.
10. **El bloqueo por inactividad se pausa** mientras se reproduce un vídeo o una presentación y mientras hay una importación o una fusión de vídeos en curso. Suspender el equipo, bloquear la sesión del sistema o pulsar "Bloquear" bloquean igualmente y cancelan lo que esté en curso.
11. **En Linux, detectar el bloqueo de pantalla del sistema depende del escritorio.** La suspensión y la inactividad sí bloquean siempre.
12. **Como hecho, no como función:** quien tenga acceso de administrador al sistema puede borrar a mano la carpeta de una bóveda. Galería no ofrece ninguna forma de borrar un perfil sin su contraseña.
13. **Si arrastras o copias contenido fuera de Galería** (por ejemplo, una foto al escritorio o a otra app, o un nombre con Ctrl+C), esa copia queda fuera de la bóveda y sin cifrar. El texto copiado también puede quedar en el historial del portapapeles de Windows (Win+V) y, si tienes activada su sincronización, en otros dispositivos. Galería no lo impide porque es una acción tuya con la sesión iniciada.

---

## 25. Puntos de decisión para el usuario

| # | Decisión | Opciones | Recomendación (lo que implementa este diseño) | Motivo |
|---|---|---|---|---|
| D1 | Borrar un perfil cuya contraseña se ha olvidado | — | **CERRADA por el usuario (anexo, punto 1):** siempre se exige la contraseña; la app nunca ofrece otra vía | – |
| D2 | Avatares con foto propia | (a) solo los integrados; (b) también foto, con aviso de que no se cifra | **(b)**: 12 avatares integrados por defecto y foto opcional con aviso explícito; la foto se recorta a 256 px sin metadatos | Personalización sin engañar sobre la privacidad |
| D3 | Carpeta de música | (a) por perfil; (b) compartida | **(a) por perfil**, dentro de la bóveda (8.6) | Se mueve y se borra con la bóveda y no revela nada a otros perfiles |
| D4 | Build de ffmpeg y licencia | GPL (ffmpeg-static/BtbN GPL) con H.264, o LGPL sin codificador H.264 | **BtbN LGPL compartido 8.1.3** (19) | Distribución sin obligaciones GPL; H.264 no hace falta porque no hay exportación |
| D5 | Contenedor y códec del vídeo fusionado (y de las conversiones) | MP4 fragmentado / WebM / MKV; H.264 / VP9 / AV1 | **MP4 fragmentado con VP9 + Opus** (18.4) | Se puede escribir por tubería con índice; códecs libres que Chromium decodifica |
| D6 | Parámetros de Argon2id | Fijos o calibrados | **Calibrados por máquina**: objetivo 256 MiB / t=3 / p=4, tope de 1,5 s, suelo de 64 MiB / t=3 (6.1). Medido: los 256 MiB son memoria total (no por hilo); en esta máquina la calibración elige t=8, unos 0,68 s por desbloqueo | Máxima resistencia offline sin hacer el desbloqueo inusable en equipos lentos |
| D7 | Importar un duplicado | (a) borrar el original tras verificar la copia que ya existe; (b) conservar el original | **(a)** (12.7) | "Importar = mover a la bóveda"; el contenido ya está a salvo y verificado |
| D8 | Vídeos que hay que convertir (con pérdida) | (a) convertir y borrar el original, con confirmación previa; (b) conservar el original de los convertidos | **(a)**, con la confirmación de 12.5.1: "Convertir y borrar originales", "Omitir esos vídeos" (foco inicial) o "Cancelar importación" | Cumple el requisito de borrar al importar; la confirmación deja que el usuario omita esos vídeos o cancele antes de tocar nada |
| D9 | Selector de perfiles por tema | Una estructura con variantes visuales, o diseños distintos por tema | **Misma estructura, orden del DOM y teclado; cambia solo la presentación** (15.10) | Coherencia y accesibilidad; menos código |
| D10 | Nombres visibles de los temas | Nombres de las marcas o neutros | **Neutros**: Clásico, Mosaico, Ondas, Cristal, Álbum (ids internos sin cambios) | Evita problemas de marca si algún día se distribuye |
| D11 | Dónde compilar los paquetes de Linux | WSL2 local, máquina Linux o GitHub Actions | **WSL2 (Ubuntu 24.04) en esta máquina**; CI como alternativa | Local, sin subir el código a la nube |
| D12 | Bloqueo por inactividad durante la reproducción | Pausarlo o bloquear igualmente | **Pausarlo** mientras se reproduce un vídeo o una presentación | Evita cortar una presentación; el bloqueo al suspender o bloquear el SO sigue activo |
| D13 | Versión de Electron | 44.9.3 (madura) o 45.0.0 (salió el 21-oct-2026) | **44.9.3**, reevaluar en F7 | Estabilidad; los dos usan Node 24 |
| D14 | Editar el nombre o el avatar de un perfil | Con o sin contraseña | **Con contraseña** | Privacidad primero: nadie puede renombrar o cambiar el avatar de otro perfil desde la app |
| D15 | Excluir la ventana de capturas de pantalla y de Recall (`win.setContentProtection(true)`) mientras la bóveda está desbloqueada | (a) activado por defecto, con interruptor en Ajustes → Seguridad; (b) desactivado por defecto; (c) no ofrecerlo | **(a)** (5.2, 14.9) | Privacidad primero. Contrapartida: con la protección activa, el usuario tampoco puede hacer capturas de Galería ni compartir su ventana. Solo tiene efecto en Windows |
| D16 | Qué significa "silenciar todo" en la presentación | (a) `mute` = silencio durante los vídeos; la música sigue en las fotos y para silencio total se desactiva la música (`musicEnabled = false`); (b) un quinto modo `silence` que también silencia la música en las fotos | **(a)** (17.2) | Mantiene un único eje "qué suena en los vídeos" más el interruptor de música; la UI muestra las dos piezas juntas para que el silencio total esté a un clic |
| D17 | Dependencias añadidas al stack aprobado | Añadirlas o implementar cada pieza a mano | **Añadirlas**, con versión exacta: `zod` (validación de los payloads IPC, los JSON de disco y la salida de ffprobe), `@dnd-kit/core` + `@dnd-kit/sortable` (reordenar playlists con teclado accesible, que Motion `Reorder` no ofrece), `lucide-react` (iconos propios con licencia ISC, sin iconos de Microsoft, Sony ni Apple) y `@fontsource-variable/{inter, noto-sans, nunito, fraunces, caveat}` (fuentes OFL locales que exige el anexo) | Ninguna tiene red ni código nativo; todas evitan reescribir piezas delicadas (validación, accesibilidad del arrastre) |
| D18 | Bloqueo por inactividad con trabajos largos en curso | (a) pausar el temporizador mientras haya una fusión o una importación en curso (salvo en `awaiting-confirmation`); la suspensión, el bloqueo del SO y el bloqueo manual siguen bloqueando al momento y cancelan el trabajo; (b) bloquear y cancelar igualmente | **(a)** (12.11, 13.2). **Fusiones: CONFIRMADO por el usuario. Importaciones: recomendada, pendiente de confirmar** (anexo, punto 3) | Una fusión VP9 de 20 minutos o una importación de 10 000 archivos sin tocar el ratón no se cancelan a los 5 minutos; el panel de progreso sigue visible |
| D19 | Formatos de foto | Con o sin BMP | **CERRADA por el usuario (anexo, punto 3):** sin BMP. Se admiten JPG, PNG, WebP, GIF y AVIF; BMP se rechaza con `UNSUPPORTED_FORMAT` y su original no se toca | – |
| D20 | Arrastrar o copiar contenido fuera de la ventana con la sesión iniciada | Bloquearlo o permitirlo | **CERRADA por el usuario (anexo, punto 3):** se permite; es una acción deliberada del propietario, fuera del modelo de amenazas. Solo se documenta (límite 13 de 24.2) | – |

---

## 26. Notas para el plan y el scaffold

### 26.1 Fases (la numeración que usa este documento)

| Fase | Contenido |
|---|---|
| F1 | Base del proyecto, núcleo criptográfico con tests exhaustivos (7, 6), perfiles (crear, desbloquear, bloquear, cambiar contraseña, editar y borrar con contraseña), selector estilo Netflix, auto-bloqueo, ventana sin marco con barra de título, **arquitectura de temas + `fotos` + stub de `ps3`** (15.13) |
| F2 | ffmpeg (`fetch-ffmpeg`), importación segura, rejilla, búsqueda, filtros, orden, selección, renombrar, borrar, reconciliación, cambio de ubicación de la bóveda, Ayuda y límites |
| F3 | Visor, edición (recortar, voltear, girar) y reproductor de vídeo |
| F4 | Playlists, música y presentación (transiciones, música, modos de audio, bucle, ventana o pantalla completa) |
| F5 | Vídeo dual y fusión |
| F6 | **Temas**: completar `xbox`, `ps3`, `macos` y `album` en todas las pantallas, con capturas de Playwright por tema |
| F7 | Instaladores (NSIS; AppImage y .deb en Linux), fuses, licencias y E2E completos |

Se respeta el orden del brief (1–6 pasan a ser F1–F5 y F7), con la fase de temas del anexo insertada justo antes de los instaladores. El planner puede refinar el contenido, pero no el orden.

### 26.2 Lo que debe hacer el scaffold

1. **Prerrequisitos**: `node -v`, `npm.cmd -v` y `git --version`. Ya están comprobados en `.agents/tasks/env.md`: Node 26.10.0, npm 11.19.1 y git 2.55.0. El repo ya tiene `git init`.
   - **Instrucción del usuario (22-oct-2026)**: todas las librerías las instala el agente, sin pedírselo al usuario. Eso incluye Electron, Tailwind y el resto de paquetes de la sección 2 (`npm.cmd install` con las versiones exactas), y en F2 los binarios de ffmpeg (`npm.cmd run fetch:ffmpeg`). Solo se pausa para pedir algo al usuario si falta una herramienta del sistema (Node o git), que hoy ya están instaladas. Visual Studio Build Tools no hace falta, porque los módulos nativos traen binarios precompilados (2.1).
2. **`package.json`**:
   - versiones exactas de la sección 2 y los scripts de 4;
   - corregir `engines` a `"^24.0.0 || >=26.0.0"`;
   - `"productName": "Galería"`, `"main": "out/main/index.js"`, sin `"type"`.
3. **`.gitignore`**: `node_modules/`, `out/`, `dist/`, `release/`, `coverage/`, `.cache/`, `resources/ffmpeg/*-x64/`, `test-results/`, `playwright-report/`, `tests/.tmp/`, `*.log`, `.env*` y `GaleriaData/` (datos de prueba).
4. **`.editorconfig`**: UTF-8, LF, 2 espacios, línea final.
5. **Estructura de 4** y archivos [S].
6. **Seguridad**:
   - `BrowserWindow` de 5.2, pero con `frame: true` (la barra de título propia llega en F1), sin `setContentProtection` (llega en F1 con el desbloqueo) y sin la sustitución de ventana al bloquear (F1);
   - `app://bundle` en producción;
   - CSP de 5.3 (la de desarrollo con `ws://127.0.0.1:5173`), guard de red con contador por esquema y guard de navegación de 5.4, `will-download` cancelado (5.4, punto 1), `installNodeEgressGuard()` como primera sentencia de `index.ts`, `host-resolver-rules` con el `EXCLUDE` de desarrollo y `password-store=basic` en Linux (5.2), single instance, `enableSandbox`, **en el orden exacto de los pasos 1–7 de 5.2** (con `forbiddenDebugSwitch` en el paso 2 y `setPath('userData')` antes de `requestSingleInstanceLock`);
   - WebRTC (5.4, punto 5): `src/renderer/src/lockdown.ts` como primer import de `main.tsx`, `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` en `web-contents-created` y `await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: devUrl ? '' : '<-loopback>' })` en las sesiones antes de crear la ventana;
   - `src/shared/errors.ts` completo y `src/main/ipc/register.ts` en su versión mínima (5.6), usado por `ipc/handlers/app.ts` para `app:getInfo` (con `ffmpegAvailable: false`);
   - `electron.vite.config.ts` con `renderer.server = { host: '127.0.0.1', port: 5173, strictPort: true }` (4).
7. **Placeholder**: fondo `#1b1b1f` y `<h1>Galería</h1>` centrado, sin funciones. **Icono**: `scripts/make-icon.mjs` usa `sharp` (`sharp({ create: { width: 512, height: 512, channels: 4, background: '#1b1b1f' } }).png()`) para escribir `resources/build/icon.png`; se ejecuta una vez con `npm.cmd run make:icon` y el PNG se versiona. `icon.ico` y los iconos definitivos llegan en F7. La restricción de ESLint sobre `sharp` (12.4) solo aplica a `src/`, así que el script puede importarlo.
8. **Tailwind v4**: `@tailwindcss/vite` + `styles/base.css` con `@import "tailwindcss";`.
9. **ESLint**: configuración plana con `@eslint/js`, `typescript-eslint` (recommended), react-hooks, react-refresh (renderer), jsx-a11y (renderer), `eslint-config-prettier` y las reglas de 5.4: `no-restricted-imports` (módulos de red de Node con sus excepciones, `net` de `electron`, `child_process` salvo en `media/ffmpeg.ts`, y `sharp` salvo en `media/sharp-loader.ts`, con la variante `@typescript-eslint/no-restricted-imports` y `allowTypeImports: true` para `sharp`), `no-restricted-syntax` (`ImportExpression` de `sharp` fuera de `sharp-loader.ts`, 12.4), `no-restricted-globals` (`fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` en main y preload; `RTCPeerConnection` y `webkitRTCPeerConnection` en el renderer), `no-restricted-properties` (`shell.openExternal`, `shell.openPath`; `onBeforeRequest` salvo en `security/network-guard.ts` y `onHeadersReceived` salvo en `security/csp.ts`, sin `object`, 5.4 punto 1) y `no-restricted-syntax` para funciones `async` pasadas a `.transaction(...)` en `src/main/**` (13.3).
10. **Prettier**: `prettier-plugin-tailwindcss`, `singleQuote: true`, `printWidth: 100`, `trailingComma: "all"`.
11. **Tests**:
    - `tests/unit/smoke.test.ts`, trivial;
    - `tests/unit/main/node-egress-guard.test.ts` (5.4, "Verificación");
    - `tests/unit/main/startup-checks.test.ts` (5.2, paso 2): sin empaquetar nunca devuelve un switch; empaquetado devuelve el primero de `FORBIDDEN_SWITCHES` presente y `null` sin ninguno;
    - `tests/e2e/smoke.spec.ts` con `GALERIA_E2E=1`: la ventana se abre y muestra "Galería"; y los cinco puntos de la verificación de 5.4 (renderer por CSP; `loadURL` de una ventana oculta con `ERR_BLOCKED_BY_CLIENT` y contador `http ≥ 1`; `electron.net.fetch`; `fetch`, `net.connect` y `dns.lookup` de Node con `EGALERIA_NET`; WebRTC sin constructores en el renderer y sin tráfico TCP ni UDP desde un `<iframe>`), siempre con 0 conexiones y 0 datagramas en los servidores del test. Si el punto 3 muestra que `webRequest` no intercepta `net.fetch`, se aplica la variante de 5.4, punto 10, y se anota en `docs/PLAN.md`.
12. **Spike nativo** (`scripts/native-spike.cjs`, con `npm.cmd run spike:native`):
    - dentro del main de Electron, `@node-rs/argon2.hashRaw` (8 MiB, t=1);
    - `better-sqlite3-multiple-ciphers`: crear una DB cifrada (`cipher='sqlcipher'`, `legacy=4`, `db.key(x'…')`) en un directorio temporal, insertar, cerrar, reabrir bien, reabrir con una clave incorrecta (tiene que fallar) y comprobar que la cabecera no es `SQLite format 3`;
    - `sharp`: generar un PNG de 64×64 en memoria → WebP;
    - imprimir un JSON `{ argon2, sqlcipher, sharp }` con `ok` o el error, y salir con código 0 o 1.
    - Los resultados y cualquier fallo, con su solución propuesta, se anotan en `docs/PLAN.md`. No se bloquea el run.
13. **Verificación final**: `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run build` y `npm.cmd run test:e2e`, todos en verde. No ejecutar `npm run dev`.
14. **No hacer commits.**

El `PLAN.md` de la raíz, creado en el setup, queda obsoleto por la nota de 2.5 (N-API). El planner decide si lo funde en `docs/PLAN.md` y lo elimina.

---

## 27. Historial de revisiones

### Versión 2 (22-oct-2026): respuesta a la revisión 1

Revisión: `.agents/tasks/design-review.md` (veredicto `CHANGES_REQUESTED`, 1 HIGH, 11 MEDIUM, 14 LOW). Se resuelven los 26 hallazgos dentro del diseño; ninguno se pospone ni se ignora. Comprobaciones hechas para esta versión, en un directorio temporal fuera del repo que se borró después: tipos de `electron@44.9.3` (`dontAddToRecent`, `setContentProtection`), código de `electron-vite@6.0.0` (`ELECTRON_RENDERER_URL` y `resolveHostname`), memoria y tiempo de `@node-rs/argon2@2.2.2`, y temporales de `sharp@0.35.5`.

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| 1 | HIGH | libvips puede descomprimir a `%TEMP%`/`$TMPDIR` | **Resuelto.** `media/sharp-loader.ts` (F1) fija `VIPS_DISC_THRESHOLD=4g` y carga sharp de forma perezosa (Rollup coloca los `require` externos al principio del bundle, así que un módulo de efectos laterales no bastaría), `sharp.cache(false)`, `{ sequentialRead: true, limitInputPixels }` explícitos, reglas ESLint para que nadie más cargue sharp, test `no-temp-leak` obligatorio en Windows y Linux, fila en 22 y R16 (12.4, 8.8, 16.3, 16.5, 22). Observado: en Windows con sharp 0.35.5 no se creó ningún temporal ni con umbral de 1 MiB; el umbral se fija igualmente |
| 2 | MEDIUM | `host-resolver-rules` rompe el desarrollo y el E2E no aísla el guard | **Resuelto.** `EXCLUDE <host de desarrollo>` solo sin empaquetar; origen de desarrollo fijo `http://127.0.0.1:5173` (`strictPort`), comprobado en el código de electron-vite; CSP de desarrollo actualizada; contador por esquema expuesto solo con `GALERIA_E2E=1`; el E2E usa `loadURL` de una ventana oculta y exige `ERR_BLOCKED_BY_CLIENT` + contador ≥ 1 + 0 conexiones (4, 5.2, 5.3, 5.4, 26.2) |
| 3 | MEDIUM | Salidas de red de Node en main solo cubiertas con lint | **Resuelto.** `security/node-egress-guard.ts` [S] en tiempo de ejecución (`fetch`, `WebSocket`, `EventSource`, `net.Socket#connect` salvo pipes locales, `dgram`, `dns.*` incluido c-ares), falla cerrado; ESLint ampliado (`no-restricted-globals`, `net` de electron, `child_process` solo en `ffmpeg.ts`); `electron.net` cubierto por webRequest con comprobación en el E2E y variante prevista si no lo intercepta; unitario del guard (5.4, 19.4, 22, 26.2, R17) |
| 4 | MEDIUM | Sobrescribir un original con enlaces duros | **Resuelto.** La comprobación del original se hace con `fstat` sobre el descriptor abierto; con `nlink > 1` solo `unlink`; límite 1 de la Ayuda ampliado; test con `fs.link` (12.4 pasos 8–9, 12.10, 22, 24.2) |
| 5 | MEDIUM | Borrado recursivo de una ruta no autenticada | **Resuelto.** Semántica de `vault.path` definida (carpeta que contiene `vault.json`); `removeVaultDir` (8.5.1) con prueba de identidad, lista blanca, sin seguir enlaces, marcador `.galeria-relocate-<jobId>` para `<destino>.partial`; la usan borrado de perfil, creación fallida, traslado y `pendingCleanup`; test con carpetas ajenas (8.2, 8.5.1, 8.7, 14.4, 22) |
| 6 | MEDIUM | Sustituir un duplicado dañado choca con `UNIQUE` y cascadas | **Resuelto.** Secuencia de dos transacciones (liberar el HMAC, insertar, mover ediciones y playlists, borrar la fila antigua); se conservan nombre e `imported_at`; borrado criptográfico tras el `COMMIT` y regeneración de la miniatura si hay ediciones. Mejora sobre la propuesta: la clave `kv` `import.replace.<newId>` guarda el HMAC, así que una caída entre A y B no deja un estado degradado: la reconciliación termina o deshace la sustitución (9.2, 12.6, 12.7) |
| 7 | MEDIUM | Importación de música sin especificar y en contradicción con 8.8 | **Resuelto.** Nueva 8.6.1: firmas → MIME (con las máscaras exactas para distinguir MP3 de AAC ADTS), límites, título, duración con ffprobe, copia a `music/*.part` (no a `tmp/`), respuesta `MusicImportResult` con fallos, reconciliación, `music:delete` limpia `kv`, duplicados permitidos; tabla de fallos en 21.1 (8.6, 8.8, 10.1, 10.2, 10.3, 12.6) |
| 8 | MEDIUM | Traslado de la bóveda: sesión en mantenimiento sin definir | **Resuelto.** Subestado `maintenance` (canales `BUSY` salvo una lista, protocolo 503 `BUSY`, inactividad y vigilante en pausa, diálogo no descartable con "Cancelar"); canal `vault:relocateCancel`; semántica del bloqueo antes y después del paso 6. Mejora: `vault.pendingCleanup` en `profiles.json` hace que el borrado de la bóveda antigua sobreviva a un cierre o una caída (8.2, 8.7, 10.1, 10.2, 11.4, 13.1–13.3, 14.9, 21.1) |
| 9 | MEDIUM | Fundidos de Web Audio que lanzan `NotSupportedError` | **Resuelto.** `fadeTo` con `cancelAndHoldAtTime` + 32 rampas lineales, sin `setValueCurveAtTime`; reglas para el volumen del usuario; test con `AudioParam` falso en Vitest (Node no tiene Web Audio, así que no se usa `OfflineAudioContext`) y comprobación de `pageerror` en el E2E de F4 (17.8, 23.1) |
| 10 | MEDIUM | Falta la secuencia de creación de perfil | **Resuelto.** Flujo de 8 pasos en 14.4 con `vaults/<id>.creating`, punto de confirmación en `profiles.json`, limpieza tras fallo y al arrancar; la calibración ocurre dentro de `profiles:create` (8.1, 14.4, 21.1) |
| 11 | MEDIUM | La confirmación de conversiones (D8) no tiene flujo IPC | **Resuelto.** Preescaneo con `ffprobe` en `scanning`; fase `awaiting-confirmation`; evento `import:confirmNeeded`; canal `import:confirm`; solo cuentan las recodificaciones (no los remultiplexados); sin timeout; bloquear cancela; `AlertDialog` con foco en "Omitir esos vídeos" (10.1, 10.2, 12.3, 12.4, 12.5.1, 14.6, D8) |
| 12 | MEDIUM | Música de las playlists guardada en dos sitios | **Resuelto.** `presentation_json` solo guarda `PresentationPlainSettings`; `playlist_music` es la única fuente de las pistas de una playlist y `kv` la de las pistas por defecto; reglas transaccionales de `setPresentation` (incluido `null`), `saveDefaults` y `getConfig` (9.2, 10.1, 10.2) |
| 13 | LOW | Límites incompletos (volcados, MRU, xbel, Recall) | **Resuelto.** Límites 2, 3 y 5 ampliados; `dontAddToRecent` en todos los diálogos (verificado en los tipos de Electron 44.9.3); limpieza best-effort de `recently-used.xbel` (12.9.1, F2); D15 con `setContentProtection` activado por defecto e interruptor en Ajustes (5.2, 12.1, 14.9, 24.2, 25) |
| 14 | LOW | Tema obsoleto y proceso de renderer reutilizado tras `reload()` | **Resuelto.** Al bloquear se crea una ventana nueva con los argumentos actuales y se destruye la antigua en `ready-to-show`; referencia única `getMainWindow()` para el IPC; ayuda de E2E `lockAndGetNewWindow()` (3, 5.2, 5.6, 6.7, 11.5, 13.3, 15.4, 23.2) |
| 15 | LOW | Casos límite de firma y de ffprobe | **Resuelto.** `sniff` lee hasta 512 bytes; reglas de `mif1`/`msf1`/`miaf` por compatible brands; contenedor sin pista de vídeo = no admitido; demuxer forzado en todas las invocaciones (originales, loopback, BMP, música); dimensiones intercambiadas con rotación ±90° (12.3, 12.4, 12.5, 18.3, 19.4) |
| 16 | LOW | Conjunto sin escapar no verificado contra GLib | **Resuelto.** Regla corregida según la tabla `acceptable` de `gconvert.c` con `UNSAFE_PATH` (`;` sí se escapa); vectores generados con GLib en F2/F7 que mandan sobre la regla; R18 (12.9) |
| 17 | LOW | Precisión del `snapshot` | **Resuelto.** `lstat`/`fstat` con `bigint: true` y `{ dev, ino, size, mtimeNs }`, comparación exacta; se toma en el escaneo y se vuelve a comprobar al empezar el archivo y sobre el descriptor antes de borrar (12.3, 12.4) |
| 18 | LOW | Renombrados parciales, carrera del barrido y orden de la miniatura editada | **Resuelto.** Orden objeto → miniatura y limpieza criptográfica del objeto ya movido; conjunto `inFlight` (`vault/in-flight.ts`) respetado por el barrido, que además vuelve a consultar la DB antes de cada borrado; en 16.5 la miniatura se renombra antes de la transacción; reconciliación de miniaturas ausentes con cola de regeneración por sesión (4, 12.4, 12.6, 16.5, 18.6) |
| 19 | LOW | Interpretación de "silenciar todo" fuera de la tabla de decisiones | **Resuelto.** D16 con las dos opciones y la recomendación; rótulos de la UI que muestran juntos el modo y el interruptor de música (17.2, 25) |
| 20 | LOW | Dependencias añadidas sin fila de decisión | **Resuelto.** D17 con la lista y el motivo de cada una; notas en 2.1 y 2.2 |
| 21 | LOW | Orden de los `NULL` y desempate | **Resuelto.** Tabla de `ORDER BY` total y estable (duración con `NULL` al final en los dos sentidos, desempate por `id`; nombre con desempate `imported_at`, `id`) (9.2, 14.6) |
| 22 | LOW | Precisión de criptografía y Range | **Resuelto.** `authTagLength: 16` explícito al cifrar y descifrar; redacción del KeyRing (copia de MK y DEKs a `Buffer.alloc(32)`, K_* con `Buffer.from(hkdfSync())`); unidades de la calibración con ejemplo; números de `AAD_mk` en decimal ASCII; casos de Range (`P = 0`, `bytes=-0`, `n > P`, `HEAD` con Range, `a > b`) (6, 6.1, 6.2, 6.7, 7.3, 11.2) |
| 23 | LOW | Mínimo de contraseña en caracteres frente a bytes | **Resuelto.** UI: ≥ 8 code points y ≤ 1024 bytes con sus mensajes; main: 8–1024 bytes; documentadas juntas (6.1, 10.3, 14.4) |
| 24 | LOW | Fusión idéntica repetida viola `UNIQUE` | **Resuelto.** Se comprueba el HMAC antes del `INSERT` (y se trata igual un `SQLITE_CONSTRAINT_UNIQUE`); se devuelve el `mediaId` existente con `existed: true` y un toast (10.2, 18.6, 18.7) |
| 25 | LOW | `enableCookieEncryption` y el llavero en Linux | **Resuelto.** `enableCookieEncryption: false` y `--password-store=basic` en Linux; verificación en F7 en GNOME y KDE (5.2, 20.1) |
| 26 | LOW | Memoria real de Argon2 con p=4 sin medir | **Resuelto con medición.** `memoryCost` es la memoria total: +256 MiB de RSS con p=1 y +257 MiB con p=4 (y +129/+65 MiB con 128/64 MiB). Tiempos medidos y parámetros que elegirá la calibración en esta máquina (t=8, unos 0,68 s); el test lento de F1 vigila que no cambie (6.1, D6) |

### Versión 3 (22-oct-2026): respuesta a la revisión 2

Revisión: `.agents/tasks/design-review.md` (versión 2; veredicto `CHANGES_REQUESTED`, 1 HIGH, 5 MEDIUM, 14 LOW). Se revisa el documento sin reescribirlo. Las decisiones del usuario de la **sección 3 del anexo** (`.agents/tasks/requirements-addendum.md`, ruta absoluta `c:\Users\AlbertoVázquezAguila\Documents\Galeria_App\.agents\tasks\requirements-addendum.md`) son vinculantes y resuelven tres hallazgos por decisión del usuario: **1 y 18 quedan descartados** (arrastrar y copiar con la sesión iniciada están fuera del modelo de amenazas) y **4 se resuelve retirando BMP**. Según el anexo, el revisor no debe volver a plantear los hallazgos descartados. El resto se resuelve en el diseño; ninguno se pospone.

Comprobaciones hechas para esta versión, en directorios temporales fuera del repo que se borraron después: `exifr@7.1.3` (documentación y código de `dist`: con `reviveValues: false` las fechas llegan como texto, y `latitude`/`longitude` se calculan igualmente a partir de las etiquetas GPS crudas) y los tipos de `electron@44.9.3` (`setProxy` con `proxyBypassRules`, `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`, `commandLine.hasSwitch`, `getOSProcessId`, evento `will-download` de `Session`). No verificados y cubiertos con tests que reabren el punto si fallan: el efecto real de la política de WebRTC con el proxy inexistente (R19), la reutilización del proceso del renderer (R20), `-strict experimental` para Opus/FLAC en MP4 (R21) y que el lock de instancia única dependa del `userData` vigente (se adopta el orden seguro y un E2E lo comprueba).

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| 1 | HIGH | Arrastrar una imagen o texto fuera de la ventana escribe contenido descifrado en disco | **Descartado por decisión del usuario** (anexo, punto 3): es una acción deliberada del propietario con la sesión iniciada. No se añade `dragstart` lockdown, `-webkit-user-drag`, `draggable={false}`, `user-select: none` ni sus tests. Se documenta en el modelo de amenazas (5.1, 5.7), en el límite 13 de 24.2 y en D20. Como defensa en profundidad de una línea, no requerida, `will-download` se cancela en todas las sesiones (5.4, punto 1) |
| 2 | MEDIUM | Al bloquear, las claves siguen en memoria mientras se espera a los trabajos | **Resuelto.** Nueva secuencia de 13.3: velo inmediato (`session:locking`, más `hide()` con suspensión y bloqueo del SO), `abortAll` síncrono, espera acotada de 0 ms (suspensión, bloqueo del SO, error, bóveda no disponible) o 2 s, `db.close` + `zeroize` + `destroyKeys()` de writers y readers síncronos, y `KeylessCleanup` en segundo plano. Se corrige el traslado (8.7: ya no espera al paso 8; los pasos 5–6 son una unidad sin claves). Invariantes nuevas (ninguna transacción ni iterador abarca un `await`, `getDb()` lanza `LOCKED`, comprobación de `signal.aborted`). Tests con trabajo colgado, traslado y E2E con `suspend` simulado ≤ 200 ms (4, 6.7, 7.7, 8.7, 10.2, 11.5, 12.4, 13.3, 22, 23) |
| 3 | MEDIUM | WebRTC no pasa por `webRequest` ni por la CSP | **Resuelto.** Tres capas: `lockdown.ts` [S] (primer import del renderer) borra los constructores de WebRTC; `disable_non_proxied_udp` en todos los webContents; proxy inexistente `socks5://127.0.0.1:9` en todas las sesiones, con `<-loopback>` en producción y E2E (en desarrollo se mantiene la excepción de loopback para Vite). Se documenta que el borrado no cubre un `<iframe>` `about:blank`, y el E2E lo prueba precisamente desde un iframe con TURN/TCP y STUN/UDP contra servidores del test. ESLint para los globales; fila de 22; R19 (4, 5.1, 5.4, 22, 26.2) |
| 4 | MEDIUM | Las fotos BMP no se pueden editar ni regenerar su miniatura | **Resuelto por decisión del usuario** (anexo, punto 3): BMP se retira de los formatos admitidos y se rechaza con `UNSUPPORTED_FORMAT` (también dentro de carpetas) sin tocar el original. Se eliminan la ruta ffmpeg BMP→PNG, `bmp_pipe` y las filas de BMP; no se añade `toSharpInput`. Se mantienen las reglas del avatar con foto: filtro sin BMP, `lstat`, ≤ 50 MiB, firma con las filas de foto, ≤ 268 MP, `UNSUPPORTED_FORMAT`/`TOO_LARGE` (encabezado, 2.1, 10.2, 10.3, 12.1, 12.3, 12.4, 14.4, 19.4, 23, D19) |
| 5 | MEDIUM | Trabajos largos: concurrencia y auto-bloqueo sin definir | **Resuelto.** Nueva 12.11 con `JobRegistry`: como mucho una importación, una fusión y una importación de música, que pueden coexistir; `BUSY` antes de abrir diálogos; la UI deshabilita "Importar" y "Crear vídeo fusionado"; el traslado exige que no haya ninguno, incluida la música. Duplicados: fila `pending` → `skipped` sin tocar el original, `UNIQUE` en el paso 5 → `skipped`. **D18** con la opción (a): fusiones **confirmadas** por el usuario; importaciones **recomendada, pendiente de confirmar**; suspensión, bloqueo del SO y bloqueo manual siguen bloqueando y cancelan. Límite 10 actualizado (8.6.1, 8.7, 10.2, 12.2, 12.4, 12.5.1, 12.7, 12.11, 13.2, 14.6, 16.5, 18.1, 18.7, 24.2, 25) |
| 6 | MEDIUM | "Convertido" tiene dos significados | **Resuelto.** `converted = 1` si lo almacenado no es byte a byte el original (remultiplexado, recodificado o fusión). "Procesado con ffmpeg" sustituye a "con conversión" en 12.4, y la comprobación de `ffprobe` del paso 3 cubre también los remultiplexados. "Recodificar" queda solo para D8. Tests de F2 con MKV VP9 + Opus y VP9 + FLAC remultiplexados, y reimportación → `duplicates`; regla para `-strict experimental` (R21) (9.2, 10.1, 12.4, 12.5, 12.7, 18.6, 24.2) |
| 7 | LOW | `setPath('userData')` antes de `requestSingleInstanceLock()` | **Resuelto.** Orden explícito en 5.2 (guard → switches de depuración → `setPath` → lock → `enableSandbox` → esquemas → switches). Además, el override de `GALERIA_DATA_DIR` pasa a `<raíz>.electron` para que dos raíces de prueba de la misma carpeta no compartan `userData`; E2E de F1 con dos instancias (5.2, 8.1, 22) |
| 8 | LOW | `webRequest` admite un solo listener por evento y sesión | **Resuelto.** Frase en 5.4 y `no-restricted-properties` sin `object` para `onBeforeRequest` (solo en `network-guard.ts`) y `onHeadersReceived` (solo en `csp.ts`) (4, 5.4, 26.2) |
| 9 | LOW | No verificado que la ventana nueva use un proceso nuevo | **Resuelto.** E2E de F1 con `getOSProcessId()` (PID distinto y el antiguo termina en 5 s); plan B `--disable-features=ProcessPerSiteUpToMainFrameThreshold`; R20 (13.3, 22, 23.2) |
| 10 | LOW | El binario empaquetado acepta `--remote-debugging-port/pipe` | **Resuelto.** `security/startup-checks.ts` [S] sale con código 1 si el binario empaquetado trae alguno de los switches de depuración, antes de crear ninguna ventana; unitario [S] y comprobación manual en F7. Se refleja en el modelo de amenazas (4, 5.1, 5.2, 22) |
| 11 | LOW | Falta la regla de `name` y `original_ext` | **Resuelto.** Nueva 12.4.1 (`import/naming.ts`): último punto, extensión `/^[a-z0-9]{1,16}$/` o la detectada por firma, NFC, sin `\p{Cc}`, `trim`, 255 code points sin partir pares, "Sin nombre"; casos de test (4, 10.3, 12.4) |
| 12 | LOW | Fecha naive de exifr y huecos del cambio de hora | **Resuelto.** `reviveValues: false` (comprobado en exifr 7.1.3), `parseExifDate` con regex y validación de rangos directamente a `Date.UTC`, ceros e inválidos a la siguiente fuente, `mtime`/`creation_time` con los getters locales; tests con `TZ=Europe/Madrid` y la hora inexistente del 29-mar-2026 (4, 12.4, 12.8) |
| 13 | LOW | Reconciliación de un `.part` que no verifica y de la miniatura `.part` | **Resuelto.** Si el `.part` de una fila `pending` no verifica: borrado criptográfico, `DELETE` de la fila y `warn`; la miniatura `.part` que verifica se renombra antes del punto 3, y la que no, se borra y se regenera (12.6) |
| 14 | LOW | `library:changed` durante importaciones grandes | **Resuelto.** `ipc/library-events.ts`: como mucho un evento por segundo y por motivo durante los trabajos, más uno al terminar; debounce de 500 ms en el renderer; test con reloj falso (4, 10.2) |
| 15 | LOW | El HMAC de `import.replace.*` en mayúsculas | **Resuelto.** `lower(hex(:hmac))` en la transacción A, esquema zod en minúsculas en 9.2, restauración enlazando un `Buffer` en lugar de interpolar `x'…'`, y comportamiento definido si el valor no valida (9.2, 12.6, 12.7) |
| 16 | LOW | Texto de Ajustes → Seguridad falso en Linux | **Resuelto.** Texto por plataforma (14.9) |
| 17 | LOW | Restaurar una copia antigua de `library.db` revierte su contenido | **Resuelto.** Documentado en 5.7 ("No protege") y en el límite 7 de 24.2, también para `profiles.json` |
| 18 | LOW | Texto copiado en el historial del portapapeles de Windows | **Descartado por decisión del usuario** (anexo, punto 3): no se añade `user-select: none`. Se documenta en el límite 13 de 24.2, que menciona el historial y la sincronización del portapapeles de Windows |
| 19 | LOW | Detalles del scaffold | **Resuelto.** `ipc/register.ts` [S] en versión mínima (emisor, zod, `Result`) y `shared/errors.ts` [S]; `icon.png` generado con sharp por `scripts/make-icon.mjs` [S] e `icon.ico` en F7; `ffmpegAvailable: false` hasta F2 (4, 5.6, 26.2) |
| 20 | LOW | LGPL: código fuente si BtbN borra el release | **Resuelto.** `fetch-ffmpeg.mjs` guarda en `.cache/ffmpeg/sources/` el snapshot de FFmpeg en el commit exacto del binario (`n8.1.3-23-g5c4f5744cd`, más preciso que el tarball de `n8.1.3`) y los scripts de BtbN del tag fijado, con SHA-256 registrado en la primera descarga; "Acerca de" indica que se entregan bajo petición (14.9, 19.1, 19.2, 19.3, R9) |

